import { AppError } from "./errors.js";
import { difficultyOrThrow } from "./config.js";
import { buildGhostFromRecorded, loadTelemetryDirectory } from "./ghost.js";
import { EVENT_TYPES } from "./events.js";
import {
  applyCommand,
  applySample,
  createSessionState,
  driverKey,
  isLeaderboardResult,
  noteRejection,
  projectSnapshot,
  tickSession,
  voidRecoveredSession,
} from "./race.js";
import { validateServoSample } from "./schema.js";
import { flyingLapSamples } from "./simulate.js";

function rulesFrom(config) {
  return {
    offlineAfterMs: config.servo.offlineAfterMs,
    lockQualityMin: config.servo.lockQualityMin,
    maxSampleDelayMs: config.servo.maxSampleDelayMs,
    staleSourceReverseMs: config.servo.staleSourceReverseMs,
    lineHighU: config.timing.lineHighU,
    lineLowU: config.timing.lineLowU,
    minLapProgress: config.timing.minLapProgress,
    postCrossLatchProgress: config.timing.postCrossLatchProgress,
    maxForwardJump: config.timing.maxForwardJump,
    maxGapMs: config.timing.maxGapMs,
    startGateU: config.timing.startGateU,
    stagedWaitMs: config.timing.stagedWaitMs,
    countdownMs: config.countdownMs,
    finishImmediately: config.invalidation.finishImmediately,
    egressEnabled: config.safety.egressEnabled,
    sectorEnds: [...config.sectors.ends],
  };
}

export async function createApp(options) {
  const config = options.config;
  const store = options.store;
  const calibrations = options.calibrations;
  const clock = options.clock;
  const ids = options.ids;
  const logger = options.logger ?? { error() {}, info() {}, debug() {} };
  const ghosts = new Map();
  const sessions = new Map();
  const listeners = new Set();
  const metrics = { sessionsCreated: 0, samplesAccepted: 0, samplesRejected: 0, lapsScored: 0, falseCrossings: 0 };
  let chain = Promise.resolve();

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function requireSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new AppError("unknown_session", `Unknown session: ${sessionId}`, 404);
    return session;
  }

  function ghostFor(session) {
    return ghosts.get(session.ghostId) ?? null;
  }

  function calibrationFor(session) {
    return calibrations.get(session.calibrationId) ?? calibrations.get("identity-v1");
  }

  async function persist(session, events) {
    const recordedAt = clock.now();
    for (const event of events) {
      if (!EVENT_TYPES.includes(event.type)) logger.error(`undeclared event type ${event.type}`);
      const envelope = {
        eventId: ids.next("evt"),
        type: event.type,
        schemaVersion: 1,
        occurredAt: event.at ?? recordedAt,
        recordedAt,
        sessionId: session.id,
        payload: event,
      };
      await store.appendEvent(session.id, envelope);
      if (event.type === "score.published") await recordScore(session, event.result);
      if (event.type === "timing.false_crossing") metrics.falseCrossings += 1;
    }
    await store.saveRecord("sessions", session.id, session);
  }

  async function recordScore(session, result) {
    metrics.lapsScored += 1;
    const attempt = {
      id: result.lapId ?? ids.next("att"),
      sessionId: session.id,
      circuitId: session.circuitId,
      driverName: result.driver?.name ?? null,
      driverKey: result.driver?.key ?? driverKey(result.driver?.name ?? ""),
      difficulty: result.difficulty,
      outcome: result.outcome,
      reason: result.reason,
      lapTimeMs: result.lapTimeMs,
      bossTimeMs: result.bossTimeMs,
      deltaMs: result.deltaMs,
      sectorTimesMs: result.sectorTimesMs,
      completedAt: result.completedAt,
    };
    await store.saveRecord("attempts", attempt.id, attempt);
    if (isLeaderboardResult(result)) await store.saveRecord("laps", attempt.id, attempt);
  }

  async function personalBest(session) {
    if (!session.driver) return null;
    const laps = await store.listRecords("laps");
    const mine = laps.filter((lap) => lap.circuitId === session.circuitId && lap.difficulty === session.difficulty && lap.driverKey === session.driver.key);
    if (mine.length === 0) return null;
    return Math.min(...mine.map((lap) => lap.lapTimeMs));
  }

  async function leaderboard({ circuitId, difficulty } = {}) {
    const laps = await store.listRecords("laps");
    return laps
      .filter((lap) => (circuitId ? lap.circuitId === circuitId : true) && (difficulty ? lap.difficulty === difficulty : true))
      .sort((left, right) => left.lapTimeMs - right.lapTimeMs || left.completedAt - right.completedAt || left.driverName.localeCompare(right.driverName))
      .map((lap, index) => ({ rank: index + 1, ...lap }));
  }

  async function snapshot(sessionId, now = clock.now()) {
    const session = requireSession(sessionId);
    const board = await leaderboard({ circuitId: session.circuitId, difficulty: session.difficulty });
    return projectSnapshot(session, ghostFor(session), now, {
      personalBestMs: await personalBest(session),
      leaderboardPreview: board.slice(0, 5),
    });
  }

  function emit(sessionId, snap) {
    for (const listener of listeners) listener(sessionId, snap);
  }

  async function afterMutation(session, events, now) {
    await persist(session, events);
    const snap = await snapshot(session.id, now);
    emit(session.id, snap);
    return snap;
  }

  async function recomputeGhosts(builtAt = new Date(clock.now()).toISOString()) {
    const laps = loadTelemetryDirectory(options.telemetryDir);
    const built = [];
    for (const lap of laps) {
      const ghost = buildGhostFromRecorded(lap, config, builtAt);
      await rememberGhost(ghost);
      built.push({ id: ghost.id, circuitId: ghost.circuitId, quality: ghost.lineage.cleaning.quality });
    }
    return built;
  }

  async function rememberGhost(ghost) {
    ghosts.set(ghost.id, ghost);
    ghosts.set(ghost.circuitId, ghost);
    await store.putObject(`ghosts/${ghost.circuitId}/${ghost.id}.json`, ghost);
    await store.putObject(`ghosts/${ghost.circuitId}/current.json`, { id: ghost.id, circuitId: ghost.circuitId });
  }

  function registerGhost(ghost) {
    ghosts.set(ghost.id, ghost);
    ghosts.set(ghost.circuitId, ghost);
    return ghost;
  }

  function listCircuits() {
    const seen = new Set();
    const circuits = [];
    for (const ghost of ghosts.values()) {
      if (!ghost.circuitId || seen.has(ghost.circuitId)) continue;
      seen.add(ghost.circuitId);
      circuits.push({
        id: ghost.circuitId,
        name: ghost.circuitName,
        ghostId: ghost.id,
        lapDurationSeconds: ghost.lapDurationSeconds,
        source: ghost.lineage?.source ?? null,
        fixture: Boolean(ghost.fixture),
      });
    }
    return circuits.sort((left, right) => left.id.localeCompare(right.id));
  }

  async function createSession(input, now = clock.now()) {
    const circuitId = input.circuitId;
    const ghost = ghosts.get(circuitId);
    if (!ghost) throw new AppError("unknown_circuit", `No ghost is loaded for ${circuitId}`, 404);
    const difficulty = difficultyOrThrow(config, input.difficulty ?? config.defaultDifficulty);
    const startMode = input.startMode ?? config.defaultStartMode;
    if (!["flying", "staged"].includes(startMode)) throw new AppError("invalid_command", "startMode must be flying or staged", 400);
    const calibrationId = input.calibrationId ?? "identity-v1";
    if (!calibrations.has(calibrationId)) throw new AppError("unknown_calibration", `Unknown calibration: ${calibrationId}`, 400);
    const session = createSessionState({
      id: ids.next("ses"),
      circuitId,
      circuitName: ghost.circuitName,
      ghostId: ghost.id,
      recordedLapMs: Math.round(ghost.lapDurationSeconds * 1000),
      calibrationId,
      difficulty: difficulty.name,
      bossLapFactor: difficulty.bossLapFactor,
      trackLimit: difficulty.trackLimit,
      trackingGraceMs: difficulty.trackingGraceMs,
      startMode,
      humanServoId: input.humanServoId ?? null,
      rules: rulesFrom(config),
      now,
    });
    if (input.finishImmediately != null) session.rules.finishImmediately = Boolean(input.finishImmediately);
    sessions.set(session.id, session);
    metrics.sessionsCreated += 1;
    const events = [{ type: "session.created", circuitId, ghostId: ghost.id, at: now }];
    await afterMutation(session, events, now);
    return snapshot(session.id, now);
  }

  async function command(sessionId, body, now = clock.now()) {
    const session = requireSession(sessionId);
    const context = {
      now,
      driverId: ids.next("drv"),
      ghost: ghostFor(session),
      difficulty: body.type === "set-difficulty" ? difficultyOrThrow(config, body.difficulty) : null,
    };
    if (body.type === "set-calibration" && !calibrations.has(body.calibrationId)) {
      throw new AppError("unknown_calibration", `Unknown calibration: ${body.calibrationId}`, 400);
    }
    const events = applyCommand(session, body, context);
    return afterMutation(session, events, now);
  }

  async function ingest(sessionId, inputs, now = clock.now()) {
    const session = requireSession(sessionId);
    const ghost = ghostFor(session);
    if (!ghost) throw new AppError("ghost_missing", "Session ghost is not loaded", 409);
    const batch = Array.isArray(inputs) ? inputs : [inputs];
    if (batch.length === 0 || batch.length > config.servo.maxBatch) {
      throw new AppError("invalid_batch", `A batch must contain 1 to ${config.servo.maxBatch} samples`, 400);
    }
    const results = [];
    const events = [];
    for (const input of batch) {
      const checked = validateServoSample(input, config.servo);
      if (!checked.ok) {
        noteRejection(session, { code: "invalid_servo_sample", message: checked.errors.map((error) => `${error.path}: ${error.message}`).join("; ") }, now);
        metrics.samplesRejected += 1;
        events.push({ type: "servo.sample_rejected", errors: checked.errors, at: now });
        results.push({ sequence: input?.sequence ?? null, accepted: false, rejection: session.quality.lastRejection });
        continue;
      }
      const applied = applySample(session, checked.sample, ghost, calibrationFor(session), now);
      events.push(...applied.events);
      if (applied.accepted) metrics.samplesAccepted += 1;
      else metrics.samplesRejected += 1;
      results.push({ sequence: checked.sample.sequence, accepted: applied.accepted, rejection: applied.rejection ?? null });
    }
    const snap = await afterMutation(session, events, now);
    return { results, snapshot: snap };
  }

  async function tick(now = clock.now()) {
    const snaps = [];
    for (const session of sessions.values()) {
      const events = tickSession(session, ghostFor(session), now);
      if (events.length) snaps.push(await afterMutation(session, events, now));
    }
    return snaps;
  }

  async function hydrate() {
    const saved = await store.listRecords("sessions");
    for (const session of saved) {
      if (voidRecoveredSession(session, clock.now())) await store.saveRecord("sessions", session.id, session);
      if (!ghosts.has(session.ghostId)) {
        session.state = "fault";
        session.instructions = "Ghost is unavailable. Recompute ghosts before continuing.";
      }
      sessions.set(session.id, session);
    }
  }

  async function simulate(sessionId, options = {}) {
    let now = options.startAt ?? clock.now();
    const existing = requireSession(sessionId);
    if (!existing.driver) {
      await command(sessionId, { type: "register-driver", name: options.driverName ?? "Sim Driver" }, now);
    }
    if (options.difficulty) await command(sessionId, { type: "set-difficulty", difficulty: options.difficulty }, now);
    await command(sessionId, { type: "start", countdownMs: options.countdownMs ?? 0 }, now);
    now += 1;
    await tick(now);
    const session = requireSession(sessionId);
    const ghost = ghostFor(session);
    const servoId = options.servoId ?? session.humanServoId ?? "servo-human-1";
    const samples = flyingLapSamples({
      lapMs: Math.round(ghost.lapDurationSeconds * 1000 * (options.lapFactor ?? 1)),
      startMs: now + 1,
      servoId,
      sequenceStart: (session.sequences[servoId] ?? 0) + 1,
      unlockAtU: options.unlockAtU ?? null,
      gapAtU: options.gapAtU ?? null,
      maxGapMs: session.rules.maxGapMs,
    });
    for (const sample of samples) {
      now = sample.sourceTimeMs;
      await ingest(sessionId, [sample], now);
    }
    await tick(now);
    return snapshot(sessionId, now);
  }

  return {
    enqueue,
    async recomputeGhosts() { return enqueue(() => recomputeGhosts()); },
    registerGhost,
    listCircuits,
    async createSession(input, now) { return enqueue(() => createSession(input, now)); },
    async command(sessionId, body, now) { return enqueue(() => command(sessionId, body, now)); },
    async ingest(sessionId, samples, now) { return enqueue(() => ingest(sessionId, samples, now)); },
    async tick(now) { return enqueue(() => tick(now)); },
    async snapshot(sessionId, now) { return enqueue(() => snapshot(sessionId, now)); },
    async leaderboard(query) { return enqueue(() => leaderboard(query ?? {})); },
    async simulate(sessionId, options) { return enqueue(() => simulate(sessionId, options ?? {})); },
    metrics() { return { ...metrics }; },
    schema() { return { events: EVENT_TYPES }; },
    getSession(sessionId) { return sessions.get(sessionId) ?? null; },
    getGhost(circuitOrId) { return ghosts.get(circuitOrId) ?? null; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async hydrate() { return enqueue(() => hydrate()); },
    async close() { return enqueue(async () => store.close()); },
  };
}
