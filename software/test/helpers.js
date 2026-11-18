import { createApp } from "../src/app.js";
import { loadCalibrations, loadConfig } from "../src/config.js";
import { createClock } from "../src/clock.js";
import { buildCircleGhost } from "../src/ghost.js";
import { createMemoryStore } from "../src/store.js";
import { flyingLapSamples } from "../src/simulate.js";

export function testIds() {
  let number = 0;
  return { next: (prefix) => `${prefix}_${String(++number).padStart(4, "0")}` };
}

export async function testApp(clock = createClock(1_700_000_000_000)) {
  const config = loadConfig();
  const app = await createApp({
    config,
    store: createMemoryStore(),
    calibrations: loadCalibrations(),
    clock,
    ids: testIds(),
    logger: { error() {}, info() {}, debug() {} },
    telemetryDir: new URL("../../dist/data/", import.meta.url),
  });
  const ghost = buildCircleGhost();
  app.registerGhost(ghost);
  return { app, clock, config, ghost };
}

export async function openSession(app, overrides = {}) {
  return app.createSession({ circuitId: "circle", difficulty: "grid", ...overrides });
}

export async function feed(app, sessionId, samples) {
  const results = [];
  for (const sample of samples) {
    results.push(await app.ingest(sessionId, [sample], sample.sourceTimeMs));
  }
  return results;
}

export function lapSamples(options = {}) {
  return flyingLapSamples({ lapMs: 4000, startMs: 1_700_000_003_000, ...options });
}
