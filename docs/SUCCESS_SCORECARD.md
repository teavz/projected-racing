# Success scorecard

Contractual SOW numbers are not in the repo. The values below are engineering budgets and current checks, not accepted acceptance metrics.

| Check | Current evidence | Status |
| --- | --- | --- |
| Lap, sector, boss delta, and leaderboard | Unit and API path tests | Passing locally, except the HTTP listen test in a sandbox that blocks `127.0.0.1` |
| Invalid and DNF excluded from the board | Race tests | Passing |
| Fifty local race cycles, no state leak | Reliability test | Passing |
| Recorded Monza ghost follow | Reliability test | Passing |
| Simulator behavior unchanged | `node verify.mjs` | Required before handoff. `dist/` must stay unchanged |
| Dashboard latency | API test asserts snapshot handling under 50 ms | Engineering budget only |
| Feed timeout | `servo.offlineAfterMs` is 1500 | Engineering assumption, not the older 200 ms planning note |
| Timing accuracy versus slow-motion video | Not measured | Open |
| Setup and reset time | Not measured | Open. Operator records it during playtest |
| Safety stop | Not this service | Open. Software hold is not a safety-rated stop |
| Participant engagement | Not measured | Open. Week 9 physical playtest is blocked |
| OCI ingestion and spend | No tenancy | Blocked |

Difficulty factors, track-limit distances, and tracking grace are placeholders stored on the session at creation. They are not sponsor-accepted targets.
