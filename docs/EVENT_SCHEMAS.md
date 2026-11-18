# Event schemas

Schema version is 1. Declared event names live in `software/src/events.js`. An undeclared name is logged and still stored.

## Session snapshot

`GET /v1/sessions/:id` and the `snapshot` SSE event return the operator snapshot from `projectSnapshot`. The fields the dashboard reads are `circuitName`, `difficulty`, `startMode`, `banner`, `instructions`, `display`, `tracking`, `feedStatus`, `attemptNumber`, `leaderboardPreview`, and `quality`.

`state` is one of `idle`, `intake`, `countdown`, `racing`, `lost_tracking`, `invalid`, `hold`, `result`, `offline`, or `fault`. `phase` is `awaiting_line` while racing before the flying-start crossing. Otherwise it matches `state`.

`result` is null until an attempt is published. A valid result has `outcome` of `beat_boss`, `behind_boss`, or `tie`, plus `lapTimeMs`, `bossTimeMs`, `deltaMs`, and `sectorTimesMs`. Closed attempts use `invalid` or `dnf` and a `reason`. Invalid and DNF results are stored and excluded from the leaderboard.

## Recorded lap file

Ghost rebuild reads JSON files in `dist/data`. The cleaner expects the existing column layout used by the simulator: timed samples with `x` and `y`, plus the lap metadata already stored beside them (`id`, `name`, `lapDuration`, session key, driver, source notes). F1 column names stay at that edge. The ghost written to the object port is the internal shape: fitted samples, sectors, lineage, frame, and an advisory speed and brake profile.

## Event log

Each mutation appends events for that session. The reload path uses the saved session snapshot, not a replay of the log. Important names:

- `session.created`, `driver.registered`, `driver.queued`
- `race.countdown_started`, `race.armed`, `race.started`, `race.state_changed`, `race.waiting_for_gate`
- `race.hold`, `race.reset`, `race.offline`, `race.difficulty_changed`
- `servo.sample_accepted`, `servo.sample_rejected`
- `timing.lap_started`, `timing.sector_crossed`, `timing.lap_completed`, `timing.false_crossing`
- `lap.invalidated`, `score.published`, `ghost.recomputed`

`score.published` carries the result that is stored as an attempt.
