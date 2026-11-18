# Risk register

| Risk | Impact | Current handling | Owner next |
| --- | --- | --- | --- |
| No OCI tenancy or spend approval | Cloud architecture cannot be demonstrated as provisioned | Local ports only. No apply and no invented resource names | Project managers and Oracle contact |
| Servo contract differs from the older motion message | Hardware can build the wrong payload | The motion message is translated at the edge. Scoring still uses the servo sample. Bindings and scale are assumptions in `docs/HARDWARE_INTEGRATION.md` | Hardware and software together, before a car is connected |
| Unsurveyed meter scale used on a real car | Track limits and lap progress would be wrong | The stand-in marks `surveyed: false` and refuses to invent a floor origin | Track calibration owner |
| Identity calibration is not a survey | Lateral limits and geometric progress are meaningless on a physical track | Affine calibration is required before those checks are trusted | Track calibration owner |
| Feed timeout is 1500 ms, not 200 ms | A lost car stays on the timing line longer than the older planning note | Timeout is explicit and voids the lap. It is not an accepted SOW number | Scorecard review |
| Official telemetry may never arrive | Boss line may remain the historical OpenF1 recording | Lineage is stored on the ghost. It is not labeled as live team telemetry | Oracle telemetry decision |
| Process restart mid-lap | A lap could be silently resumed | Restart voids the open attempt | Operator runbook |
| Dashboard mistaken for timing authority | Display clock could be quoted as official | Copy says official time comes from the scoring service | Operators |
| Week 9 playtest run against simulation only | Engagement numbers would be false | Runbook marks the 15-student playtest blocked | Event owner |
| Public bind without auth | Session and driver names would be exposed | Default bind is `127.0.0.1`. Auth is not implemented | No public deploy in this pass |
