import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadCalibrations, loadConfig, resolveRepoPath } from "../src/config.js";
import { createClock } from "../src/clock.js";
import { buildGhostFromRecorded } from "../src/ghost.js";
import { createFileStore } from "../src/store.js";
import { testIds } from "./helpers.js";

test("fifty consecutive race cycles keep one leaderboard and no open lap", async () => {
  const clock = createClock(1_700_000_000_000);
  const config = loadConfig();
  const app = await createApp({
    config,
    store: (await import("../src/store.js")).createMemoryStore(),
    calibrations: loadCalibrations(),
    clock,
    ids: testIds(),
    logger: { error() {}, info() {}, debug() {} },
    telemetryDir: resolveRepoPath(config.telemetryDir),
  });
  const { buildCircleGhost } = await import("../src/ghost.js");
  app.registerGhost(buildCircleGhost());
  const created = await app.createSession({ circuitId: "circle" });
  for (let cycle = 1; cycle <= 50; cycle += 1) {
    const snap = await app.simulate(created.sessionId, { driverName: "Cycle Driver", countdownMs: 0, startAt: 1_700_000_000_000 + cycle * 100_000 });
    assert.equal(snap.result?.outcome, "tie", `cycle ${cycle} ${snap.state} ${snap.result?.reason}`);
    assert.equal(snap.result.lapTimeMs, 4000);
    assert.equal(snap.lap.active, false);
    if (cycle < 50) await app.command(created.sessionId, { type: "reset" }, snap.serverTimeMs + 1);
  }
  const board = await app.leaderboard({ circuitId: "circle" });
  assert.equal(board.length, 50);
  assert.equal(app.metrics().lapsScored, 50);
});

test("recorded Monza ghost follows through scoring and preserves lineage", async () => {
  const clock = createClock(1_700_000_000_000);
  const config = loadConfig();
  const app = await createApp({
    config,
    store: (await import("../src/store.js")).createMemoryStore(),
    calibrations: loadCalibrations(),
    clock,
    ids: testIds(),
    logger: { error() {}, info() {}, debug() {} },
    telemetryDir: resolveRepoPath(config.telemetryDir),
  });
  await app.recomputeGhosts("2026-11-17T00:00:00.000Z");
  const again = await app.recomputeGhosts("2026-11-17T01:00:00.000Z");
  assert.equal(again.find((ghost) => ghost.circuitId === "monza").id, app.getGhost("monza").id);
  const ghost = app.getGhost("monza");
  assert.equal(ghost.lineage.sessionKey, 9586);
  assert.equal(ghost.profile.maxSpeedKmh, null);
  assert.equal(ghost.sectors.length, 3);
  const created = await app.createSession({ circuitId: "monza" });
  const snap = await app.simulate(created.sessionId, { driverName: "Max Stand-in", countdownMs: 0, lapFactor: 1 });
  assert.equal(snap.result.outcome, "tie");
  assert.ok(Math.abs(snap.result.lapTimeMs - Math.round(ghost.lapDurationSeconds * 1000)) < 2, snap.result.lapTimeMs);
});

test("file storage reloads a voided in-progress session", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "projected-racing-"));
  const config = loadConfig();
  const clock = createClock(5_000);
  const store = createFileStore(directory);
  const ghost = buildGhostFromRecorded(JSON.parse(fs.readFileSync(resolveRepoPath("dist/data/monaco.json"))), config, "2026-11-17T00:00:00.000Z");
  const first = await createApp({
    config,
    store,
    calibrations: loadCalibrations(),
    clock,
    ids: testIds(),
    logger: { error() {}, info() {}, debug() {} },
    telemetryDir: resolveRepoPath(config.telemetryDir),
  });
  first.registerGhost(ghost);
  const created = await first.createSession({ circuitId: "monaco" });
  await first.command(created.sessionId, { type: "register-driver", name: "Gia" });
  await first.command(created.sessionId, { type: "start", countdownMs: 1000 });
  await first.close();
  const second = await createApp({
    config,
    store: createFileStore(directory),
    calibrations: loadCalibrations(),
    clock,
    ids: testIds(),
    logger: { error() {}, info() {}, debug() {} },
    telemetryDir: resolveRepoPath(config.telemetryDir),
  });
  second.registerGhost(ghost);
  await second.hydrate();
  const recovered = await second.snapshot(created.sessionId);
  assert.equal(recovered.state, "offline");
  assert.equal(recovered.result.reason, "process_restart");
  const events = await createFileStore(directory).readEvents(created.sessionId);
  assert.ok(events.some((event) => event.type === "race.countdown_started"));
});
