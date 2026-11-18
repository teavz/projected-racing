# Operator runbook

## Run

From the checkout:

```sh
npm test
node verify.mjs
node software/bin/projected-racing.js serve
```

Open http://127.0.0.1:8787. The floor projection is separate:

```sh
cd dist
python3 -m http.server 8765 --bind 127.0.0.1
```

Ghosts are rebuilt on startup from `dist/data`. `npm run ghosts` rebuilds them without serving. `npm run simulate` scores one synthetic Monza lap.

The server binds to `127.0.0.1` unless `software/config/default.json` changes it. Do not expose it without authentication.

## Score

1. Choose the circuit and difficulty. Difficulty factors are placeholders: rookie, grid, and boss.
2. Enter the driver and press Intake.
3. Press Start. The default countdown is 3000 ms. Flying start begins the lap at the first valid line crossing.
4. Live samples must arrive as servo samples for the bound human servo. Simulate lap is a stand-in, not a hardware path.
5. The banner is the race state. Official time comes from the scoring service, not the page clock.
6. Hold pauses scoring. Release during an active lap voids it as `operator_hold` and excludes it from the leaderboard.
7. Reset returns the same driver to intake. Next is only available when a name is queued and no attempt is open.

Invalid, DNF, and offline results remain in the attempt records and do not rank.

## Recover

- Feed timeout during an attempt: banner `OFFLINE`, reason `offline`. Reset before the next run. Do not continue the same lap.
- Tracking lost: the driver has the configured grace period. Expiry voids the lap as `tracking_loss`.
- Process restart during an open attempt: the reloaded session is offline with reason `process_restart`. Reset it.
- Ghost missing after reload: state `fault`. Recompute ghosts, then reset.
- Staged start outside the gate: the countdown waits, then records `not_on_grid` if the car never enters.

## Incident checklist

- Note the session id, circuit, difficulty, banner, and `quality.lastRejection`.
- Keep the `var/racing` directory. It has the snapshot, event log, attempts, and laps.
- Do not delete invalid attempts to clean the board. The board already excludes them.
- Do not send motor, camera, or radio commands from this console. It cannot stop a car.

## Week 9 playtest

The physical playtest is blocked until a venue, cars, and students exist. Do not treat a simulated lap as one of the 15 student runs.

When it is unblocked, run the existing dashboard and record one row per student:

- completion: valid result, or not
- invalid or DNF reason from `result.reason`
- offline or crash: `feedStatus`, `quality.sequenceGaps`, and `quality.rejected`
- reset time: `serverTimeMs` at the result minus `serverTimeMs` at the next intake, recorded by the operator
- one line of feedback

Targets for completion, reset time, and engagement are not accepted yet. Record the counts. Do not invent a pass threshold.

## Hardware stand-in

```sh
npm run hardware-demo
```

That command scores a synthetic circle lap through the motion adapter. It does not move a car. A physical sender posts the same JSON to `/v1/sessions/:id/motion`. `/estop` only holds scoring. Assumptions and the two default car ids are in `docs/HARDWARE_INTEGRATION.md`.
