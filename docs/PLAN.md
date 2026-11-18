# Projected Racing software plan

Status: scoring loop closed on branch `codex/close-software-infrastructure`. Local verification is green except the HTTP listen test where the sandbox blocks `127.0.0.1`. OCI provisioning and the physical playtest remain blocked. This pass is not committed.

This plan covers the software infrastructure for Beat the Grid. It does not design hardware. Live observations enter through the servo contract in `docs/SERVO_CONTRACT.md`.

## What exists

The repository has two local parts. `dist/` is still the projection simulator. `software/` is the scoring service.

- `dist/` renders recorded 2024 Verstappen qualifying laps for Monza, Silverstone, and Monaco.
- `dist/replay.js` fits those traces into the tabletop frame, closes the timing-line gap over the last 1.5 seconds, and answers `at(time)` and `nearest(x, z)`.
- `dist/app.js` counts a lap in the browser. That count is not the official score. The service is.
- `verify.mjs` locks the simulator. This pass does not change `dist/`.
- `software/` validates servo samples, versions ghosts, scores laps and sectors, stores attempts, and serves the operator dashboard.
- The storage ports are local. There is still no OCI tenancy, official telemetry, branding, or accepted numeric target.
- `RCG SOW - Oracle.pdf` remains an untracked scope copy. The canonical copy is `../references/RCG SOW - Oracle.pdf`.

## Problems to close

1. Closed locally: live car data enters as a versioned servo sample. Hardware remapping is still an open human decision.
2. Closed locally: recorded laps become versioned ghost artifacts with lineage, sectors, and an advisory profile.
3. Closed locally: lap, sector, boss delta, personal best, and leaderboard have one service.
4. Closed locally: intake, countdown, racing, lost tracking, invalid, offline, result, hold, and reset are explicit states.
5. Closed locally: quality records sequence gaps, delay, drift, late samples, and false crossings.
6. Closed locally: `simulate` can exercise the service without a car, including a recorded Monza follow.
7. Partial: local object, event, and record ports match the SOW shapes. OCI resources are not provisioned.
8. Closed locally: the dashboard is driven by the backend, including spectator mode.
9. Closed in `docs/DESIGN_DECISIONS.md`. Contractual numbers and the hardware schema choice remain open.

## Approach

Build a zero-dependency Node.js service beside the simulator. Node 22 is already the verification runtime, and the ghost fit can be checked against `dist/replay.js` without a browser.

Keep the browser simulator as the floor projection. The new service is the system of record for sessions, ghosts, and scores. Do not rewrite `dist/app.js` in this pass; coupling it now would risk the visual demo and still would not be a calibrated track.

Local adapters implement the storage ports. They run with no credentials. OCI resource names and IAM intent live in `docs/OCI_MAPPING.md`. Provisioning waits for a tenancy and an explicit approval to spend credits.

### Servo boundary

Every live fact about the car arrives as a servo sample: position or progress, sequence, source time, lock, and optional normalized actuator echo. The service does not open cameras, serial ports, motor controllers, or pinouts.

The sample frame is not assumed to be the projection frame. `identity-v1` is the default map, and it is only valid when the sender already writes racing-frame coordinates. A physical track needs an affine calibration file before lateral limits or geometric progress mean anything. That limitation is intentional.

Official boss comparison uses the recorded ghost unless a later change selects a live boss servo. Advisory setpoints can be derived from the ghost profile, but egress is off until a human enables it. A setpoint is not a hardware command.

### Scoring rules to implement

- Flying start is the default. The lap starts on the first start/finish wrap after the countdown, because a staged grid cannot be assumed.
- The finish wrap counts only after substantial forward progress and a post-crossing latch, so line chatter cannot double-count.
- Three equal-distance sectors are the default. They are not F1 timing sectors. A boundary list can replace them without a code change.
- Track limits use distance from the ghost polyline when the sample has a mapped position. Progress-only samples cannot fail track limits.
- Missing lock is `assumed`, not `locked`. An explicit unlock starts lost-tracking. Grace expiry invalidates the lap.
- A feed timeout during a live attempt voids it and stays offline until reset. The service must not resume a lap across a hole.
- Invalid and DNF results are stored and excluded from the leaderboard.
- Boss time is `recorded time * bossLapFactor`. Difficulty factors are placeholders, stored on the session when it is created.
- Official time prefers a timely epoch `sourceTimeMs`. Late or monotonic clocks score on receive time and say so.

### Ghost pipeline

Read the existing lap JSON, or any later file with the same columns, from `dist/data`. Clean it, fit it with the simulator's projection constants, close the loop the same way, assign sectors, and write an immutable ghost whose id is a content hash. Rebuilding the same inputs yields the same id.

The speed and brake profile is advisory. No RC speed cap is invented. `safety.maxSpeedKmh` stays null until a human sets one.

### Race loop

`createApp` is the testable core. HTTP, the dashboard, and the CLI are adapters. One session has one active human driver, plus a name queue for quick rotation. Commands that are illegal in the current state fail with a code, not a guessed transition.

Persistence is a snapshot plus an append-only event log. The snapshot is what reloads. A restart during a live lap voids that attempt.

### Surfaces

- `GET /health`, `/v1/schema/servo`, circuits, ghosts, sessions, leaderboard, metrics.
- `POST` session commands, servo samples, ghost recompute, and an instant simulation.
- SSE snapshots for operator and spectator modes.
- Dashboard served by the same local process, bound to `127.0.0.1` by default.

## Out of scope

- RC platform, power, radio, camera, marker, barrier, and mount selection.
- Physical e-stop, motor mixing, PWM, and path-following gains. Software hold is an operator scoring hold, not a safety-rated stop.
- Surveyed track geometry, official sector maps, and a claim that the reconstructed ribbon is the racing line.
- OCI apply, spend, IAM users, and public deployment. Auth is not optional once the process leaves localhost; it is not pretended here.
- Oracle branding beyond the existing simulator credits. Week 11 branding is waiting on guidance.
- Replacing the projection renderer.

## Verification

- Unit tests for cleaning, projection-fit alignment with `dist/replay.js`, servo validation, crossings, sectors, deltas, invalidation, offline, reset, and leaderboard exclusion.
- An API test for the driver-entry-to-score path.
- Fifty consecutive synthetic race cycles with no state leak.
- One recorded Monza ghost-follow simulation.
- Existing `node verify.mjs` still passes because `dist/` is unchanged.
- Local dashboard latency is measured as an engineering budget, not as an accepted SOW number.

## Documentation to leave behind

- `docs/PLAN.md` — this plan.
- `docs/ARCHITECTURE.md` — components and state flow.
- `docs/SERVO_CONTRACT.md` — the adjustable live-data contract.
- `docs/EVENT_SCHEMAS.md` — events, snapshots, and recorded-lap files.
- `docs/OCI_MAPPING.md` — local ports to OCI resources, with the access blocker named.
- `docs/OPERATOR_RUNBOOK.md` — run, score, recover, and incident checklist.
- `docs/SUCCESS_SCORECARD.md` and `docs/RISK_REGISTER.md` — software metrics and risks, with contractual numbers left open.
- `docs/DESIGN_DECISIONS.md` — decisions, assumptions, and human input required next.
