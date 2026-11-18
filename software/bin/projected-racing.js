#!/usr/bin/env node
import crypto from "node:crypto";
import { loadCalibrations, loadConfig, resolveRepoPath } from "../src/config.js";
import { createClock, systemClock } from "../src/clock.js";
import { createApp } from "../src/app.js";
import { createServer } from "../src/server.js";
import { createFileStore, createMemoryStore } from "../src/store.js";

function ids() {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` };
}

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function help() {
  console.log(`projected-racing

  serve [--port 8787] [--data-dir var/racing]
  recompute-ghosts [--data-dir var/racing]
  simulate --circuit monza [--driver "Ada Lovelace"] [--difficulty grid]
  help

The server binds to 127.0.0.1 unless software/config/default.json changes it.
Live car data is accepted only as servo samples. See docs/SERVO_CONTRACT.md.
`);
}

async function makeApp({ memory = false, clock = systemClock() } = {}) {
  const config = loadConfig();
  const dataDir = resolveRepoPath(flag("data-dir", config.dataDir));
  const store = memory ? createMemoryStore() : createFileStore(dataDir);
  const app = await createApp({
    config,
    store,
    calibrations: loadCalibrations(),
    clock,
    ids: ids(),
    logger: { error: console.error, info: console.error, debug() {} },
    telemetryDir: resolveRepoPath(config.telemetryDir),
  });
  await app.recomputeGhosts();
  if (!memory) await app.hydrate();
  return { app, config, store };
}

const command = process.argv[2] ?? "help";
if (command === "help" || command === "--help") {
  help();
} else if (command === "serve") {
  const { app, config } = await makeApp();
  if (flag("port")) config.server.port = Number(flag("port"));
  const server = createServer(app, config);
  const address = await server.listen();
  console.error(`Projected Racing listening on http://${config.server.host}:${address.port}`);
} else if (command === "recompute-ghosts") {
  const { app } = await makeApp();
  console.log(JSON.stringify(app.listCircuits(), null, 2));
  await app.close();
} else if (command === "simulate") {
  const circuit = flag("circuit", "monza");
  const clock = createClock(1_700_000_000_000);
  const { app } = await makeApp({ memory: true, clock });
  const created = await app.createSession({ circuitId: circuit, difficulty: flag("difficulty", "grid") });
  const snap = await app.simulate(created.sessionId, { driverName: flag("driver", "Sim Driver"), countdownMs: 0, lapFactor: Number(flag("lap-factor", "1")) });
  console.log(JSON.stringify({ state: snap.state, banner: snap.banner, result: snap.result, quality: snap.quality }, null, 2));
  await app.close();
} else {
  console.error(`Unknown command: ${command}`);
  help();
  process.exitCode = 1;
}
