import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadConfig, validateConfig } from "../src/config.js";
import { validateServoSample } from "../src/schema.js";
import { buildGhostFromRecorded } from "../src/ghost.js";

const config = loadConfig();

test("the published servo example is valid", () => {
  const sample = JSON.parse(fs.readFileSync(new URL("../config/examples/servo-sample.json", import.meta.url)));
  const checked = validateServoSample(sample, config.servo);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.equal(checked.sample.y, -0.4);
});

test("servo samples fail closed on bad units and missing position", () => {
  const base = { schemaVersion: 1, servoId: "servo-human-1", role: "human", sequence: 1, sourceTimeMs: 10, x: 1, y: 2 };
  assert.equal(validateServoSample({ ...base, schemaVersion: 2 }, config.servo).ok, false);
  assert.equal(validateServoSample({ ...base, actuators: { throttle: 80 } }, config.servo).ok, false);
  assert.equal(validateServoSample({ ...base, x: null, y: null, progress: null }, config.servo).ok, false);
  assert.equal(validateServoSample({ ...base, role: "camera" }, config.servo).ok, false);
});

test("sector boundary mistakes are rejected", () => {
  const raw = structuredClone(config);
  raw.sectors = { count: 3, boundaries: [0.8, 0.2] };
  assert.throws(() => validateConfig(raw), /strictly increasing/);
});

test("cleaning records dropped samples and refuses an unusable lap", () => {
  const lap = {
    id: "dirty",
    name: "Dirty",
    lapDuration: 4,
    circuitLength: 100,
    columns: ["time", "x", "y", "speed", "throttle", "brake"],
    samples: [[0, 0, 0, 10, 10, 0], [0, 1, 0, 10, 10, 0], [-1, 1, 1, 10, 0, 0], [1, 1, 1, -5, 120, -1], [0.5, 2, 2, 10, 10, 0], [1, Number.NaN, 1, 10, 0, 0]],
  };
  assert.throws(() => buildGhostFromRecorded(lap, config), /too many samples/);
});
