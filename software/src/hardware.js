import { AppError } from "./errors.js";

const ROLES = new Set(["human", "boss", "timing", "other"]);

export const hardwareAssumptions = Object.freeze({
  schemaVersion: 1,
  frameId: "projection-meters-v1",
  bindings: Object.freeze({ "1": "human", "2": "boss" }),
  lostAfterMs: 200,
  minHz: 30,
  latencyBudgetMs: 100,
  controlLatencyBudgetMs: 50,
  fallbackMetersPerUnit: 0.05,
  origin: Object.freeze({ x: 0, z: 0 }),
  axes: "+x matches racing x and +y matches racing z. This is not a surveyed floor frame.",
  smoothing: "Velocity and acceleration are assumed already filtered. This adapter does not smooth them.",
  transport: "HTTP POST /v1/sessions/:id/motion and ws://127.0.0.1/ws/hw stand in for the wired LAN socket. UDP is not listening. Neither opens a radio, serial port, or motor controller.",
  trackWidth: "A loaded track reference records width. It does not change scoring limits until a surveyed calibration replaces the ghost.",
  estop: "POST /v1/sessions/:id/estop is the existing operator hold. It is not a physical or safety-rated stop.",
  pathFollowing: "No steering or throttle gains are applied. Advisory ghost setpoints stay off the wire unless a human enables egress.",
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function invalid(errors, path, message) {
  errors.push({ path, message });
}

export function hardwareSchemaDescription() {
  return {
    schemaVersion: 1,
    required: ["car_id", "t_ms", "x", "y", "vx", "vy", "ax", "ay"],
    units: { position: "meters", velocity: "m/s", acceleration: "m/s^2", time: "milliseconds" },
    bindings: hardwareAssumptions.bindings,
    lostAfterMs: hardwareAssumptions.lostAfterMs,
    minHz: hardwareAssumptions.minHz,
    latencyBudgetMs: hardwareAssumptions.latencyBudgetMs,
    frame: hardwareAssumptions.frameId,
    ignored: "Unknown keys are ignored. Optional throttle above 1 and at most 100 is treated as percent.",
    example: "software/config/examples/motion-sample.json",
    assumptions: hardwareAssumptions,
  };
}

export function frameForGhost(ghost, assumptions = hardwareAssumptions, track = null) {
  const measured = ghost?.frame?.metersPerUnit;
  const known = Number.isFinite(measured) && measured > 0;
  const frame = {
    id: assumptions.frameId,
    metersPerUnit: known ? measured : assumptions.fallbackMetersPerUnit,
    origin: { x: assumptions.origin.x, z: assumptions.origin.z },
    originMeters: { x: 0, y: 0 },
    forward: { x: 1, y: 0 },
    left: { x: 0, y: 1 },
    widthMeters: null,
    referenceId: null,
    assumedScale: !known,
    surveyed: false,
  };
  if (!track) return frame;
  return {
    ...frame,
    originMeters: track.originMeters,
    forward: track.forward,
    left: track.left,
    widthMeters: track.widthMeters,
    referenceId: track.id,
    surveyed: track.surveyed === true,
    assumedScale: !known || track.surveyed !== true,
  };
}

function basis(frame) {
  return {
    originMeters: frame.originMeters ?? { x: 0, y: 0 },
    forward: frame.forward ?? { x: 1, y: 0 },
    left: frame.left ?? { x: 0, y: 1 },
    origin: frame.origin ?? { x: 0, z: 0 },
    metersPerUnit: frame.metersPerUnit,
  };
}

export function metersToRacing(point, frame) {
  const axes = basis(frame);
  const dx = point.x - axes.originMeters.x;
  const dy = point.y - axes.originMeters.y;
  return {
    x: (dx * axes.forward.x + dy * axes.forward.y) / axes.metersPerUnit + axes.origin.x,
    y: (dx * axes.left.x + dy * axes.left.y) / axes.metersPerUnit + axes.origin.z,
  };
}

export function racingToMeters(point, frame) {
  const axes = basis(frame);
  const rx = (point.x - axes.origin.x) * axes.metersPerUnit;
  const ry = (point.z - axes.origin.z) * axes.metersPerUnit;
  return {
    x: axes.originMeters.x + rx * axes.forward.x + ry * axes.left.x,
    y: axes.originMeters.y + rx * axes.forward.y + ry * axes.left.y,
  };
}

function point2(value, path, errors) {
  if (!value || typeof value !== "object" || !finite(value.x) || !finite(value.y)) {
    invalid(errors, path, `${path} needs finite x and y`);
    return null;
  }
  return { x: value.x, y: value.y };
}

function unit(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length === 0) return null;
  return { x: vector.x / length, y: vector.y / length };
}

export function validateTrackReference(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", message: "Track reference must be an object" }] };
  }
  if (typeof input.id !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.id)) {
    invalid(errors, "id", "id must be 1-64 letters, numbers, dot, underscore, colon, or hyphen");
  }
  if (!finite(input.widthMeters) || input.widthMeters <= 0 || input.widthMeters > 20) {
    invalid(errors, "widthMeters", "widthMeters must be greater than 0 and at most 20");
  }
  const a = point2(input.startLine?.a, "startLine.a", errors);
  const b = point2(input.startLine?.b, "startLine.b", errors);
  if (a && b && Math.hypot(b.x - a.x, b.y - a.y) < 0.05) {
    invalid(errors, "startLine", "start line must be at least 0.05 m long");
  }
  const forward = input.forward == null ? { x: 1, y: 0 } : point2(input.forward, "forward", errors);
  const forwardUnit = forward ? unit(forward) : null;
  if (forward && !forwardUnit) invalid(errors, "forward", "forward must have a length");
  const lap = input.referenceLap;
  const surveyed = input.surveyed === true;
  if (input.surveyed != null && typeof input.surveyed !== "boolean") invalid(errors, "surveyed", "surveyed must be boolean");
  if (surveyed && (!Array.isArray(lap) || lap.filter((point) => finite(point?.x) && finite(point?.y)).length < 8)) {
    invalid(errors, "referenceLap", "A surveyed reference needs at least 8 x/y points. This still does not replace the ghost.");
  }
  if (errors.length) return { ok: false, errors };
  const left = { x: -forwardUnit.y, y: forwardUnit.x };
  return {
    ok: true,
    reference: {
      id: input.id,
      surveyed,
      widthMeters: input.widthMeters,
      startLine: { a, b },
      originMeters: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      forward: forwardUnit,
      left,
      referenceLapCount: Array.isArray(lap) ? lap.length : 0,
      notes: typeof input.notes === "string" ? input.notes.slice(0, 240) : null,
    },
  };
}

export function loadTrackReference(input) {
  const checked = validateTrackReference(input);
  if (!checked.ok) {
    throw new AppError("invalid_track_reference", checked.errors.map((error) => `${error.path}: ${error.message}`).join("; "), 400, { errors: checked.errors });
  }
  return checked.reference;
}

export function createHardwareBridge(options = {}) {
  const bindings = new Map(Object.entries(options.bindings ?? hardwareAssumptions.bindings));
  return {
    bindings,
    cars: new Map(),
    unknownCars: new Map(),
    lostAfterMs: options.lostAfterMs ?? hardwareAssumptions.lostAfterMs,
    minHz: options.minHz ?? hardwareAssumptions.minHz,
    latencyBudgetMs: options.latencyBudgetMs ?? hardwareAssumptions.latencyBudgetMs,
  };
}

export function bindCar(bridge, carId, role) {
  const id = String(carId);
  if (!ROLES.has(role)) throw new AppError("invalid_command", `Cannot bind car ${id} to role ${role}`, 400);
  bridge.bindings.set(id, role);
  return { carId: id, role };
}

export function validateMotionSample(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", message: "Motion sample must be an object" }] };
  }
  const carId = input.car_id;
  if (!((typeof carId === "string" && carId.length > 0 && carId.length <= 32) || (Number.isInteger(carId) && carId >= 0))) {
    invalid(errors, "car_id", "car_id must be a short string or an integer >= 0");
  }
  if (!finite(input.t_ms)) invalid(errors, "t_ms", "t_ms must be a finite number of milliseconds");
  for (const key of ["x", "y", "vx", "vy", "ax", "ay"]) {
    if (!finite(input[key])) invalid(errors, key, `${key} must be finite`);
  }
  if (errors.length) return { ok: false, errors };
  const actuators = {};
  for (const [key, min, max, percent] of [["throttle", 0, 1, true], ["brake", 0, 1, true], ["steer", -1, 1, false]]) {
    if (input[key] == null) continue;
    let value = input[key];
    if (!finite(value)) {
      invalid(errors, key, `${key} must be finite when supplied`);
      continue;
    }
    if (percent && value > 1 && value <= 100) value /= 100;
    if (value < min || value > max) invalid(errors, key, `${key} must be normalized from ${min} to ${max}`);
    else actuators[key] = value;
  }
  if (input.heading != null && !finite(input.heading)) invalid(errors, "heading", "heading must be finite radians when supplied");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    sample: {
      carId: String(carId),
      tMs: input.t_ms,
      x: input.x,
      y: input.y,
      vx: input.vx,
      vy: input.vy,
      ax: input.ax,
      ay: input.ay,
      heading: finite(input.heading) ? input.heading : null,
      actuators,
    },
  };
}

function rate(gapMs) {
  return gapMs > 0 ? 1000 / gapMs : null;
}

export function hardwareHealth(bridge, now) {
  return [...bridge.cars.entries()].map(([carId, state]) => {
    const silentMs = state.lastT == null || now == null ? null : now - state.lastT;
    return {
      carId,
      role: bridge.bindings.get(carId) ?? null,
      sequence: state.sequence,
      silentMs,
      lost: silentMs != null && silentMs > bridge.lostAfterMs,
      gapMs: state.gapMs,
      hz: rate(state.gapMs),
      belowRate: state.gapMs != null && state.gapMs > 1000 / bridge.minHz,
    };
  });
}

export function convertMotion(bridge, input, frame, receivedAtMs) {
  const checked = validateMotionSample(input);
  if (!checked.ok) {
    return { accepted: false, rejection: { code: "invalid_motion", message: checked.errors.map((error) => `${error.path}: ${error.message}`).join("; ") }, health: null };
  }
  const sample = checked.sample;
  const role = bridge.bindings.get(sample.carId);
  if (!role) {
    bridge.unknownCars.set(sample.carId, (bridge.unknownCars.get(sample.carId) ?? 0) + 1);
    return { accepted: false, rejection: { code: "unknown_car", message: `car_id ${sample.carId} is not bound` }, health: null };
  }
  const state = bridge.cars.get(sample.carId) ?? { sequence: 0, lastT: null, gapMs: null };
  if (state.lastT != null && sample.tMs <= state.lastT) {
    return {
      accepted: false,
      rejection: { code: "stale_motion", message: "Old motion values are not resent" },
      health: hardwareHealth(bridge, receivedAtMs).find((item) => item.carId === sample.carId) ?? null,
    };
  }
  const gapMs = state.lastT == null ? null : sample.tMs - state.lastT;
  const lost = gapMs != null && gapMs > bridge.lostAfterMs;
  state.sequence += 1;
  state.lastT = sample.tMs;
  state.gapMs = gapMs;
  bridge.cars.set(sample.carId, state);
  const racing = metersToRacing(sample, frame);
  const latencyMs = receivedAtMs - sample.tMs;
  const servo = {
    schemaVersion: 1,
    servoId: `car-${sample.carId}`,
    role,
    sequence: state.sequence,
    sourceTimeMs: sample.tMs,
    clock: "epoch",
    x: racing.x,
    y: racing.y,
    speedMps: Math.hypot(sample.vx, sample.vy),
    lock: !lost,
    quality: lost ? 0 : 1,
    flags: lost ? ["tracking_gap"] : ["motion_v1"],
    raw: { source: "motion-v1", car_id: sample.carId, t_ms: sample.tMs },
  };
  if (sample.heading != null) servo.headingRadians = sample.heading;
  if (Object.keys(sample.actuators).length) servo.actuators = sample.actuators;
  return {
    accepted: true,
    servo,
    health: {
      carId: sample.carId,
      role,
      sequence: state.sequence,
      lost,
      gapMs,
      hz: rate(gapMs),
      belowRate: gapMs != null && gapMs > 1000 / bridge.minHz,
      latencyMs,
      overLatencyBudget: latencyMs > bridge.latencyBudgetMs,
      frame,
    },
  };
}

export function pointAtProgress(samples, progress) {
  const laps = Math.floor(progress);
  const u = progress - laps;
  const last = samples[samples.length - 1];
  if (u === 0) return { x: samples[0].x, z: samples[0].z, u: 0 };
  for (let index = 0; index < samples.length - 1; index += 1) {
    const start = samples[index];
    const end = samples[index + 1];
    const endU = index === samples.length - 2 && end.u === 0 ? 1 : end.u >= start.u ? end.u : 1;
    if (u + 1e-9 < start.u || u - endU > 1e-9) continue;
    const span = endU - start.u || 1;
    const fraction = Math.min(1, Math.max(0, (u - start.u) / span));
    return {
      x: start.x + (end.x - start.x) * fraction,
      z: start.z + (end.z - start.z) * fraction,
      u,
    };
  }
  return { x: last.x, z: last.z, u: last.u >= 1 ? 0 : last.u };
}

export function motionLapFromGhost(ghost, options = {}) {
  const frame = options.frame ?? frameForGhost(ghost);
  const lapMs = Math.max(1, Math.round(ghost.lapDurationSeconds * 1000));
  const fromU = options.fromU ?? 0.96;
  const toU = options.toU ?? 2.02;
  const stepMs = options.stepMs ?? 33;
  const stepU = Math.min(options.stepU ?? 0.02, (stepMs / lapMs) * 0.98);
  const carId = options.carId ?? 1;
  const startMs = options.startMs ?? 0;
  const points = [];
  for (let progress = fromU; progress <= toU + 1e-9; progress += stepU) {
    const point = pointAtProgress(ghost.samples, progress);
    const meters = racingToMeters(point, frame);
    const offsetMs = (progress - fromU) * lapMs;
    points.push({ progress, offsetMs, ...meters });
  }
  return points.map((point, index) => {
    const previous = points[index - 1];
    const dt = previous ? (point.offsetMs - previous.offsetMs) / 1000 : 0;
    const vx = previous && dt > 0 ? (point.x - previous.x) / dt : 0;
    const vy = previous && dt > 0 ? (point.y - previous.y) / dt : 0;
    return {
      car_id: carId,
      t_ms: Math.round(startMs + point.offsetMs),
      x: point.x,
      y: point.y,
      vx,
      vy,
      ax: 0,
      ay: 0,
    };
  });
}
