# Hardware integration

The cars are not in this checkout. This layer is the stand-in the hardware team replaces. It does not open a radio, serial port, camera, or motor controller.

Live scoring still stores servo samples. `POST /v1/sessions/:id/motion` translates the hardware foundation message into that sample and then uses the existing ingest path.

## Assumed contract

These choices are assumptions, not measured track facts.

- Two cars are bound until an operator says otherwise: `car_id` 1 is the human car, `car_id` 2 is the boss. Any other id is rejected as `unknown_car` and is not scored. A request can bind another id with `bindings`.
- The message is `car_id`, `t_ms`, `x`, `y`, `vx`, `vy`, `ax`, `ay`. Position is meters. Velocity is m/s. Acceleration is m/s². Extra keys are ignored.
- `throttle` and `brake` above 1 and at most 100 are treated as percent. `steer` must already be normalized from -1 to 1. None of these are motor commands.
- The sample frame is `projection-meters-v1`: hardware `x` matches racing `x`, hardware `y` matches racing `z`, and the origin is the projection origin. That origin is not a floor mark.
- Scale is the ghost `metersPerUnit` when the recorded lap has a circuit length. Otherwise the scale is 0.05 m per racing unit. Neither scale is a survey. Do not use it to judge a physical car until a measured calibration replaces it.
- Velocity and acceleration are assumed already filtered. The adapter does not smooth them. The stand-in sets acceleration to 0 because it has no IMU.
- A car is marked lost after 200 ms without a new measurement. The adapter does not invent or resend an old sample. The next real sample is accepted with `lock: false`. The scoring feed timeout remains 1500 ms and still voids a live lap on a hole.
- 30 Hz and 100 ms latency are health warnings, not drop rules. Position-control targets of 60 Hz and 50 ms are not implemented.
- Transport is HTTP `POST /v1/sessions/:id/motion` or `ws://127.0.0.1:8787/ws/hw?session=<id>` on the same local port. UDP is not listening. Neither opens a radio.
- `POST /v1/sessions/:id/estop` calls the operator hold. It is not a physical e-stop, a brake, or a safety-rated stop.
- No path-following gains, PWM, or speed cap are applied. Advisory ghost setpoints stay off the wire unless a human sets `safety.egressEnabled`.
- A track reference may set the start-line midpoint, travel direction, and width. Width is recorded only. It does not change lap scoring. `surveyed: true` requires at least eight reference-lap points and still does not replace the ghost.
- The motion stand-in also emits car 2 from the same ghost. That is a replay presence check, not an autonomous controller.


## Replace the stand-in

1. Bind the printed car ids.
2. Send one recorded session through `/v1/sessions/:id/motion` and compare the translated `x` and `y` with the track calibration.
3. Replace `projection-meters-v1` with a measured affine calibration before trusting lateral limits.
4. Rerun `node --test software/test/hardware.test.js` against the same message shape.

`npm run hardware-demo` drives the circle fixture through this path with no car. The dashboard button **Motion stand-in** calls the same replay. Examples are `software/config/examples/motion-sample.json` and `software/config/examples/track-reference.json`.

