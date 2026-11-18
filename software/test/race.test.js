import assert from "node:assert/strict";
import test from "node:test";
import { isLeaderboardResult } from "../src/race.js";
import { lapSamples, openSession, testApp, feed } from "./helpers.js";

async function runLap(options = {}) {
  const { app, clock } = await testApp();
  const created = await openSession(app, options.session);
  await app.command(created.sessionId, { type: "register-driver", name: options.name ?? "Ada Lovelace" });
  if (options.difficulty) await app.command(created.sessionId, { type: "set-difficulty", difficulty: options.difficulty });
  clock.set(1_700_000_000_000);
  await app.command(created.sessionId, { type: "start", countdownMs: 0 });
  clock.set(1_700_000_000_001);
  await app.tick(clock.now());
  const snap = (await feed(app, created.sessionId, lapSamples({ lapMs: options.lapMs ?? 4000, sequenceStart: 1, ...options.samples }))) .at(-1).snapshot;
  return { app, clock, snap, sessionId: created.sessionId };
}

test("a matched flying lap ties the boss and lands on the leaderboard", async () => {
  const { app, snap } = await runLap();
  assert.equal(snap.state, "result");
  assert.equal(snap.result.outcome, "tie");
  assert.equal(snap.result.lapTimeMs, 4000);
  assert.equal(snap.result.deltaMs, 0);
  assert.equal(snap.result.sectorTimesMs.length, 3);
  assert.equal(snap.result.sectorTimesMs.reduce((sum, time) => sum + time, 0), 4000);
  const board = await app.leaderboard({ circuitId: "circle" });
  assert.equal(board.length, 1);
  assert.equal(board[0].driverName, "Ada Lovelace");
  assert.equal(isLeaderboardResult(snap.result), true);
});

test("difficulty changes the boss time without changing the recorded lap", async () => {
  const rookie = await runLap({ difficulty: "rookie" });
  assert.equal(rookie.snap.result.outcome, "beat_boss");
  assert.equal(rookie.snap.result.bossTimeMs, 4480);
  assert.equal(rookie.snap.result.deltaMs, -480);
  const boss = await runLap({ difficulty: "boss" });
  assert.equal(boss.snap.result.outcome, "behind_boss");
  assert.equal(boss.snap.result.bossTimeMs, 3880);
  assert.equal(boss.snap.result.deltaMs, 120);
});

test("case-insensitive names share a personal best", async () => {
  const { app, clock } = await testApp();
  const created = await openSession(app);
  await app.command(created.sessionId, { type: "register-driver", name: "Ada Lovelace" });
  clock.set(1_700_000_000_000);
  await app.command(created.sessionId, { type: "start", countdownMs: 0 });
  await app.tick(1_700_000_000_001);
  await feed(app, created.sessionId, lapSamples());
  await app.command(created.sessionId, { type: "reset" });
  await app.command(created.sessionId, { type: "register-driver", name: "ada lovelace" });
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 1_700_000_010_000);
  await app.tick(1_700_000_010_001);
  const second = await feed(app, created.sessionId, lapSamples({ startMs: 1_700_000_010_100, sequenceStart: 100, lapMs: 4800 }));
  assert.equal(second.at(-1).snapshot.personalBestMs, 4000);
  assert.equal((await app.leaderboard()).length, 2);
});

test("track limits, tracking loss, and offline are visible and not ranked", async () => {
  const { app, clock } = await testApp();
  const created = await openSession(app);
  await app.command(created.sessionId, { type: "register-driver", name: "Bo" });
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 1_700_000_000_000);
  await app.tick(1_700_000_000_001);
  const start = lapSamples().slice(0, 4);
  await feed(app, created.sessionId, start);
  const off = await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "servo-human-1", role: "human", sequence: 5, sourceTimeMs: start.at(-1).sourceTimeMs + 100, clock: "epoch", x: 12, y: 0, lock: true, quality: 1 }], start.at(-1).sourceTimeMs + 100);
  assert.equal(off.snapshot.state, "invalid");
  assert.equal(off.snapshot.banner, "INVALID LAP");
  assert.equal(off.snapshot.result.reason, "track_limits");
  assert.equal((await app.leaderboard()).length, 0);

  await app.command(created.sessionId, { type: "reset" });
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, off.snapshot.serverTimeMs + 10);
  await app.tick(off.snapshot.serverTimeMs + 11);
  const lost = await feed(app, created.sessionId, lapSamples({ startMs: off.snapshot.serverTimeMs + 20, sequenceStart: 20, unlockAtU: 0.3 }));
  assert.equal(lost.at(-1).snapshot.state, "invalid");
  assert.equal(lost.at(-1).snapshot.result.reason, "tracking_loss");

  await app.command(created.sessionId, { type: "reset" });
  const armed = lost.at(-1).snapshot.serverTimeMs + 50;
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, armed);
  await app.tick(armed + 1);
  await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "servo-human-1", role: "human", sequence: 80, sourceTimeMs: armed + 1, clock: "epoch", progress: 0.5, lock: true }], armed + 1);
  const dead = (await app.tick(armed + 1 + 1501))[0];
  assert.equal(dead.state, "offline");
  assert.equal(dead.result.reason, "offline");
  assert.equal(dead.banner, "OFFLINE");
});

test("false crossings do not award a lap, and reset returns to intake", async () => {
  const { app } = await testApp();
  const created = await openSession(app);
  await app.command(created.sessionId, { type: "register-driver", name: "Cy" });
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 1000);
  await app.tick(1001);
  await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 1, sourceTimeMs: 1100, clock: "epoch", progress: 0.2, lock: true }], 1100);
  const jump = await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 2, sourceTimeMs: 1200, clock: "epoch", progress: 0.9, lock: true }], 1200);
  assert.equal(jump.snapshot.quality.falseCrossings, 1);
  assert.equal(jump.snapshot.state, "racing");
  const reset = await app.command(created.sessionId, { type: "reset" }, 1300);
  assert.equal(reset.state, "intake");
  assert.equal(reset.lastTransition.reason, "reset");
  assert.equal(reset.banner, "INTAKE");
});

test("illegal commands and duplicate servo sequences are rejected", async () => {
  const { app } = await testApp();
  const created = await openSession(app);
  await assert.rejects(app.command(created.sessionId, { type: "start" }), /intake/);
  await app.command(created.sessionId, { type: "register-driver", name: "Dee" });
  await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 3, sourceTimeMs: 10, clock: "epoch", progress: 0.1 }], 10);
  const duplicate = await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 3, sourceTimeMs: 11, clock: "epoch", progress: 0.1 }], 11);
  assert.equal(duplicate.results[0].accepted, false);
  assert.equal(duplicate.results[0].rejection.code, "duplicate_sequence");
  const gap = await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 6, sourceTimeMs: 12, clock: "epoch", progress: 0.1 }], 12);
  assert.equal(gap.snapshot.quality.sequenceGaps, 2);
  await app.command(created.sessionId, { type: "set-servo", servoId: "expected" });
  const foreign = await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "other", role: "human", sequence: 1, sourceTimeMs: 13, clock: "epoch", progress: 0.2 }], 13);
  assert.equal(foreign.results[0].rejection.code, "foreign_servo");
});

test("staged start waits for the gate and can be held without rewriting the lap", async () => {
  const { app } = await testApp();
  const created = await openSession(app, { startMode: "staged" });
  await app.command(created.sessionId, { type: "register-driver", name: "Eve" });
  await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 1, sourceTimeMs: 1000, clock: "epoch", progress: 0.4, lock: true }], 1000);
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 1000);
  const waiting = (await app.tick(1001))[0];
  assert.equal(waiting.holdReason, "not_on_grid");
  const missed = (await app.tick(1001 + 15000 + 1))[0];
  assert.equal(missed.result.reason, "not_on_grid");
  await app.command(created.sessionId, { type: "reset" }, 20000);
  await app.ingest(created.sessionId, [{ schemaVersion: 1, servoId: "s", role: "human", sequence: 2, sourceTimeMs: 20100, clock: "epoch", progress: 0.01, lock: true }], 20100);
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 20100);
  const started = (await app.tick(20101))[0];
  assert.equal(started.lap.active, true);
  assert.equal(started.state, "racing");
  const held = await app.command(created.sessionId, { type: "hold" }, 20200);
  assert.equal(held.state, "hold");
  const released = await app.command(created.sessionId, { type: "release" }, 20300);
  assert.equal(released.result.reason, "operator_hold");
  assert.equal((await app.leaderboard()).length, 0);
});

test("continuing an invalid lap is available when immediate finish is off", async () => {
  const { app } = await testApp();
  const created = await openSession(app, { finishImmediately: false });
  await app.command(created.sessionId, { type: "register-driver", name: "Faye" });
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 1000);
  await app.tick(1001);
  const samples = lapSamples({ startMs: 1100 });
  await feed(app, created.sessionId, samples.slice(0, 4));
  const marked = await app.command(created.sessionId, { type: "invalidate", reason: "operator" }, samples[3].sourceTimeMs);
  assert.equal(marked.state, "invalid");
  assert.equal(marked.result, null);
  const done = (await feed(app, created.sessionId, samples.slice(4))).at(-1).snapshot;
  assert.equal(done.state, "invalid");
  assert.equal(done.result.outcome, "invalid");
  assert.equal(done.result.reason, "operator");
});

test("advisory egress stays hidden until a human enables it", async () => {
  const { app } = await testApp();
  const created = await openSession(app);
  assert.equal(created.advisorySetpoint, null);
  const session = app.getSession(created.sessionId);
  session.rules.egressEnabled = true;
  const shown = await app.snapshot(created.sessionId);
  assert.equal(shown.advisorySetpoint.mode, "advisory-only");
  assert.equal(shown.advisorySetpoint.execution, "advisory-visible");
});
