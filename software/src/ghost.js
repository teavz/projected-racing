import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";
import { fitRecordedSamples, timeAtU } from "./geometry.js";
import { validateRecordedLap } from "./schema.js";

function column(row, index, name) {
  return index[name] == null ? undefined : row[index[name]];
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function cleanRecordedLap(lap, columnIndex, cleaning) {
  const dropped = {};
  const clamps = { negativeSpeed: 0, throttle: 0, brake: 0 };
  const cleaned = [];
  let previousTime = -Infinity;
  for (const row of lap.samples) {
    const drop = (reason) => {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
    };
    if (!Array.isArray(row)) {
      drop("short_row");
      continue;
    }
    const time = column(row, columnIndex, "time");
    const x = column(row, columnIndex, "x");
    const y = column(row, columnIndex, "y");
    const speed = column(row, columnIndex, "speed");
    if (![time, x, y, speed].every(finite)) {
      drop("non_finite");
      continue;
    }
    if (time < 0) {
      drop("negative_time");
      continue;
    }
    if (time < previousTime) {
      drop("time_reversal");
      continue;
    }
    if (time === previousTime) {
      drop("duplicate_time");
      cleaned.pop();
    }
    let speedKmh = speed;
    if (speedKmh < 0) {
      speedKmh = 0;
      clamps.negativeSpeed += 1;
    }
    let throttle = column(row, columnIndex, "throttle");
    let brake = column(row, columnIndex, "brake");
    throttle = finite(throttle) ? throttle : 0;
    brake = finite(brake) ? brake : 0;
    if (throttle < 0 || throttle > 100) {
      throttle = Math.min(100, Math.max(0, throttle));
      clamps.throttle += 1;
    }
    if (brake < 0 || brake > 100) {
      brake = Math.min(100, Math.max(0, brake));
      clamps.brake += 1;
    }
    cleaned.push({
      t: time,
      x,
      y,
      speedKmh,
      gear: column(row, columnIndex, "gear") ?? null,
      throttle,
      brake,
      drs: column(row, columnIndex, "drs") ?? null,
    });
    previousTime = time;
  }
  const dropCount = Object.values(dropped).reduce((sum, count) => sum + count, 0);
  const fraction = lap.samples.length === 0 ? 1 : dropCount / lap.samples.length;
  return {
    samples: cleaned,
    dropped,
    clamps,
    dropCount,
    dropFraction: fraction,
    quality: fraction > cleaning.maxDropFraction ? "rejected" : fraction > cleaning.warnDropFraction ? "degraded" : "ok",
  };
}

function buildSectors(samples, lapDurationSeconds, ends) {
  const boundaries = [0, ...ends, 1];
  const sectors = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startU = boundaries[index];
    const endU = boundaries[index + 1];
    const startSeconds = timeAtU(samples, lapDurationSeconds, startU);
    const endSeconds = timeAtU(samples, lapDurationSeconds, endU);
    sectors.push({
      index: index + 1,
      startU,
      endU,
      startSeconds,
      endSeconds,
      durationMs: Math.round((endSeconds - startSeconds) * 1000),
    });
  }
  return sectors;
}

function contentHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildGhostFromRecorded(lap, config, builtAt = new Date().toISOString()) {
  const checked = validateRecordedLap(lap);
  if (!checked.ok) {
    throw new AppError("invalid_telemetry", "Recorded lap failed validation", 400, { errors: checked.errors });
  }
  const cleaned = cleanRecordedLap(lap, checked.columnIndex, config.cleaning);
  if (cleaned.samples.length < 2 || cleaned.quality === "rejected") {
    throw new AppError("invalid_telemetry", "Recorded lap lost too many samples during cleaning", 400, {
      dropped: cleaned.dropped,
      remaining: cleaned.samples.length,
    });
  }
  const fitted = fitRecordedSamples(cleaned.samples, lap.lapDuration, config.projectionFit);
  const sectors = buildSectors(fitted.samples, lap.lapDuration, config.sectors.ends);
  const cap = config.safety.maxSpeedKmh;
  const profile = fitted.samples.map((sample) => ({
    u: sample.u,
    recordedSpeedKmh: sample.speedKmh,
    targetSpeedKmh: cap == null ? sample.speedKmh : Math.min(sample.speedKmh, cap),
    targetThrottle: sample.throttle,
    targetBrake: sample.brake,
  }));
  const hash = contentHash({
    circuitId: lap.id,
    lapDuration: lap.lapDuration,
    fit: config.projectionFit,
    sectorEnds: config.sectors.ends,
    maxSpeedKmh: cap,
    samples: fitted.samples.map((sample) => [sample.t, sample.x, sample.z, sample.u, sample.speedKmh, sample.throttle, sample.brake]),
  });
  return {
    schemaVersion: 1,
    id: `gst_${lap.id}_${hash.slice(0, 16)}`,
    contentHash: hash,
    circuitId: lap.id,
    circuitName: lap.name,
    builtAt,
    advisory: true,
    lineage: {
      source: lap.sessionKey ? "openf1-historical" : lap.source ?? "recorded-file",
      sessionKey: lap.sessionKey ?? null,
      driver: lap.driver ?? null,
      driverNumber: lap.driverNumber ?? null,
      team: lap.team ?? null,
      lapNumber: lap.lapNumber ?? null,
      lapDurationSeconds: lap.lapDuration,
      circuitLengthMeters: lap.circuitLength,
      date: lap.date ?? null,
      sources: lap.sources ?? null,
      sourceNotes: lap.notes ?? null,
      limits: [
        "Historical recording, not a live feed.",
        "Projection fit and the 1.5 second timing-line closure match the local simulator. They are not a survey.",
        "Equal-distance sectors are used unless sector boundaries are configured.",
        "Recorded speed remains in the profile. No physical speed cap is applied unless safety.maxSpeedKmh is set.",
      ],
      cleaning: {
        inputCount: lap.samples.length,
        outputCount: cleaned.samples.length,
        dropped: cleaned.dropped,
        clamps: cleaned.clamps,
        quality: cleaned.quality,
      },
    },
    frame: {
      id: "projection-fit-v1",
      xSpan: config.projectionFit.xSpan,
      zSpan: config.projectionFit.zSpan,
      closureSeconds: config.projectionFit.closureSeconds,
      rotationRadians: fitted.rotationRadians,
      closure: fitted.closure,
      length: fitted.length,
      metersPerUnit: lap.circuitLength / (fitted.length || 1),
    },
    sectors,
    samples: fitted.samples,
    profile: {
      mode: "advisory-only",
      units: {
        speed: "km/h",
        throttle: "percent_0_100",
        brake: "percent_0_100",
      },
      maxSpeedKmh: cap,
      samples: profile,
    },
    lapDurationSeconds: lap.lapDuration,
  };
}

export function buildCircleGhost({ id = "circle", name = "Circle fixture", lapDurationSeconds = 4, points = 121, radius = 10, sectorEnds = [1 / 3, 2 / 3] } = {}) {
  const samples = [];
  for (let index = 0; index < points; index += 1) {
    const fraction = index / (points - 1);
    const angle = fraction * Math.PI * 2;
    samples.push({
      t: fraction * lapDurationSeconds,
      x: radius * Math.cos(angle),
      z: radius * Math.sin(angle),
      u: fraction,
      speedKmh: 36,
      gear: 1,
      throttle: 40,
      brake: 0,
      drs: 0,
    });
  }
  const boundaries = [0, ...sectorEnds, 1];
  const sectors = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startU = boundaries[index];
    const endU = boundaries[index + 1];
    sectors.push({
      index: index + 1,
      startU,
      endU,
      startSeconds: startU * lapDurationSeconds,
      endSeconds: endU * lapDurationSeconds,
      durationMs: Math.round((endU - startU) * lapDurationSeconds * 1000),
    });
  }
  return {
    schemaVersion: 1,
    id: `gst_${id}_fixture`,
    contentHash: `fixture-${id}`,
    circuitId: id,
    circuitName: name,
    builtAt: "1970-01-01T00:00:00.000Z",
    advisory: true,
    fixture: true,
    lineage: {
      source: "synthetic-fixture",
      limits: ["Not a circuit. Used to test scoring without recorded telemetry."],
      lapDurationSeconds,
      cleaning: { quality: "ok", inputCount: points, outputCount: points, dropped: {}, clamps: {} },
    },
    frame: { id: "circle-fixture", length: 2 * Math.PI * radius, metersPerUnit: null },
    sectors,
    samples,
    profile: {
      mode: "advisory-only",
      units: { speed: "km/h", throttle: "percent_0_100", brake: "percent_0_100" },
      maxSpeedKmh: null,
      samples: samples.map((sample) => ({
        u: sample.u,
        recordedSpeedKmh: sample.speedKmh,
        targetSpeedKmh: sample.speedKmh,
        targetThrottle: sample.throttle,
        targetBrake: sample.brake,
      })),
    },
    lapDurationSeconds,
  };
}

export function loadTelemetryDirectory(directory) {
  if (!fs.existsSync(directory)) {
    throw new AppError("telemetry_missing", `Telemetry directory not found: ${directory}`, 500);
  }
  const laps = [];
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json") || entry === "catalog.json") continue;
    const lap = JSON.parse(fs.readFileSync(path.join(directory, entry), "utf8"));
    laps.push(lap);
  }
  if (laps.length === 0) throw new AppError("telemetry_missing", "No recorded lap files found", 500);
  return laps.sort((left, right) => left.id.localeCompare(right.id));
}
