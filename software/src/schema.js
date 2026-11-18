const ROLES = new Set(["human", "boss", "timing", "other"]);
const CLOCKS = new Set(["epoch", "monotonic"]);
const FLAG = /^[a-z0-9_:-]{1,32}$/;

function invalid(errors, path, message) {
  errors.push({ path, message });
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function servoSchemaDescription() {
  return {
    schemaVersion: 1,
    required: ["schemaVersion", "servoId", "role", "sequence", "sourceTimeMs"],
    roles: [...ROLES],
    clocks: [...CLOCKS],
    position: "x and y are planar. y is not up. Provide x and y, or progress in [0, 1), or both.",
    actuators: {
      throttle: "0 to 1, normalized. Not percent and not PWM.",
      brake: "0 to 1, normalized. Not percent and not PWM.",
      steer: "-1 to 1, normalized. Sign convention is uncalibrated and is not used for scoring.",
    },
    lock: "Omit lock and quality only if the sender cannot report them. The service marks that sample assumed, not locked.",
    example: "software/config/examples/servo-sample.json",
  };
}

export function validateServoSample(input, limits) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", message: "Sample must be an object" }] };
  }
  if (input.schemaVersion !== 1) invalid(errors, "schemaVersion", "Only schemaVersion 1 is accepted");
  if (typeof input.servoId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.servoId)) {
    invalid(errors, "servoId", "servoId must be 1-64 characters of letters, numbers, dot, underscore, colon, or hyphen");
  }
  if (!ROLES.has(input.role)) invalid(errors, "role", "role must be human, boss, timing, or other");
  if (!Number.isInteger(input.sequence) || input.sequence < 0) invalid(errors, "sequence", "sequence must be an integer >= 0");
  if (!finite(input.sourceTimeMs)) invalid(errors, "sourceTimeMs", "sourceTimeMs must be a finite number");
  const clock = input.clock ?? "epoch";
  if (!CLOCKS.has(clock)) invalid(errors, "clock", "clock must be epoch or monotonic");

  const hasX = input.x != null;
  const hasY = input.y != null;
  if (hasX !== hasY) invalid(errors, "x", "x and y must be supplied together");
  if (hasX && !finite(input.x)) invalid(errors, "x", "x must be finite");
  if (hasY && !finite(input.y)) invalid(errors, "y", "y must be finite");
  if (input.z != null && !finite(input.z)) invalid(errors, "z", "z must be finite when supplied");
  if (input.headingRadians != null && !finite(input.headingRadians)) {
    invalid(errors, "headingRadians", "headingRadians must be finite when supplied");
  }
  if (input.speedMps != null && (!finite(input.speedMps) || input.speedMps < 0)) {
    invalid(errors, "speedMps", "speedMps must be finite and >= 0");
  }
  if (input.progress != null && (!finite(input.progress) || input.progress < 0 || input.progress > 1)) {
    invalid(errors, "progress", "progress must be inside [0, 1]");
  }
  if (input.role === "human" && !hasX && input.progress == null) {
    invalid(errors, "progress", "A human sample needs x/y or progress");
  }
  if (input.lock != null && typeof input.lock !== "boolean") invalid(errors, "lock", "lock must be boolean");
  if (input.quality != null && (!finite(input.quality) || input.quality < 0 || input.quality > 1)) {
    invalid(errors, "quality", "quality must be inside [0, 1]");
  }
  let actuators;
  if (input.actuators != null) {
    if (typeof input.actuators !== "object" || Array.isArray(input.actuators)) {
      invalid(errors, "actuators", "actuators must be an object");
    } else {
      actuators = {};
      for (const [key, min, max] of [["throttle", 0, 1], ["brake", 0, 1], ["steer", -1, 1]]) {
        if (input.actuators[key] == null) continue;
        if (!finite(input.actuators[key]) || input.actuators[key] < min || input.actuators[key] > max) {
          invalid(errors, `actuators.${key}`, `${key} must be a normalized value from ${min} to ${max}`);
        } else {
          actuators[key] = input.actuators[key];
        }
      }
    }
  }
  const flags = [];
  if (input.flags != null) {
    if (!Array.isArray(input.flags) || input.flags.length > 8) invalid(errors, "flags", "flags must be an array of at most 8 strings");
    else {
      for (const flag of input.flags) {
        if (typeof flag !== "string" || !FLAG.test(flag)) invalid(errors, "flags", "flags must match [a-z0-9_:-]{1,32}");
        else flags.push(flag);
      }
    }
  }
  let raw;
  let rawRetained = false;
  if (input.raw != null) {
    if (typeof input.raw !== "object" || Array.isArray(input.raw)) invalid(errors, "raw", "raw must be an object");
    else {
      const encoded = JSON.stringify(input.raw);
      if (encoded.length > limits.maxRawBytes) invalid(errors, "raw", `raw exceeds ${limits.maxRawBytes} bytes`);
      else {
        raw = input.raw;
        rawRetained = true;
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    sample: {
      schemaVersion: 1,
      servoId: input.servoId,
      role: input.role,
      sequence: input.sequence,
      sourceTimeMs: input.sourceTimeMs,
      clock,
      x: hasX ? input.x : null,
      y: hasY ? input.y : null,
      z: input.z ?? null,
      headingRadians: input.headingRadians ?? null,
      speedMps: input.speedMps ?? null,
      progress: input.progress ?? null,
      lock: input.lock ?? null,
      quality: input.quality ?? null,
      actuators: actuators ?? null,
      flags,
      raw: raw ?? null,
      rawRetained,
    },
  };
}

const REQUIRED_COLUMNS = ["time", "x", "y", "speed"];

export function validateRecordedLap(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: [{ path: "", message: "Recorded lap must be an object" }] };
  for (const key of ["id", "name"]) {
    if (typeof input[key] !== "string" || input[key].length === 0) invalid(errors, key, `${key} is required`);
  }
  if (!finite(input.lapDuration) || input.lapDuration <= 0) invalid(errors, "lapDuration", "lapDuration must be a positive number of seconds");
  if (!finite(input.circuitLength) || input.circuitLength <= 0) invalid(errors, "circuitLength", "circuitLength must be a positive number of meters");
  if (!Array.isArray(input.columns) || input.columns.length < 4) invalid(errors, "columns", "columns must name the sample fields");
  if (!Array.isArray(input.samples) || input.samples.length < 2) invalid(errors, "samples", "at least two samples are required");
  if (errors.length) return { ok: false, errors };
  const index = Object.fromEntries(input.columns.map((name, position) => [name, position]));
  for (const name of REQUIRED_COLUMNS) {
    if (!Number.isInteger(index[name])) invalid(errors, "columns", `missing required column ${name}`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, columnIndex: index };
}
