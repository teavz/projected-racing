import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";

const softwareDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const repoRoot = path.resolve(softwareDir, "..");
export const defaultConfigPath = path.join(softwareDir, "config", "default.json");
export const calibrationDir = path.join(softwareDir, "config", "calibrations");

export function resolveRepoPath(relativePath) {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(repoRoot, relativePath);
}

function requireNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new AppError("invalid_config", `${name} must be a finite number in range`, 500, { name, value });
  }
}

function sectorEnds(sectors) {
  if (!sectors || typeof sectors.count !== "number" || !Number.isInteger(sectors.count) || sectors.count < 2) {
    throw new AppError("invalid_config", "sectors.count must be an integer of at least 2", 500);
  }
  if (sectors.boundaries == null) {
    return Array.from({ length: sectors.count - 1 }, (_, index) => (index + 1) / sectors.count);
  }
  if (!Array.isArray(sectors.boundaries) || sectors.boundaries.length !== sectors.count - 1) {
    throw new AppError("invalid_config", "sectors.boundaries must contain count-1 end positions", 500);
  }
  let previous = 0;
  for (const boundary of sectors.boundaries) {
    requireNumber(boundary, "sectors.boundaries", { min: 0, max: 1 });
    if (boundary <= previous || boundary >= 1) {
      throw new AppError("invalid_config", "sector boundaries must be strictly increasing and inside (0, 1)", 500);
    }
    previous = boundary;
  }
  return [...sectors.boundaries];
}

export function validateConfig(raw) {
  if (!raw || raw.schemaVersion !== 1) {
    throw new AppError("invalid_config", "config.schemaVersion must be 1", 500);
  }
  requireNumber(raw.servo.offlineAfterMs, "servo.offlineAfterMs", { min: 1 });
  requireNumber(raw.servo.lockQualityMin, "servo.lockQualityMin", { min: 0, max: 1 });
  requireNumber(raw.servo.maxSampleDelayMs, "servo.maxSampleDelayMs", { min: 0 });
  requireNumber(raw.servo.staleSourceReverseMs, "servo.staleSourceReverseMs", { min: 0 });
  requireNumber(raw.servo.maxBatch, "servo.maxBatch", { min: 1 });
  requireNumber(raw.servo.maxRawBytes, "servo.maxRawBytes", { min: 1 });
  requireNumber(raw.timing.lineHighU, "timing.lineHighU", { min: 0.5, max: 1 });
  requireNumber(raw.timing.lineLowU, "timing.lineLowU", { min: 0, max: 0.5 });
  if (raw.timing.lineHighU <= raw.timing.lineLowU) {
    throw new AppError("invalid_config", "timing.lineHighU must be greater than lineLowU", 500);
  }
  requireNumber(raw.timing.minLapProgress, "timing.minLapProgress", { min: 0.1, max: 1 });
  requireNumber(raw.timing.postCrossLatchProgress, "timing.postCrossLatchProgress", { min: 0, max: 0.5 });
  if (raw.timing.minLapProgress <= raw.timing.postCrossLatchProgress) {
    throw new AppError("invalid_config", "minLapProgress must exceed the post-cross latch", 500);
  }
  requireNumber(raw.timing.maxForwardJump, "timing.maxForwardJump", { min: 0.01, max: 0.49 });
  requireNumber(raw.timing.maxGapMs, "timing.maxGapMs", { min: 1 });
  requireNumber(raw.timing.startGateU, "timing.startGateU", { min: 0, max: 0.2 });
  requireNumber(raw.timing.stagedWaitMs, "timing.stagedWaitMs", { min: 0 });
  requireNumber(raw.countdownMs, "countdownMs", { min: 0 });
  requireNumber(raw.projectionFit.xSpan, "projectionFit.xSpan", { min: 0.01 });
  requireNumber(raw.projectionFit.zSpan, "projectionFit.zSpan", { min: 0.01 });
  requireNumber(raw.projectionFit.closureSeconds, "projectionFit.closureSeconds", { min: 0 });
  requireNumber(raw.cleaning.maxDropFraction, "cleaning.maxDropFraction", { min: 0, max: 1 });
  requireNumber(raw.cleaning.warnDropFraction, "cleaning.warnDropFraction", { min: 0, max: 1 });
  if (typeof raw.invalidation?.finishImmediately !== "boolean") {
    throw new AppError("invalid_config", "invalidation.finishImmediately must be boolean", 500);
  }
  if (raw.safety.maxSpeedKmh != null) requireNumber(raw.safety.maxSpeedKmh, "safety.maxSpeedKmh", { min: 0 });
  if (typeof raw.safety.egressEnabled !== "boolean") {
    throw new AppError("invalid_config", "safety.egressEnabled must be boolean", 500);
  }
  if (!raw.difficulties || typeof raw.difficulties !== "object") {
    throw new AppError("invalid_config", "difficulties must be an object", 500);
  }
  for (const [name, difficulty] of Object.entries(raw.difficulties)) {
    requireNumber(difficulty.bossLapFactor, `difficulties.${name}.bossLapFactor`, { min: 0.05, max: 2 });
    requireNumber(difficulty.trackLimit, `difficulties.${name}.trackLimit`, { min: 0 });
    requireNumber(difficulty.trackingGraceMs, `difficulties.${name}.trackingGraceMs`, { min: 0 });
  }
  if (!Object.hasOwn(raw.difficulties, raw.defaultDifficulty)) {
    throw new AppError("invalid_config", "defaultDifficulty is not defined", 500, { defaultDifficulty: raw.defaultDifficulty });
  }
  if (!["flying", "staged"].includes(raw.defaultStartMode)) {
    throw new AppError("invalid_config", "defaultStartMode must be flying or staged", 500);
  }
  if (typeof raw.server.host !== "string" || raw.server.host.length === 0) {
    throw new AppError("invalid_config", "server.host is required", 500);
  }
  requireNumber(raw.server.port, "server.port", { min: 0, max: 65535 });
  const ends = sectorEnds(raw.sectors);
  return Object.freeze({
    ...raw,
    sectors: Object.freeze({ ...raw.sectors, ends: Object.freeze(ends) }),
    difficulties: Object.freeze({ ...raw.difficulties }),
  });
}

export function loadConfig(configPath = defaultConfigPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return validateConfig(raw);
}

export function difficultyOrThrow(config, name) {
  const difficulty = config.difficulties[name];
  if (!difficulty) {
    throw new AppError("unknown_difficulty", `Unknown difficulty: ${name}`, 400, {
      choices: Object.keys(config.difficulties),
    });
  }
  return { name, ...difficulty };
}

export function loadCalibrations(directory = calibrationDir) {
  const calibrations = new Map();
  if (!fs.existsSync(directory)) return calibrations;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const calibration = JSON.parse(fs.readFileSync(path.join(directory, entry), "utf8"));
    if (!calibration.id || !["identity", "affine"].includes(calibration.type)) {
      throw new AppError("invalid_config", `Calibration ${entry} is missing a supported id and type`, 500);
    }
    if (calibration.type === "affine") {
      for (const key of ["ax", "bx", "cx", "az", "bz", "cz"]) {
        requireNumber(calibration[key], `calibration.${calibration.id}.${key}`);
      }
    }
    calibrations.set(calibration.id, Object.freeze(calibration));
  }
  if (!calibrations.has("identity-v1")) {
    throw new AppError("invalid_config", "identity-v1 calibration is required", 500);
  }
  return calibrations;
}
