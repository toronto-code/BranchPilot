# Public subset operational diagnosis and repair — 2026-11-05

November 13 follow-up: [additional reproduced defects and repairs](benchmark-failure-repair-2026-11-13.md) now pass the full 253-test release check. The current cumulative campaign ceiling is **CAD $50**, superseding the older C$100 authorization recorded below. Historical request 205 remains unknown.

The saved comparison remains incomplete and noncomparable. No strategy-quality or efficiency conclusion follows from it. This follow-up changed source code and added offline regression tests; it did not restart any benchmark, replay a request, modify the campaign ledger, or raise any cap.

## Confirmed cause of the large timing gaps

The Mac entered **Clamshell Sleep at 13:04:41 America/Toronto (18:04:41 UTC)**, immediately after the candidate's `book-store` baseline evaluator began. Repeated maintenance sleep followed. A filtered, read-only `pmset -g log` extract is saved in [the power evidence](polyglot-2026-11-05-power-log.txt). Its sleep/wake times align with the saved run events:

| Candidate case | Saved long operation | Matching OS sleep interval, Toronto time |
|---|---|---|
| book-store | Baseline evaluator: 336.765 s; timeout; no model attempt | 13:04:41–13:10:14, 333 s |
| pig-latin | Baseline evaluator: 957.538 s; timeout; no model attempt | 13:10:21–13:26:14, 953 s |
| scale-generator | Model attempt: 493.746 s; cancellation recorded at 13:34:43 | 13:26:39–13:34:43, 484 s |
| zebra-puzzle | Attempt startup: 721.391 s; no initialization recorded | 13:34:48–13:46:50, 722 s |
| robot-name | Attempt startup: 487.917 s; no initialization recorded | 13:46:56–13:55:05, 489 s |
| killer-sudoku-helper | Attempt startup: 967.895 s; initialization at 14:11:17 | 13:55:10–14:11:17, 967 s |

There was also an 11-second sleep at 13:26:16. These rounded OS durations total about 3,959 seconds, explaining nearly all of the candidate job's 4,049.973 seconds. They are evidence of host suspension, not evidence of multi-minute provider computation. The grader ran in a separate process; its `spawnSync` calls did not themselves block the controller's event loop. Both local process timeout receipts explicitly record `timedOut: true`, `SIGTERM`, and `stopped: true` after resume.

The code used relative timers for evaluator, attempt, and arm cancellation. They could not run while the host was asleep. Admission checked absolute remaining wall time, but the run controller had no independent task wall watchdog. After wake, a timeout could settle the active operation hundreds of seconds late.

## Why later tasks continued

`runController` caught the subsequent `BudgetError` and wrote status `completed`, outcome `inconclusive`, with message `Assessment incomplete: Insufficient wall time for work and finalization`. The comparison runner only treated `needs_attention`, `failed`, or an arm abort as trial errors. It did not stop on evaluator timeouts, incomplete assessment, or elapsed task overruns. It therefore started later tasks while the arm still appeared to have enough absolute time remaining. The public adapter checked execution failures and billing only after the entire arm returned.

Missing model confirmations for `book-store` and `pig-latin` reflect no model attempt at all. `zebra-puzzle` and `robot-name` failed before initialization; their recorded error is `ProtocolError: spawned MSP host stdin is closed`. These cases do not demonstrate execution with a different model.

## Interruption and request 205

The arm's absolute deadline was 14:03:49.593 Toronto time, inside the 13:55:10–14:11:17 sleep interval. After wake, the last host initialized, then recorded closed stdin; the controller and comparison recorded cancellation/interruption and returned at 14:11:19.564. The expired arm timer is consistent with that interruption. **Its exact initiating abort source is not provable**: the old comparison overwrote the reason with a generic interruption message, and external SIGINT/SIGTERM were not individually logged. The final settlement exception happened after the arm had already returned; it did not initiate the arm interruption.

There are 111 paid POST events in this gateway file, matching campaign entries 95–205; every one received HTTP 200 headers. The final POST records `TimeoutError: The operation was aborted due to timeout`. The gateway reserved entry 205 before forwarding it, waited for terminal provider usage while draining the response independently of the host connection, and entered its catch path on timeout. That path changed the reservation to `unknown`, retaining US$7 and blocking further paid admission. HTTP 200 headers alone do not establish completion or charge.

Request order, the six settled `say` requests, and the two settled `scale-generator` requests associate the final POST with the scale-generator turn, rather than a later startup-only case. This is a reconstruction: the old gateway did not record request IDs or timestamps in events. It also did not save raw upstream frames, so the exact timeout time, backend behavior, whether a terminal usage frame arrived before the transport failed, and the final provider charge remain unknown. Host cancellation and host token totals cannot settle that liability. The public script's post-arm `settle()` then saw the unknown entry and threw `Unsettled billing stops the campaign`, leaving candidate accounting unfinalized.

## Repairs and verification

- Added absolute wall-deadline watchdogs for the run, attempt, local worker, arm, and gateway response, with checks at controller boundaries. After suspension, they expire within the next watchdog tick (up to 100 ms of scheduled execution), rather than spending a remaining relative delay. Nothing can enforce a deadline while the OS has suspended the process; such a run must stop and remain invalid.
- Stop a comparison arm on evaluator timeout, cancelled task, incomplete assessment, or elapsed task overrun; retain the interruption reason in future job artifacts.
- Notify and abort the public campaign immediately when billing becomes unknown; check cancellation again before gateway admission and refuse campaign startup with unsettled entries. Already admitted upstream work still drains for billing evidence under its own deadline.
- Record gateway request IDs, start/forward/end times, and terminal status for future diagnosis. No credentials or request content were added to logs.
- Hold a macOS idle-sleep assertion during future authorized public runs; release it during cleanup. This does not prevent forced or clamshell sleep. Cleanup restores settings even if gateway shutdown throws.

TypeScript check/build, adapter syntax check, and whitespace validation passed. Six **new offline regressions** passed: wall-clock jump expiry; worker stop after a jump; task cancellation preventing another attempt; evaluator timeout stopping before the next comparison case; unknown-billing campaign notification/admission refusal; and stalled upstream timeout preserving the full reserve. The loopback tests injected fake providers and made no external requests. A fixture-path mistake and a sandbox loopback restriction were corrected before the two initially failing new cases passed. Previously passing cases and the existing regression/public suites were not rerun.

These tests simulate clock advancement; they do not validate a fresh live run or physical lid closure. The historical job, summary, accounting, gateway evidence, and ledger remain unchanged. Entry 205 is still unknown. The US$40 immutable ceiling and C$100 campaign limit remain unchanged; no further paid work is authorized while billing is unknown.

## Additional review and corrections

A second review found and corrected these further errors:

- Gateway shutdown waited for all HTTP handlers before closing active local connections. An unfinished upload could keep a handler waiting indefinitely; a queued successor could also attempt admission during shutdown. Shutdown now stops admission, closes local connections first, drains already admitted upstream billing independently, and shares one memoized close operation.
- SSE terminal usage was held in memory until EOF. A transport error after a valid terminal frame incorrectly converted that request to unknown. New requests now settle on the authoritative terminal usage frame, retaining that settlement if EOF later fails. This does not reconcile historical request 205: its upstream frames were not saved. Invalid or absent usage still retains the full unknown reserve.
- Errors after HTTP headers had been sent appended a JSON policy error to the SSE stream. Unsettled interrupted streams now terminate the connection; a stream with settled terminal evidence can end cleanly. Unknown-billing notifications occur once, and a notification callback exception cannot escape the request handler.
- The task's independent wall signal previously began inside the controller, after run setup. A task deadline now begins before setup, is checked before controller dispatch, and contributes its reason to interruption records.
- Public-run cleanup could skip settings/environment restoration if writing `gateway.json` failed. Nested cleanup now attempts restoration and releases the sleep inhibitor even on that path; potentially failing initial file reads happen before opening the gateway.

Five additional offline regression cases passed, covering terminal-then-transport failure, unfinished uploads during shutdown, queued-admission refusal with upstream drain, nonterminal SSE failure, and setup-time expiry before any work dispatch. One new fixture's teardown initially closed its fake stream twice; that fixture was corrected and only that failed case was retried. Previously passed cases were not rerun. The existing stalled-stream test assertion was updated for the deliberate transport termination; it was not rerun. TypeScript build, public-adapter syntax validation, and whitespace checks passed.

No public benchmark, existing regression suite, or paid provider call ran during this review. The historical ledger still equals the saved gateway ledger snapshot: 205 entries, request 205 unknown with US$7 reserved, immutable ceiling US$40. Existing uncommitted work was preserved.
