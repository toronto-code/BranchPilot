# Live Muse results — November 5, 2026

BranchPilot now runs against the installed **Muse Code 1.4.14 / SDK 1.4.14**, using **Meta Muse Wonder 1.0 at max effort**. Both versions passed all four tasks in the fresh confirmation pilot. BranchPilot used 9.2% fewer tokens and finished 12.3% sooner in this single run. These are small local observations, not a public benchmark score or a proven general advantage.

## Fresh confirmation

| Version | Hidden checks passed | Elapsed | Reported tokens |
|---|---:|---:|---:|
| Direct baseline | 4/4 tasks | 136.74 s | 510,169 |
| BranchPilot | 4/4 tasks | 119.95 s | 463,182 |

| Task | Baseline seconds | BranchPilot seconds | Baseline tokens | BranchPilot tokens |
|---|---:|---:|---:|---:|
| JSON pointer lookup | 45.54 | 55.82 | 150,190 | 143,810 |
| Merge intervals | 23.29 | 16.97 | 124,083 | 104,630 |
| UTF-8 truncation | 26.46 | 16.80 | 150,465 | 83,371 |
| Async memoization | 40.69 | 29.65 | 85,431 | 131,371 |

Every task used the same inputs, model, effort, tools, permissions, external graders, 240-second task ceiling, and 360,000-token total allowance in each version. The baseline had one direct attempt; BranchPilot could use up to three attempts sharing that allowance. Each version had a one-hour overall ceiling and finished early. These are controlled Muse runs, not the standalone CLI's default settings.

The four original confirmation tasks were frozen before any model run on them. Their development and hidden graders were first checked against incomplete starting code and independent reference implementations. Hidden graders were outside the model's readable workspace. Each attempt had a separate runtime home. JSON pointer and async memoization passed after BranchPilot captured a safely stopped budget checkpoint; neither was silently relabeled as a completed model turn.

[Machine-readable confirmation](results/muse-confirmation-2026-11-05.json) records `comparable: true`, no accounting/identity exceptions, and `modelQualityImproved: false`. All four pairs tied on correctness (exact paired p=1). No repetitions or randomized execution order were used; provider variability, caching, and order effects can influence timing. The tasks are small and selected locally. A larger, fresh public benchmark is still needed to establish better results per budget.

## Failed runs and the fix

The initial setup comparison stopped on approval/settlement integration errors. Its records remain under `.branchpilot/live-pilot-1`.

The first complete pilot on LRU caching, dependency ordering, streamed JSON, and async concurrency scored **baseline 4/4, BranchPilot 0/4**. All four BranchPilot attempts reached their token allocation. The controller discarded their edited files and had no candidate to grade or continue. [Original failed comparison](results/muse-pilot-before-checkpoint-2026-11-05.json).

The fix preserves changed code at an attempt token/time boundary only after confirmed host stop and known usage. External graders decide whether it works; failed checks feed the next repair. Unknown work, missing usage, user cancellation, and untracked workers remain excluded. Unchanged files do not trigger duplicate grading. Coding prompts also no longer request unnecessary hypothesis/proposal files. The fresh confirmation above followed these changes; the old task set was not rerun until a favorable score appeared.

## Runtime and spending verification

- Fixed the actual macOS isolation profile: signal syntax, loader root access, shell binaries, and timezone reads. An outside-file canary confirmed read/write denial while workspace writes succeeded.
- Used one outer OS boundary around Muse and its children. macOS cannot nest Seatbelt, so only an explicit outer-isolation lock disables Muse's redundant inner boundary. Approval checks stay enabled; the pilot permits only exact listed local commands.
- Disabled contributor/reminder/child work, checked the native effective tool roster, pinned runtime settings, and isolated each attempt's session history.
- Added a loopback gateway that holds the provider credential outside the host. It permits only priced Wonder text/function requests, reserves US$7 before dispatch, serializes settlement, and blocks permanently uncertain billing. Its persisted campaign limit cannot be increased on reopen.
- The campaign made **94 paid requests**, all settled: **1,973,086 input + 47,827 output tokens**, conservatively **US$8.848884**. This includes setup failures, the unsuccessful pilot, and confirmation. Every input token is charged at the uncached rate; this is an upper estimate from observed usage, not an invoice. The US$40 campaign ceiling leaves substantial room below the authorized C$150 including currency/tax margin.
- The complete paired pilot's 909,707 host tokens exactly match its gateway usage delta. The confirmation's 973,351 host tokens also match exactly, including cancelled checkpoints. Earlier interrupted setup usage remains fully charged by the gateway even where host accounting was incomplete.
- All **231 offline regression tests** passed, including real macOS containment, request settlement after disconnect, exact-command approvals, checkpoint continuation, and refusal to promote uncertain/user-cancelled work. Both task suites passed reference-grader validation.

Raw installation-specific evidence remains in `.branchpilot/live-smoke-8`, `.branchpilot/live-pilot-2`, `.branchpilot/live-confirmation-1`, and `.branchpilot/live-campaign-ledger.json`. Credentials and native session logs are not packaged.

## Reproduction

Build and validate the graders without provider calls:

```sh
npm test
node bench/validate-pilot.mjs
```

On the already verified installation, choose a fresh output directory and reuse the existing campaign ledger:

```sh
node bench/muse-live-pilot.mjs \
  --binary /absolute/path/to/the-tested-muse-binary \
  --home /absolute/path/to/the-dedicated-muse-home \
  --evidence .branchpilot/live-smoke-8 \
  --ledger .branchpilot/live-campaign-ledger.json \
  --out .branchpilot/a-new-comparison \
  --suite confirmation \
  --allow-provider-cost
```

Supply `META_API_KEY` in the invoking environment or `--key-file` pointing to a local credential file. The script checks real evidence and exact runtime identity before creating a lock, verifies current provider prices, installs temporary gateway settings, runs both versions, and restores the settings. A new installation needs its own live evidence; shipped templates cannot certify it. Repeating these tasks is a regression check, not new independent quality evidence.

Still gated: persistent-host question continuation, live failure reconciliation, concurrent Muse hosts, and native child agents. Aider/SWE-bench/Harbor import/container adapters remain unimplemented. The tested path is serial local Node coding on macOS.
