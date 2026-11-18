import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { makeReplay } from "../../dist/replay.js";
import { loadConfig } from "../src/config.js";
import { fitRecordedSamples, nearestProgress } from "../src/geometry.js";
import { cleanRecordedLap } from "../src/ghost.js";
import { validateRecordedLap } from "../src/schema.js";

test("projection fit matches the local simulator", () => {
  const config = loadConfig();
  for (const id of ["monza", "silverstone", "monaco"]) {
    const lap = JSON.parse(fs.readFileSync(new URL(`../../dist/data/${id}.json`, import.meta.url)));
    const checked = validateRecordedLap(lap);
    assert.equal(checked.ok, true);
    const cleaned = cleanRecordedLap(lap, checked.columnIndex, config.cleaning);
    assert.equal(cleaned.dropCount, 0);
    const fitted = fitRecordedSamples(cleaned.samples, lap.lapDuration, config.projectionFit);
    const replay = makeReplay(lap);
    assert.equal(fitted.samples.length, replay.samples.length);
    for (let index = 0; index < fitted.samples.length; index += 1) {
      assert.ok(Math.abs(fitted.samples[index].x - replay.samples[index].x) < 1e-9);
      assert.ok(Math.abs(fitted.samples[index].z - replay.samples[index].z) < 1e-9);
      assert.ok(Math.abs(fitted.samples[index].u - replay.samples[index].u) < 1e-9);
    }
    const probe = fitted.samples[40];
    const ours = nearestProgress(fitted.samples, probe.x, probe.z);
    const existing = replay.nearest(probe.x, probe.z);
    assert.ok(Math.abs(ours.u - existing.u) < 1e-9);
    assert.ok(ours.distance < 1e-9);
  }
});
