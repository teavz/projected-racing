# OCI mapping

No tenancy is configured in this repo. Do not provision, apply, or spend credits from this pass. Auth is not optional once the process leaves localhost. It is not implemented here, and the server stays on `127.0.0.1` for that reason.

The local store methods are the ports. A later adapter can replace them without changing scoring.

| Local port | Current adapter | SOW resource | Status |
| --- | --- | --- | --- |
| `putObject`, `getObject` | `var/racing/objects` | OCI Object Storage for ghost artifacts and raw recordings | Not provisioned |
| `appendEvent`, `readEvents` | `var/racing/events/*.jsonl` | OCI Streaming for the race event log | Not provisioned |
| `saveRecord`, `getRecord`, `listRecords` | `var/racing/records` | OCI database for sessions, attempts, and leaderboard laps | Not provisioned |
| `logger` | process stderr | OCI Logging | Not provisioned |
| dashboard and API | local Node process | OCI compute, only after auth and a budget | Not provisioned |

IAM users, policies, budgets, and public ingress are blocked on an Oracle tenancy plus an explicit approval to spend. Resource names are not invented here. When a tenancy exists, map the four ports above and keep the servo contract unchanged.
