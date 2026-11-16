# Benchmark failure review and repair — November 13, 2026

The failed public comparison was primarily an execution failure. Mac sleep accounts for nearly all of the candidate's long elapsed time; deadline and failure-propagation defects then let the comparison continue. The saved result remains incomplete and cannot establish a model-quality gain.

## What went wrong

The saved OS power log records clamshell and maintenance sleep during the candidate arm. Approximately 3,959 seconds of suspension align with its 4,049.973 seconds of recorded runtime. The `book-store` and `pig-latin` baseline graders timed out before any model attempt; later attempts and host startup crossed further sleep intervals. See the [original diagnosis](polyglot-2026-11-05-diagnosis.md) and [power log](polyglot-2026-11-05-power-log.txt).

Relative timers could not execute while the Mac was suspended. The runner also treated incomplete assessment as a completed task and did not stop the arm on evaluator timeout. Earlier repairs added absolute watchdogs, stopped subsequent cases after those failures, preserved interruption reasons, and held an idle-sleep assertion during public runs. An idle-sleep assertion does not prevent forced or clamshell sleep; a suspended process cannot enforce a deadline until it resumes.

## Further defects reproduced and repaired

The existing watchdog repairs still left a race before their next timer callback. Two new offline regressions initially failed: an expired run dispatched a backend after recording its start, and Muse submitted a model turn after the deadline elapsed during settings recording.

Deadline checks now propagate through nested cancellation scopes and run synchronously at dispatch boundaries. The scheduler checks again after workspace preparation and immediately before invoking a backend. Muse checks before submitting a turn and after writing its durable command intent, before returning the command ID to the SDK for transmission. CLI, comparison, worker, gateway and recovery entry points retain these checks through their nested signals. Smoke and recovery operations now use absolute watchdogs too. Read-only reconciliation remains available after the original run deadline.

Work proven never dispatched releases its reservations without inventing model usage. Work already dispatched retains its usage or unresolved liability. The existing successful budget-checkpoint behavior still passes its regressions.

The gateway now saves a reservation timestamp and available provider response/request IDs directly in the ledger, before waiting for terminal usage or EOF. These identifiers survive stream failure and reopening. Contradictory identities are refused. Terminal usage still settles immediately, so a later transport failure cannot discard a known charge. No credential or prompt content was added to the ledger.

## Request 205 remains unresolved

The native `scale-generator` session contains three provider response IDs. Their order supports the earlier reconstruction associating the final interrupted request with that turn; the old gateway did not record the mapping, so this is not an exact historical gateway receipt.

A read-only lookup of all three existing responses returned HTTP 404. No completion was created or replayed. This does not prove a zero charge or establish why the responses are unavailable. The lookup uses Meta's documented [retrieve-response endpoint](https://dev.meta.ai/docs/api-reference/responses/retrieve-response).

The saved lookup evidence is in `.branchpilot/billing-recovery-2026-11-13/`. The response IDs were:

```text
resp_6aecca5b97fc5ce4f16c497a
resp_6aecca5e7e0b22b531b244a6
resp_6aecca603ab774569ae04826
```

The historical campaign ledger and public summary are unchanged. Request 205 still retains its US$7 reserve. The CAD $50 campaign guard remains in force; no new paid run was started. Provider billing evidence is still needed to settle that historical liability.

## Verification

`npm run release:check` passed: TypeScript validation, **253/253 tests**, and the package dry run. Six new tests cover nested deadline propagation, cancellation before backend dispatch, expiry during settings and command-intent recording, durable provider identifiers after a lost stream, and refusal of conflicting identifiers. Existing sleep, stream-failure, comparison, checkpoint, recovery and OS-isolation checks also passed.

The clock-jump tests reproduce dispatch ordering without physically suspending the Mac. They establish the repaired local behavior; they are not a fresh live benchmark or a physical lid-closure test. Output is saved in `.branchpilot/failure-repair-release-2026-11-13.log`.

Unchanged historical fingerprints:

```text
campaign ledger SHA-256: eb3aed983a32fd7fcb2bacaba0950da094a219abe43e611e411589865bb27328
public summary SHA-256: a6568fa7af7d0dd6997bfc2897ac1f92abbb01a78fdfad17ac15d322d5976643
```
