import { AppError } from "./errors.js";
import { applyCalibration, nearestProgress, sampleAtTime, timeAtU } from "./geometry.js";

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'\-]{0,39}$/u;
const ATTEMPT = new Set(["countdown", "racing", "lost_tracking", "invalid", "hold"]);

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  const sign = milliseconds < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(milliseconds));
  const minutes = Math.floor(absolute / 60000);
  const seconds = Math.floor((absolute % 60000) / 1000);
  const millis = absolute % 1000;
  return `${sign}${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function normalizeDriverName(name) {
  if (typeof name !== "string") return "";
  return name.trim().replace(/\s+/g, " ");
}

export function driverKey(name) {
  return normalizeDriverName(name).toLocaleLowerCase("en-US");
}

function emptyLap() {
  return {
    id: null,
    active: false,
    awaitingStart: true,
    startedAtMs: null,
    sectorIndex: 0,
    sectorStartedAtMs: null,
    sectorTimesMs: [],
    progress: 0,
    progressSinceCross: 0,
    crossArmed: true,
    invalid: null,
    lastU: null,
    lastTimingMs: null,
  };
}

function transition(session, to, reason, now) {
  const from = session.state;
  session.state = to;
  session.lastTransition = { from, to, reason, at: now };
  return { type: "race.state_changed", from, to, reason, at: now };
}

function pushTransition(events, session, to, reason, now) {
  if (session.state === to) return;
  events.push(transition(session, to, reason, now));
}

export function createSessionState(spec) {
  return {
    schemaVersion: 1,
    id: spec.id,
    circuitId: spec.circuitId,
    circuitName: spec.circuitName,
    ghostId: spec.ghostId,
    recordedLapMs: spec.recordedLapMs,
    calibrationId: spec.calibrationId,
    difficulty: spec.difficulty,
    bossLapFactor: spec.bossLapFactor,
    trackLimit: spec.trackLimit,
    trackingGraceMs: spec.trackingGraceMs,
    startMode: spec.startMode,
    humanServoId: spec.humanServoId ?? null,
    rules: spec.rules,
    state: "idle",
    offlineCause: null,
    stateBeforeOffline: null,
    driver: null,
    queue: [],
    instructions: "Register a driver to open the grid.",
    countdownEndsAt: null,
    stagedDeadline: null,
    holdReason: null,
    safetyHold: false,
    lap: emptyLap(),
    result: null,
    tracking: "unknown",
    trackingLostAt: null,
    lastHumanSampleAt: null,
    intakeSampleAt: null,
    watchArmedAt: null,
    sawSampleThisAttempt: false,
    sequences: {},
    feedStatus: "idle",
    lastObservation: null,
    gateProgress: null,
    bossObservation: null,
    attemptNumber: 0,
    completedAttempts: 0,
    quality: {
      received: 0,
      rejected: 0,
      sequenceGaps: 0,
      falseCrossings: 0,
      maxDelayMs: 0,
      driftMs: 0,
      delayBaselineMs: null,
      delayCount: 0,
      lateSamples: 0,
      lockAssumedSamples: 0,
      timeReversals: 0,
      lastRejection: null,
    },
    createdAt: spec.now,
    updatedAt: spec.now,
    lastTransition: null,
  };
}

function refreshInstructions(session) {
  if (session.state === "fault") session.instructions = "Ghost is unavailable. Recompute ghosts before continuing.";
  else if (session.state === "offline" && session.result) session.instructions = "Feed lost during the attempt. Reset before the next run.";
  else if (session.state === "offline") session.instructions = "Servo feed is offline. Wait for samples, then reset if the attempt was voided.";
  else if (session.state === "hold") session.instructions = "Operator hold. Scoring is paused. Release voids an active lap.";
  else if (session.state === "invalid") session.instructions = `Invalid lap: ${session.result?.reason ?? session.lap.invalid?.reason ?? "unspecified"}. Reset for another attempt.`;
  else if (session.state === "result" && session.result?.outcome === "beat_boss") session.instructions = "Beat the boss. Reset to run again.";
  else if (session.state === "result" && session.result?.outcome === "tie") session.instructions = "Level with the boss. Reset to run again.";
  else if (session.state === "result" && session.result?.outcome === "behind_boss") session.instructions = "Behind the boss. Reset to run again.";
  else if (session.state === "result") session.instructions = "Attempt closed. Reset to run again.";
  else if (session.state === "lost_tracking") session.instructions = "Tracking lost. Recover before grace expires or the lap is void.";
  else if (session.state === "racing" && !session.lap.active) session.instructions = "Countdown complete. Cross the start line to begin the lap.";
  else if (session.state === "racing") session.instructions = "Lap live. Stay on the racing line.";
  else if (session.state === "countdown" && session.holdReason === "not_on_grid") session.instructions = "Staged start is waiting for the car in the start gate.";
  else if (session.state === "countdown") session.instructions = "Countdown running. Hold position.";
  else if (session.state === "intake") session.instructions = "Driver set. Start when the servo feed is ready.";
  else session.instructions = "Register a driver to open the grid.";
}

function assertName(name) {
  const display = normalizeDriverName(name);
  if (!NAME.test(display)) {
    throw new AppError("invalid_driver", "Driver name must be 1-40 letters, numbers, spaces, apostrophes, or hyphens", 400);
  }
  return display;
}

function clearAttempt(session, options = {}) {
  const gateProgress = session.gateProgress;
  session.lap = emptyLap();
  session.result = null;
  session.countdownEndsAt = null;
  session.stagedDeadline = null;
  session.holdReason = null;
  session.safetyHold = false;
  session.trackingLostAt = null;
  session.offlineCause = null;
  session.watchArmedAt = null;
  session.sawSampleThisAttempt = false;
  session.intakeSampleAt = null;
  session.feedStatus = "idle";
  session.gateProgress = options.keepGate ? gateProgress : null;
}

export function applyCommand(session, command, context) {
  const now = context.now;
  const events = [];
  const type = command?.type;
  if (session.state === "fault" && type !== "reset") {
    throw new AppError("illegal_transition", "Session is faulted. Reset after the ghost is restored.", 409);
  }
  if (type === "register-driver") {
    if (ATTEMPT.has(session.state) || session.state === "result" || (session.state === "offline" && session.result)) {
      throw new AppError("illegal_transition", "Finish or reset the attempt before replacing the driver", 409);
    }
    const name = assertName(command.name);
    session.driver = { id: context.driverId, name, key: driverKey(name) };
    if (session.state === "offline") session.stateBeforeOffline = "intake";
    pushTransition(events, session, "intake", "driver_registered", now);
    events.push({ type: "driver.registered", driver: session.driver, at: now });
  } else if (type === "queue-driver") {
    const name = assertName(command.name);
    session.queue.push({ id: context.driverId, name, key: driverKey(name) });
    events.push({ type: "driver.queued", name, at: now });
  } else if (type === "set-difficulty") {
    if (!["idle", "intake"].includes(session.state)) {
      throw new AppError("illegal_transition", "Difficulty can change only before the countdown", 409);
    }
    const difficulty = context.difficulty;
    session.difficulty = difficulty.name;
    session.bossLapFactor = difficulty.bossLapFactor;
    session.trackLimit = difficulty.trackLimit;
    session.trackingGraceMs = difficulty.trackingGraceMs;
    events.push({ type: "race.difficulty_changed", difficulty: difficulty.name, at: now });
  } else if (type === "set-start-mode") {
    if (!["idle", "intake"].includes(session.state)) {
      throw new AppError("illegal_transition", "Start mode can change only before the countdown", 409);
    }
    if (!["flying", "staged"].includes(command.startMode)) {
      throw new AppError("invalid_command", "startMode must be flying or staged", 400);
    }
    session.startMode = command.startMode;
    events.push({ type: "race.start_mode_changed", startMode: command.startMode, at: now });
  } else if (type === "set-calibration") {
    if (!["idle", "intake"].includes(session.state)) {
      throw new AppError("illegal_transition", "Calibration can change only before the countdown", 409);
    }
    session.calibrationId = command.calibrationId;
    events.push({ type: "race.calibration_changed", calibrationId: command.calibrationId, at: now });
  } else if (type === "set-servo") {
    if (!["idle", "intake"].includes(session.state)) {
      throw new AppError("illegal_transition", "Servo binding can change only before the countdown", 409);
    }
    if (command.servoId != null && !/^[A-Za-z0-9._:-]{1,64}$/.test(command.servoId)) {
      throw new AppError("invalid_command", "servoId must match the servo sample id rules", 400);
    }
    session.humanServoId = command.servoId ?? null;
    events.push({ type: "race.servo_bound", servoId: session.humanServoId, at: now });
  } else if (type === "start") {
    if (session.state !== "intake" || !session.driver) {
      throw new AppError("illegal_transition", "Start is only available from driver intake", 409);
    }
    const countdownMs = command.countdownMs ?? session.rules.countdownMs;
    if (!Number.isFinite(countdownMs) || countdownMs < 0 || countdownMs > 120000) {
      throw new AppError("invalid_command", "countdownMs must be between 0 and 120000", 400);
    }
    clearAttempt(session, { keepGate: true });
    session.attemptNumber += 1;
    session.countdownEndsAt = now + countdownMs;
    pushTransition(events, session, "countdown", "start", now);
    events.push({ type: "race.countdown_started", endsAt: session.countdownEndsAt, attempt: session.attemptNumber, at: now });
  } else if (type === "hold") {
    if (!["countdown", "racing", "lost_tracking", "intake"].includes(session.state)) {
      throw new AppError("illegal_transition", "Hold is not available in this state", 409);
    }
    session.safetyHold = true;
    pushTransition(events, session, "hold", "operator_hold", now);
    events.push({ type: "race.hold", at: now });
  } else if (type === "release") {
    if (session.state !== "hold") throw new AppError("illegal_transition", "Release is only available during hold", 409);
    session.safetyHold = false;
    if (session.lap.active && !session.result) {
      events.push(...publish(session, finishPayload(session, now, context.ghost, "dnf", "operator_hold"), now));
      pushTransition(events, session, "result", "release", now);
    } else {
      const destination = session.driver ? "intake" : "idle";
      clearAttempt(session);
      pushTransition(events, session, destination, "release", now);
    }
  } else if (type === "abort") {
    if (!ATTEMPT.has(session.state)) throw new AppError("illegal_transition", "There is no armed attempt to abort", 409);
    if (!session.result) {
      events.push(...publish(session, finishPayload(session, now, context.ghost, "dnf", "operator_abort"), now));
    }
    pushTransition(events, session, "result", "operator_abort", now);
  } else if (type === "invalidate") {
    if (!session.lap.active) throw new AppError("illegal_transition", "There is no active lap to invalidate", 409);
    events.push(...invalidate(session, command.reason || "operator", now, context.ghost));
  } else if (type === "reset") {
    const from = session.state;
    clearAttempt(session);
    const destination = session.driver ? "intake" : "idle";
    events.push({ type: "race.reset", from, to: destination, at: now });
    pushTransition(events, session, destination, "reset", now);
  } else if (type === "next") {
    if (ATTEMPT.has(session.state)) throw new AppError("illegal_transition", "Reset or finish the attempt before calling the next driver", 409);
    if (session.queue.length === 0) throw new AppError("empty_queue", "No queued driver", 409);
    clearAttempt(session);
    session.driver = session.queue.shift();
    pushTransition(events, session, "intake", "next_driver", now);
    events.push({ type: "driver.registered", driver: session.driver, at: now });
  } else {
    throw new AppError("invalid_command", `Unknown command: ${type}`, 400);
  }
  session.updatedAt = now;
  refreshInstructions(session);
  return events;
}

export function chooseTimingMs(sample, receivedAtMs, rules) {
  if (sample.clock === "monotonic" || !Number.isFinite(sample.sourceTimeMs)) {
    return { timingMs: receivedAtMs, source: "server", late: false };
  }
  const delay = receivedAtMs - sample.sourceTimeMs;
  if (delay > rules.maxSampleDelayMs || delay < -rules.staleSourceReverseMs) {
    return { timingMs: receivedAtMs, source: "server", late: true };
  }
  return { timingMs: sample.sourceTimeMs, source: "servo", late: false };
}

function readTracking(sample, rules) {
  const qualityLost = Number.isFinite(sample.quality) && sample.quality < rules.lockQualityMin;
  if (sample.lock === false || qualityLost) return "lost";
  if (sample.lock === true || (Number.isFinite(sample.quality) && sample.quality >= rules.lockQualityMin)) return "locked";
  return "assumed";
}

function bossTimeMs(session) {
  return Math.round(session.recordedLapMs * session.bossLapFactor);
}

function locate(sample, ghost, calibration) {
  if (Number.isFinite(sample.progress)) {
    const progress = sample.progress >= 1 ? 0 : sample.progress;
    return { u: progress, lateral: null, x: null, z: null, source: "progress" };
  }
  const mapped = applyCalibration(sample, calibration);
  const near = nearestProgress(ghost.samples, mapped.x, mapped.z);
  return {
    u: near.u >= 1 ? 0 : near.u,
    lateral: near.distance,
    x: mapped.x,
    z: mapped.z,
    source: "nearest",
  };
}

function inGate(progress, rules) {
  return progress != null && (progress <= rules.startGateU || progress >= 1 - rules.startGateU);
}

export function noteRejection(session, rejection, now) {
  session.quality.rejected += 1;
  session.quality.lastRejection = { code: rejection.code, sequence: rejection.sequence ?? null, message: rejection.message ?? rejection.code, at: now };
  session.updatedAt = now;
}

function acceptSequence(session, sample, now) {
  const previous = session.sequences[sample.servoId];
  if (previous != null && sample.sequence === previous) {
    noteRejection(session, { code: "duplicate_sequence", sequence: sample.sequence }, now);
    return false;
  }
  if (previous != null && sample.sequence < previous) {
    noteRejection(session, { code: "stale_sequence", sequence: sample.sequence }, now);
    return false;
  }
  if (previous != null && sample.sequence > previous + 1) {
    session.quality.sequenceGaps += sample.sequence - previous - 1;
  }
  session.sequences[sample.servoId] = sample.sequence;
  return true;
}

export function applySample(session, sample, ghost, calibration, now) {
  const events = [];
  if (sample.role === "human" && session.humanServoId && sample.servoId !== session.humanServoId) {
    noteRejection(session, { code: "foreign_servo", sequence: sample.sequence, message: `Expected ${session.humanServoId}` }, now);
    return { accepted: false, rejection: session.quality.lastRejection, events };
  }
  if (!acceptSequence(session, sample, now)) {
    return { accepted: false, rejection: session.quality.lastRejection, events };
  }
  session.quality.received += 1;
  if (sample.clock !== "monotonic") {
    const delay = now - sample.sourceTimeMs;
    session.quality.maxDelayMs = Math.max(session.quality.maxDelayMs, delay);
    if (session.quality.delayBaselineMs == null) session.quality.delayBaselineMs = delay;
    session.quality.delayCount += 1;
    session.quality.driftMs = delay - session.quality.delayBaselineMs;
  }
  if (sample.role !== "human") {
    if (sample.role === "boss") session.bossObservation = { servoId: sample.servoId, at: now, progress: sample.progress };
    events.push({ type: "servo.sample_accepted", sequence: sample.sequence, role: sample.role, scored: false, at: now });
    session.updatedAt = now;
    return { accepted: true, scored: false, events };
  }
  if (!session.humanServoId) session.humanServoId = sample.servoId;
  session.lastHumanSampleAt = now;
  session.feedStatus = "live";
  if (session.state === "intake") session.intakeSampleAt = now;
  if (session.watchArmedAt != null) session.sawSampleThisAttempt = true;
  const timing = chooseTimingMs(sample, now, session.rules);
  if (timing.late) session.quality.lateSamples += 1;
  const tracking = readTracking(sample, session.rules);
  if (tracking === "assumed") session.quality.lockAssumedSamples += 1;
  updateTracking(session, tracking, now, ghost, events);
  if (session.state === "offline" && session.offlineCause === "feed" && !session.result) {
    pushTransition(events, session, session.stateBeforeOffline ?? "intake", "feed_restored", now);
    session.offlineCause = null;
    session.feedStatus = "live";
  }
  const observed = locate(sample, ghost, calibration);
  session.lastObservation = { ...observed, at: timing.timingMs, sequence: sample.sequence };
  session.gateProgress = observed.u;
  const scoringBlocked = session.safetyHold || session.result || ["idle", "intake", "hold", "result", "fault"].includes(session.state) || (session.state === "offline" && session.offlineCause !== "feed");
  if (session.lap.lastTimingMs != null && timing.source === "servo" && timing.timingMs + session.rules.staleSourceReverseMs < session.lap.lastTimingMs) {
    session.quality.timeReversals += 1;
    events.push({ type: "servo.sample_accepted", sequence: sample.sequence, scored: false, warning: "source_time_reversal", at: now });
    session.updatedAt = now;
    refreshInstructions(session);
    return { accepted: true, scored: false, events };
  }
  if (!scoringBlocked && ["countdown", "racing", "lost_tracking", "invalid"].includes(session.state)) {
    events.push(...maybePromote(session, now, ghost));
    if (!session.result) events.push(...updateTiming(session, observed, timing.timingMs, ghost, now));
  }
  events.push({
    type: "servo.sample_accepted",
    sequence: sample.sequence,
    servoId: sample.servoId,
    role: sample.role,
    sourceTimeMs: sample.sourceTimeMs,
    receivedAtMs: now,
    u: observed.u,
    lateral: observed.lateral,
    tracking,
    raw: sample.rawRetained ? sample.raw : null,
    at: now,
  });
  session.updatedAt = now;
  refreshInstructions(session);
  return { accepted: true, scored: session.lap.active && !session.result, events };
}

function updateTracking(session, tracking, now, ghost, events) {
  if (tracking === "lost") {
    if (session.trackingLostAt == null) session.trackingLostAt = now;
  } else {
    session.trackingLostAt = null;
    if (session.state === "lost_tracking" && !session.result) pushTransition(events, session, "racing", "tracking_recovered", now);
  }
  session.tracking = tracking;
  if (session.state === "racing" && tracking === "lost" && session.lap.active) {
    pushTransition(events, session, "lost_tracking", "tracking_lost", now);
  }
  if (session.lap.active && session.trackingLostAt != null && now - session.trackingLostAt > session.trackingGraceMs && !session.lap.invalid && !session.result) {
    events.push(...invalidate(session, "tracking_loss", now, ghost));
  }
}

function updateTiming(session, observed, timingMs, ghost, now) {
  const events = [];
  if (session.result) return events;
  const rules = session.rules;
  const progress = observed.u;
  if (session.lap.lastU == null) {
    session.lap.lastU = progress;
    session.lap.lastTimingMs = timingMs;
    events.push(...applyTrackLimit(session, observed, timingMs, ghost));
    return events;
  }
  const previousU = session.lap.lastU;
  const previousMs = session.lap.lastTimingMs;
  const raw = progress - previousU;
  let forward = raw;
  let wrapped = false;
  let discontinuity = false;
  if (raw < -0.5) {
    forward = raw + 1;
    wrapped = true;
  } else if (raw > 0.5) discontinuity = true;
  const gapMs = timingMs - previousMs;
  const gapTooLarge = gapMs > rules.maxGapMs;
  if (discontinuity || (gapTooLarge && Math.abs(raw) > rules.maxForwardJump) || (!wrapped && forward > rules.maxForwardJump)) {
    session.quality.falseCrossings += 1;
    events.push({ type: "timing.false_crossing", reason: discontinuity ? "progress_jump" : gapTooLarge ? "sample_gap" : "forward_jump", at: timingMs });
    session.lap.lastU = progress;
    session.lap.lastTimingMs = timingMs;
    return events;
  }
  if (forward > 0) {
    session.lap.progress += forward;
    if (!session.lap.crossArmed) {
      session.lap.progressSinceCross += forward;
      if (session.lap.progressSinceCross >= rules.postCrossLatchProgress) session.lap.crossArmed = true;
    }
  }
  const lineCross = wrapped && previousU > rules.lineHighU && progress < rules.lineLowU;
  if (lineCross && gapTooLarge) {
    session.quality.falseCrossings += 1;
    events.push({ type: "timing.false_crossing", reason: "crossing_gap", at: timingMs });
  } else if (lineCross && !session.lap.crossArmed) {
    session.quality.falseCrossings += 1;
    events.push({ type: "timing.false_crossing", reason: "latch", at: timingMs });
  } else if (lineCross) {
    const fraction = (1 - previousU) / (forward || 1);
    const crossMs = previousMs + gapMs * fraction;
    events.push(...onLineCross(session, previousU, crossMs, ghost, now));
  } else if (session.lap.active && forward > 0) {
    events.push(...advanceSectors(session, previousU, progress, previousMs, timingMs));
  }
  if (!session.result) events.push(...applyTrackLimit(session, observed, timingMs, ghost));
  session.lap.lastU = progress;
  session.lap.lastTimingMs = timingMs;
  return events;
}

function onLineCross(session, previousU, crossMs, ghost, now) {
  const events = [];
  if (session.state !== "racing" && session.state !== "lost_tracking" && session.state !== "invalid") return events;
  session.lap.crossArmed = false;
  session.lap.progressSinceCross = 0;
  if (!session.lap.active) {
    startLap(session, crossMs, now, events, "line_cross");
    return events;
  }
  if (session.lap.progress < session.rules.minLapProgress) {
    session.quality.falseCrossings += 1;
    events.push({ type: "timing.false_crossing", reason: "early_cross", at: crossMs });
    return events;
  }
  events.push(...advanceSectors(session, previousU, 1, session.lap.lastTimingMs, crossMs));
  if (session.lap.invalid && session.rules.finishImmediately) return events;
  if (session.lap.sectorIndex < session.rules.sectorEnds.length) {
    events.push(...invalidate(session, "missed_sector", crossMs, ghost));
    return events;
  }
  if (session.lap.invalid) {
    events.push(...publish(session, finishPayload(session, crossMs, ghost, "invalid", session.lap.invalid.reason), now));
    pushTransition(events, session, "invalid", "lap_complete", now);
    return events;
  }
  const finalSectorMs = Math.max(0, Math.round(crossMs - session.lap.sectorStartedAtMs));
  session.lap.sectorTimesMs = alignSectorTimes([...session.lap.sectorTimesMs, finalSectorMs], Math.round(crossMs - session.lap.startedAtMs));
  const lapMs = Math.round(crossMs - session.lap.startedAtMs);
  const bossMs = bossTimeMs(session);
  const deltaMs = lapMs - bossMs;
  let outcome = "behind_boss";
  if (deltaMs === 0) outcome = "tie";
  else if (deltaMs < 0) outcome = "beat_boss";
  events.push(...publish(session, {
    outcome,
    reason: null,
    lapId: session.lap.id,
    lapTimeMs: lapMs,
    bossTimeMs: bossMs,
    deltaMs,
    sectorTimesMs: session.lap.sectorTimesMs,
    sectorDeltaMs: sectorDeltas(session, ghost),
    completedAt: now,
    difficulty: session.difficulty,
    driver: session.driver,
    timingSource: "interpolated_line",
  }, now));
  pushTransition(events, session, "result", "lap_complete", now);
  return events;
}

function alignSectorTimes(times, lapMs) {
  if (!times.length || !Number.isFinite(lapMs)) return times;
  const next = [...times];
  let drift = lapMs - next.reduce((sum, time) => sum + time, 0);
  for (let index = next.length - 1; index >= 0 && drift !== 0; index -= 1) {
    const updated = next[index] + drift;
    if (updated >= 0) {
      next[index] = updated;
      drift = 0;
    } else {
      drift += next[index];
      next[index] = 0;
    }
  }
  return next;
}

function startLap(session, startedAtMs, now, events, reason) {
  session.lap.id = `lap_${session.id}_${session.attemptNumber}`;
  session.lap.active = true;
  session.lap.awaitingStart = false;
  session.lap.startedAtMs = startedAtMs;
  session.lap.sectorIndex = 0;
  session.lap.sectorStartedAtMs = startedAtMs;
  session.lap.sectorTimesMs = [];
  session.lap.progress = 0;
  session.lap.invalid = null;
  session.watchArmedAt = now;
  session.sawSampleThisAttempt = true;
  const next = session.tracking === "lost" ? "lost_tracking" : "racing";
  pushTransition(events, session, next, reason, now);
  events.push({ type: "timing.lap_started", lapId: session.lap.id, at: startedAtMs, reason });
  events.push({ type: "race.started", startMode: session.startMode, attempt: session.attemptNumber, at: now });
}

function advanceSectors(session, fromU, toU, fromMs, toMs) {
  if (!session.lap.active || session.result || !(toU > fromU)) return [];
  const events = [];
  for (const boundary of session.rules.sectorEnds) {
    if (boundary <= fromU || boundary > toU) continue;
    if (session.lap.sectorIndex >= session.rules.sectorEnds.length) break;
    const fraction = (boundary - fromU) / (toU - fromU);
    const crossMs = fromMs + (toMs - fromMs) * fraction;
    const duration = Math.max(0, Math.round(crossMs - session.lap.sectorStartedAtMs));
    session.lap.sectorTimesMs = [...session.lap.sectorTimesMs, duration];
    session.lap.sectorIndex += 1;
    session.lap.sectorStartedAtMs = crossMs;
    events.push({ type: "timing.sector_crossed", sector: session.lap.sectorIndex, durationMs: duration, at: crossMs });
  }
  return events;
}

function applyTrackLimit(session, observed, timingMs, ghost) {
  if (!session.lap.active || session.lap.invalid || session.result) return [];
  if (observed.lateral == null || observed.lateral <= session.trackLimit) return [];
  return invalidate(session, "track_limits", timingMs, ghost);
}

function invalidate(session, reason, atMs, ghost) {
  if (session.result || session.lap.invalid) return [];
  session.lap.invalid = { reason, atMs };
  const events = [{ type: "lap.invalidated", reason, at: atMs, lapId: session.lap.id }];
  if (session.rules.finishImmediately) {
    events.push(...publish(session, finishPayload(session, atMs, ghost, "invalid", reason), atMs));
    pushTransition(events, session, "invalid", reason, atMs);
  } else if (session.state !== "invalid") {
    pushTransition(events, session, "invalid", reason, atMs);
  }
  return events;
}

function finishPayload(session, atMs, ghost, outcome, reason) {
  const lapMs = session.lap.startedAtMs == null ? null : Math.max(0, Math.round(atMs - session.lap.startedAtMs));
  return {
    outcome,
    reason,
    lapId: session.lap.id,
    lapTimeMs: lapMs,
    bossTimeMs: bossTimeMs(session),
    deltaMs: lapMs == null ? null : lapMs - bossTimeMs(session),
    sectorTimesMs: session.lap.sectorTimesMs,
    sectorDeltaMs: ghost ? sectorDeltas(session, ghost) : [],
    completedAt: atMs,
    difficulty: session.difficulty,
    driver: session.driver,
    timingSource: "attempt_closed",
  };
}

function sectorDeltas(session, ghost) {
  return session.lap.sectorTimesMs.map((time, index) => {
    const reference = ghost.sectors[index]?.durationMs;
    if (reference == null) return null;
    return time - Math.round(reference * session.bossLapFactor);
  });
}

function publish(session, result, now) {
  session.result = result;
  session.lap.active = false;
  session.completedAttempts += 1;
  return [{ type: "score.published", result, at: now }, { type: "timing.lap_completed", result, at: now }];
}

function voidForOffline(session, ghost, now, events, cause) {
  if (!session.result) events.push(...publish(session, finishPayload(session, now, ghost, "dnf", "offline"), now));
  session.offlineCause = cause;
  session.feedStatus = "stale";
  pushTransition(events, session, "offline", "offline", now);
  events.push({ type: "race.offline", cause, at: now });
}

export function tickSession(session, ghost, now) {
  const events = [];
  events.push(...maybePromote(session, now, ghost));
  if (session.lap.active && session.tracking === "lost" && session.trackingLostAt != null && now - session.trackingLostAt > session.trackingGraceMs && !session.result) {
    events.push(...invalidate(session, "tracking_loss", now, ghost));
  }
  const openWatch = !session.result && session.watchArmedAt != null && ["racing", "lost_tracking", "hold"].includes(session.state);
  if (openWatch) {
    const since = session.sawSampleThisAttempt ? session.lastHumanSampleAt : session.watchArmedAt;
    if (since != null && now - since > session.rules.offlineAfterMs) voidForOffline(session, ghost, now, events, "attempt_void");
  }
  if (session.state === "intake" && session.intakeSampleAt != null && now - session.intakeSampleAt > session.rules.offlineAfterMs) {
    session.stateBeforeOffline = "intake";
    session.offlineCause = "feed";
    session.feedStatus = "stale";
    pushTransition(events, session, "offline", "feed_lost", now);
    events.push({ type: "race.offline", cause: "feed", at: now });
  }
  if (session.stagedDeadline != null && now > session.stagedDeadline && session.state === "countdown" && !session.lap.active) {
    events.push(...publish(session, finishPayload(session, now, ghost, "dnf", "not_on_grid"), now));
    pushTransition(events, session, "result", "not_on_grid", now);
  }
  if (events.length) {
    session.updatedAt = now;
    refreshInstructions(session);
  }
  return events;
}

function maybePromote(session, now, ghost) {
  const events = [];
  if (session.state !== "countdown" || session.countdownEndsAt == null || now < session.countdownEndsAt) return events;
  if (session.startMode === "flying") {
    pushTransition(events, session, session.tracking === "lost" ? "lost_tracking" : "racing", "countdown_complete", now);
    session.watchArmedAt = now;
    session.sawSampleThisAttempt = false;
    events.push({ type: "race.armed", startMode: "flying", at: now });
    return events;
  }
  if (session.stagedDeadline == null) session.stagedDeadline = session.countdownEndsAt + session.rules.stagedWaitMs;
  const gateProgress = session.lap.lastU ?? session.gateProgress;
  if (inGate(gateProgress, session.rules)) {
    startLap(session, Math.max(session.countdownEndsAt, now), now, events, "staged_gate");
    return events;
  }
  if (session.holdReason !== "not_on_grid") {
    session.holdReason = "not_on_grid";
    events.push({ type: "race.waiting_for_gate", at: now });
  }
  return events;
}

export function advisorySetpoint(session, ghost) {
  if (!session.rules.egressEnabled || !ghost) return null;
  const progress = session.lastObservation?.u ?? 0;
  let profile = ghost.profile.samples[0] ?? null;
  for (const sample of ghost.profile.samples) {
    if (sample.u <= progress) profile = sample;
    else break;
  }
  return {
    mode: "advisory-only",
    execution: "advisory-visible",
    hold: session.safetyHold,
    targetSpeedKmh: profile?.targetSpeedKmh ?? null,
    targetThrottle: profile?.targetThrottle ?? null,
    targetBrake: profile?.targetBrake ?? null,
    units: ghost.profile.units,
  };
}

export function projectSnapshot(session, ghost, now, extras = {}) {
  const lapElapsed = session.lap.active && session.lap.startedAtMs != null ? Math.max(0, now - session.lap.startedAtMs) : session.result?.lapTimeMs ?? null;
  const driverU = session.lastObservation?.u ?? null;
  let provisionalDeltaMs = null;
  if (session.lap.active && driverU != null && session.lap.startedAtMs != null && ghost) {
    const expected = timeAtU(ghost.samples, ghost.lapDurationSeconds, driverU) * 1000 * session.bossLapFactor;
    provisionalDeltaMs = Math.round(lapElapsed - expected);
  }
  let ghostProgressU = 0;
  if (session.lap.active && session.lap.startedAtMs != null && ghost) {
    const recordedSeconds = Math.max(0, now - session.lap.startedAtMs) / 1000 / session.bossLapFactor;
    ghostProgressU = sampleAtTime(ghost.samples, ghost.lapDurationSeconds, recordedSeconds).u;
  }
  const phase = session.state === "racing" && !session.lap.active ? "awaiting_line" : session.state;
  return {
    schemaVersion: 1,
    sessionId: session.id,
    circuitId: session.circuitId,
    circuitName: session.circuitName,
    ghostId: session.ghostId,
    state: session.state,
    phase,
    banner: bannerFor(session, phase),
    tracking: session.tracking,
    feedStatus: session.feedStatus,
    humanServoId: session.humanServoId,
    driver: session.driver ? { id: session.driver.id, name: session.driver.name } : null,
    queue: session.queue.map((driver) => driver.name),
    difficulty: session.difficulty,
    bossLapFactor: session.bossLapFactor,
    startMode: session.startMode,
    calibrationId: session.calibrationId,
    instructions: session.instructions,
    safetyHold: session.safetyHold,
    holdReason: session.holdReason,
    lastTransition: session.lastTransition,
    attemptNumber: session.attemptNumber,
    lap: {
      id: session.lap.id,
      active: session.lap.active,
      elapsedMs: lapElapsed,
      sectorIndex: session.lap.active ? session.lap.sectorIndex + 1 : session.lap.sectorTimesMs.length,
      sectorTimesMs: session.lap.sectorTimesMs,
      progressU: driverU,
      provisionalDeltaMs,
      invalid: session.lap.invalid,
    },
    ghost: {
      progressU: ghostProgressU,
      lapTimeMs: bossTimeMs(session),
      referenceLapMs: session.recordedLapMs,
    },
    result: session.result,
    display: {
      lap: formatDuration(lapElapsed),
      delta: provisionalDeltaMs == null ? formatDuration(session.result?.deltaMs) : formatDuration(provisionalDeltaMs),
      boss: formatDuration(bossTimeMs(session)),
      best: formatDuration(extras.personalBestMs),
    },
    quality: session.quality,
    advisorySetpoint: advisorySetpoint(session, ghost),
    personalBestMs: extras.personalBestMs ?? null,
    leaderboardPreview: extras.leaderboardPreview ?? [],
    serverTimeMs: now,
  };
}

function bannerFor(session, phase) {
  if (session.state === "offline") return "OFFLINE";
  if (session.state === "hold") return "HOLD";
  if (session.state === "lost_tracking") return "LOST TRACKING";
  if (session.state === "invalid" || session.result?.outcome === "invalid") return "INVALID LAP";
  if (session.result?.outcome === "dnf") return "DNF";
  if (session.result?.outcome === "beat_boss") return "BEAT THE GRID";
  if (session.result?.outcome === "behind_boss") return "BEHIND THE BOSS";
  if (session.result?.outcome === "tie") return "LEVEL";
  if (phase === "awaiting_line") return "CROSS THE LINE";
  if (session.state === "countdown") return "COUNTDOWN";
  if (session.state === "racing") return "RACING";
  if (session.state === "intake") return "INTAKE";
  return String(session.state).toUpperCase();
}

export function isLeaderboardResult(result) {
  return Boolean(result) && ["beat_boss", "behind_boss", "tie"].includes(result.outcome) && Number.isFinite(result.lapTimeMs);
}

export function voidRecoveredSession(session, now) {
  const open = ["countdown", "racing", "lost_tracking", "hold"].includes(session.state) || session.lap?.active;
  if (!open) return false;
  session.result = {
    outcome: "dnf",
    reason: "process_restart",
    lapId: session.lap?.id ?? null,
    lapTimeMs: null,
    bossTimeMs: bossTimeMs(session),
    deltaMs: null,
    sectorTimesMs: session.lap?.sectorTimesMs ?? [],
    sectorDeltaMs: [],
    completedAt: now,
    difficulty: session.difficulty,
    driver: session.driver,
    timingSource: "process_restart",
  };
  session.lap = { ...emptyLap(), invalid: { reason: "process_restart", atMs: now } };
  session.state = "offline";
  session.offlineCause = "attempt_void";
  session.feedStatus = "stale";
  session.instructions = "Session recovered after a restart. Reset before the next attempt.";
  session.lastTransition = { from: "recovered", to: "offline", reason: "process_restart", at: now };
  session.updatedAt = now;
  return true;
}
