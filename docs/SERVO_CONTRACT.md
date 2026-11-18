# Servo contract

Schema version 1. The published example is `software/config/examples/servo-sample.json`. `GET /v1/schema/servo` returns the same rules.

This is the live interface. It is not the older planning-repo motion message. See `docs/DESIGN_DECISIONS.md`.

## Required fields

- `schemaVersion`: `1`
- `servoId`: 1-64 characters of letters, numbers, dot, underscore, colon, or hyphen
- `role`: `human`, `boss`, `timing`, or `other`
- `sequence`: integer >= 0, increasing per `servoId`
- `sourceTimeMs`: finite number
- A human sample also needs `x` and `y` together, or `progress` in `[0, 1]`, or both

## Optional fields

- `clock`: `epoch` or `monotonic`. Default is `epoch`.
- `z`, `headingRadians`, `speedMps` when finite. `speedMps` must be >= 0.
- `lock`: boolean. Omit it only if the sender cannot report lock. The service marks that sample `assumed`, not `locked`.
- `quality`: 0 to 1. Below `lockQualityMin` (0.5) is lost tracking.
- `actuators.throttle` and `actuators.brake`: 0 to 1, normalized. Not percent and not PWM.
- `actuators.steer`: -1 to 1, normalized. The sign is uncalibrated and is not used for scoring.
- `flags`: short machine flags.
- `raw`: passthrough for a future sender. It is not interpreted. Large raw payloads are rejected.

`x` and `y` are planar. `y` is not up. The sample frame is not assumed to be the projection frame. `identity-v1` is valid only when the sender already writes racing-frame coordinates. A physical track needs an affine calibration file before lateral limits or geometric progress mean anything.

## Acceptance

Duplicate or stale sequences are rejected. A gap increases `quality.sequenceGaps` and the later sample can still be accepted. A sample whose epoch time is more than `maxSampleDelayMs` (500) late, or more than `staleSourceReverseMs` (50) ahead of receive time, is scored on receive time and counted as late. A source-time reversal during a lap is accepted but not scored.

The default human feed is offline after 1500 ms without a sample. That is an engineering timeout, not an accepted SOW number. A timeout during a live attempt voids the attempt and stays offline until reset. The service does not resume a lap across a hole.

Progress-only samples can score laps and sectors. They cannot fail track limits. Track limits use distance from the ghost polyline when the sample has a mapped position.

## Egress

Advisory setpoints can be derived from the ghost profile. `safety.egressEnabled` is false. A setpoint is not a hardware command. The service never emits PWM, motor mixing, or an e-stop.

## Hardware edge

Cars do not send this sample directly. `docs/HARDWARE_INTEGRATION.md` defines the motion message and the assumed translation into this contract.
