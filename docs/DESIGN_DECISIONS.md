# Design decisions

## Decided

- The live ingress is the version 1 servo sample: `schemaVersion`, `servoId`, `sequence`, `sourceTimeMs`, `x`/`y` or `progress`, lock, and optional normalized actuators. Hardware details stay outside the service.
- The sample frame is not the projection frame. `identity-v1` is the default and is valid only for senders that already write racing-frame coordinates.
- Official boss comparison uses the recorded ghost. A live boss servo is not selected. Advisory egress stays off until a human sets `safety.egressEnabled`. `safety.maxSpeedKmh` stays null until a human sets a cap.
- Flying start is the default. The finish wrap counts only after substantial forward progress and a post-crossing latch.
- Three equal-distance sectors are the default. They are not F1 timing sectors. A boundary list can replace them without a code change.
- Missing lock is `assumed`. An explicit unlock or low quality starts lost tracking. Grace expiry invalidates the lap.
- A feed hole during a live attempt voids it. The service does not resume a lap across a hole.
- Boss time is `recorded time * bossLapFactor`. The rookie, grid, and boss factors are placeholders stored with the session.
- Official time prefers a timely epoch `sourceTimeMs`. Sector times are adjusted so they sum to that official lap time.
- Ghost ids are content hashes. The projection fit and 1.5 second timing-line closure match `dist/replay.js`.
- Local memory and file stores implement the object, stream, and record ports. OCI provisioning waits for a tenancy and explicit spend approval.
- `dist/` remains the projection renderer.

## Contract divergence

`oracle_x_rcg` planned a motion message with `car_id`, `t_ms`, `x`, `y`, `vx`, `vy`, `ax`, `ay`, meters, at least 30 Hz, and a car marked lost after 200 ms. This service does not accept that message. Do not merge the schemas in this pass. Hardware owners must choose before a physical car is connected. Until then, synthetic and recorded progress samples use the servo contract.

## Hardware stand-in

- The hardware message is translated at the edge. Scoring still uses the servo sample.
- `car_id` 1 is human and `car_id` 2 is boss until a binding replaces that.
- `projection-meters-v1` is an unsurveyed scale, not a floor calibration.
- A 200 ms silence mark does not replace the 1500 ms scoring timeout.
- Software hold is the only e-stop this process can express. It does not stop a motor.

## Human input required next

- OCI tenancy, budget, and approval to spend.
- Approved telemetry, or a written decision to keep the OpenF1 fallback.
- Venue, cars, and the 15-student playtest. The software procedure is in `docs/OPERATOR_RUNBOOK.md`; it cannot be executed here.
- A physical calibration file before track limits are treated as real.
- Oracle branding guidance. Week 11 branding is not started.
- Whether the hardware sender will adopt the servo sample or whether this service must grow an adapter. That choice is not made here.
