# Architecture

The projection simulator in `dist/` is the floor display. The Node service in `software/` is the system of record for sessions, ghosts, and scores. They do not share a process. Do not change `dist/` to make the service easier.

## Components

- `software/src/app.js` is the testable core. HTTP, the dashboard, and the CLI call it.
- `software/src/race.js` owns the race state machine, timing, and snapshots.
- `software/src/ghost.js` cleans a recorded lap, fits it with the simulator projection constants, closes the timing-line gap, and writes an immutable ghost. The ghost id is a content hash. Rebuilding the same inputs yields the same id.
- `software/src/schema.js` validates servo samples. The service does not open cameras, serial ports, motor controllers, or pinouts.
- `software/src/store.js` is the storage port. Memory and local files implement the same methods. There is no OCI client.
- `software/src/server.js` serves the API, server-sent snapshots, and the dashboard. It binds to `127.0.0.1:8787` unless `software/config/default.json` changes that.
- `software/src/simulate.js` builds synthetic progress samples so a lap can be scored without a car.

## State flow

A session is created against one loaded ghost. The operator registers one active driver, or queues names for later rotation. `start` opens a countdown. Flying start, the default, arms the lap and starts it on the first valid start/finish wrap. Staged start starts the lap only when the latest accepted human progress is inside the start gate.

Accepted human samples update progress, tracking, sectors, and the line crossing. Official time uses a timely epoch `sourceTimeMs`. A late or monotonic clock scores on receive time and the quality record says so. Sector times are reconciled to the official lap time so they sum to it.

A published result is stored as an attempt. Valid outcomes `beat_boss`, `behind_boss`, and `tie` are also stored as leaderboard laps. Invalid and DNF results stay in the attempt log and are excluded from the board.

## Persistence

The file store under `var/racing/` keeps:

- `objects/ghosts/<circuit>/<id>.json` and `current.json` for the ghost object port.
- `events/<sessionId>.jsonl` for the append-only event log.
- `records/sessions`, `records/attempts`, and `records/laps` for the database port.

The snapshot is what reloads. A restart during countdown, racing, lost tracking, hold, or an active lap voids that attempt with reason `process_restart` and leaves the session offline until reset.

## Surfaces

- `GET /health`, `/v1/schema/servo`, `/v1/circuits`, `/v1/leaderboard`, `/v1/metrics`
- `GET /v1/sessions/:id` and `/v1/sessions/:id/stream`
- `POST /v1/sessions`, `/v1/sessions/:id/commands`, `/v1/sessions/:id/samples`, `/v1/sessions/:id/simulate`, `/v1/ghosts/recompute`
- Dashboard at `/` and `/dashboard`. `?mode=spectator` hides the operator dock in CSS.

The dashboard is a view. It does not time the lap.
