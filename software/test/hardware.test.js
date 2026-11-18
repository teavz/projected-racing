import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { convertMotion, createHardwareBridge, frameForGhost, hardwareHealth, motionLapFromGhost, validateMotionSample } from "../src/hardware.js";
import { buildCircleGhost } from "../src/ghost.js";
import { testApp } from "./helpers.js";

const example = JSON.parse(fs.readFileSync(new URL("../config/examples/motion-sample.json", import.meta.url)));

test("the published motion example becomes a human servo sample", () => {
  const bridge = createHardwareBridge();
  const frame = frameForGhost(null);
  const converted = convertMotion(bridge, example, frame, example.t_ms);
  assert.equal(converted.accepted, true);
  assert.equal(converted.servo.servoId, "car-1");
  assert.equal(converted.servo.role, "human");
  assert.equal(converted.servo.x, example.x / frame.metersPerUnit);
  assert.equal(converted.servo.actuators.throttle, 0.4);
  assert.equal(converted.servo.raw.car_id, "1");
  assert.equal(Object.hasOwn(converted.servo, "battery_v"), false);
});

test("old motion is not resent and a 200 ms gap is marked lost", () => {
  const bridge = createHardwareBridge();
  const frame = frameForGhost(null);
  const first = { car_id: 1, t_ms: 1000, x: 0, y: 0, vx: 1, vy: 0, ax: 0, ay: 0 };
  assert.equal(convertMotion(bridge, first, frame, 1000).accepted, true);
  const stale = convertMotion(bridge, { ...first, x: 1 }, frame, 1100);
  assert.equal(stale.accepted, false);
  assert.equal(stale.rejection.code, "stale_motion");
  const late = convertMotion(bridge, { ...first, t_ms: 1300, x: 2 }, frame, 1300);
  assert.equal(late.accepted, true);
  assert.equal(late.servo.lock, false);
  assert.equal(late.servo.flags.includes("tracking_gap"), true);
  assert.equal(hardwareHealth(bridge, 1600)[0].lost, true);
});

test("unbound cars are recorded and not scored", () => {
  const bridge = createHardwareBridge();
  const converted = convertMotion(bridge, { car_id: 3, t_ms: 1, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0 }, frameForGhost(null), 1);
  assert.equal(converted.accepted, false);
  assert.equal(converted.rejection.code, "unknown_car");
  assert.equal(validateMotionSample({ car_id: 1, t_ms: 1, x: 0, y: 0, vx: 0, vy: 0, ax: 0 }).ok, false);
});

test("a stand-in motion lap crosses the circle fixture", async () => {
  const { app } = await testApp();
  const created = await app.createSession({ circuitId: "circle" });
  await app.command(created.sessionId, { type: "register-driver", name: "Hardware Stand-in" });
  await app.command(created.sessionId, { type: "start", countdownMs: 0 }, 1_000);
  const ghost = buildCircleGhost();
  const samples = motionLapFromGhost(ghost, { startMs: 1_100, stepMs: 40 });
  const scored = await app.ingestMotion(created.sessionId, { samples, standIn: true });
  assert.equal(scored.results.every((result) => result.accepted), true);
  assert.equal(scored.snapshot.result?.outcome, "tie");
  assert.equal(scored.frame.surveyed, false);
});

import { decodeClientFrames, encodeTextFrame } from "../src/motion-socket.js";
import { loadTrackReference, metersToRacing } from "../src/hardware.js";

test("an assumed track reference rotates meters without claiming a survey", async () => {
  const reference = loadTrackReference(JSON.parse(fs.readFileSync(new URL("../config/examples/track-reference.json", import.meta.url))));
  assert.equal(reference.surveyed, false);
  assert.equal(reference.widthMeters, 0.6);
  const { app } = await testApp();
  const created = await app.createSession({ circuitId: "circle" });
  const loaded = await app.setTrack(created.sessionId, reference);
  assert.equal(loaded.frame.referenceId, "tabletop-assumption-v1");
  assert.equal(loaded.frame.surveyed, false);
  const rotated = loadTrackReference({
    id: "travel-plus-y",
    surveyed: false,
    widthMeters: 0.6,
    startLine: { a: { x: -0.3, y: 0 }, b: { x: 0.3, y: 0 } },
    forward: { x: 0, y: 1 },
  });
  const frame = { metersPerUnit: 0.05, origin: { x: 0, z: 0 }, ...rotated, originMeters: rotated.originMeters };
  const racing = metersToRacing({ x: 0, y: 2 }, frame);
  assert.equal(racing.x, 40);
  assert.equal(racing.y, 0);
  assert.throws(() => loadTrackReference({ id: "bad", surveyed: true, widthMeters: 0.6, startLine: reference.startLine }), /surveyed reference/);
});

test("the motion stand-in reports the boss car without steering it", async () => {
  const { app } = await testApp();
  const created = await app.createSession({ circuitId: "circle" });
  const scored = await app.replayMotion(created.sessionId, { driverName: "Stand-in", stepMs: 40 });
  assert.equal(scored.snapshot.result?.outcome, "tie");
  const status = await app.hardwareStatus(created.sessionId, scored.snapshot.serverTimeMs);
  assert.equal(status.health.some((item) => item.carId === "2" && item.role === "boss"), true);
  assert.equal(scored.snapshot.advisorySetpoint, null);
});

test("websocket text frames round-trip", () => {
  const encoded = encodeTextFrame('{"car_id":1}');
  const masked = Buffer.concat([
    Buffer.from([0x81, 0x80 | encoded[1]]),
    Buffer.from([1, 2, 3, 4]),
    Buffer.from(encoded.subarray(2).map((byte, index) => byte ^ [1, 2, 3, 4][index % 4])),
  ]);
  const decoded = decodeClientFrames(Buffer.concat([masked, masked.subarray(0, 2)]));
  assert.deepEqual(decoded.messages, ['{"car_id":1}']);
  assert.equal(decoded.rest.length, 2);
});
