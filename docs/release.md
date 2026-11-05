# BranchPilot 0.1 CLI MVP

The deliverable is a local command-line search controller with an offline demonstration and a gated Muse adapter. It supports code, optimization, and idea tasks; direct/retry/best-of-N/tree strategies; fixed/automatic policies; budgets; immutable file snapshots; external and human evaluation; recoverable persistence; and reports.

## Acceptance

| Path | Verification |
|---|---|
| Create → run → inspect → report → export | Runnable fixtures and CLI integration tests |
| Pause → switch → resume | Same run, original deadline, cumulative spending |
| Concurrent alternatives | Bounded waves, reserved evaluation capacity, stable archive order |
| Crashes and unknown work | Receipts import once; ambiguous work never automatically resubmits |
| Backend question and reconciliation | Pinned SDK exercised over synthetic frames; live answers require persistent-host integration |
| Budget stop | Usage-driven cancellation with terminal confirmation and preserved overruns |
| Evaluation | Correctness gates, fixed definitions, repetition ranges, Pareto alternatives |
| Held-out assessment | Frozen finalists; shared exposure history and optional strict reuse refusal |
| Repository workflow | Offline vendored npm install and disposable Node builds |
| Performance | Indexed frontier, copy-on-write state, checkpointed cache, opt-in deterministic correctness reuse |
| Frontier policy | Exact catalog preferences, highest advertised known effort, durable confirmed settings, no implicit cheaper fallback |
| Search handoffs | Bounded development history, changed-file summaries, independent alternative prompts, repeated-failure escape |
| Paired comparison | Frozen tasks/build, per-version deadlines, matched limits, confirmed model checks, held-out/statistical improvement gate |
| Distribution | Private npm tarball with CLI, source, examples, performance runner, and docs |

Run `npm run release:check` locally. It does not launch Muse or contact a model provider. `npm run demo` produces a complete small result; `npm run bench` produces repeated fixture comparisons. Configured CI is not evidence of a remotely completed CI run.

Latest local verification on November 4, 2026: strict TypeScript compilation and all **214 offline tests passed**. The [research pass](research-improvements.md) added frontier model preferences, confirmed model reporting, bounded branch handoffs, distinct alternative prompts, and repeated-failure handling. The [paired comparison](benchmark-guide.md) defaults to one hour per version and refuses to certify model improvement from fixtures, missing evidence, mismatched settings, or unresolved usage. Its local fixture workflow was exercised end to end. No live model quality claim is made. The original and current controller each completed three new performance repetitions with identical workload evidence; median complete fixture runs were 11.7% and 34.8% faster on the two end-to-end workloads. See [measurements and reproduction](performance.md). The previous acceptance pass exercised all three starter templates through the actual CLI. The refreshed tarball is checked by extraction into a fresh temporary directory, using already-installed pinned dependencies without network access, then project creation, the repair demo, run listing, artifact verification, and the paired fixture workflow. Package inspection excludes tests, node_modules, and private run data. Packaging uses a project-local npm cache.

## Remaining acceptance gate

The November 4 Muse audit updated the exact SDK pin to **1.4.14**, corrected experimental permission negotiation and asynchronous settings confirmation, isolated runtime-home/API-key configuration, and preserved liabilities for parent-excluded child work. All **182 offline tests passed**. See [the sourced audit](muse-compatibility.md). Owned stdio shutdown cancels active turns, so live question continuation is explicitly unavailable until persistent-host integration exists; a lock flag cannot enable it.

**Real Muse execution has not been verified.** The executable is not on the current PATH, and live testing was excluded from the implementation request. The compatibility lock template intentionally remains invalid. No authentication or provider use was attempted.

When live testing is available, follow the README's `smoke-plan`, `smoke-run`, and `smoke-report` workflow. Verify the exact SDK/binary pair, settings, authentication, a real edit and external evaluation, complete usage, cancellation and child termination, filesystem/runtime-home isolation, durable answers, reconciliation, and concurrent-host isolation. Simulations and compilation cannot substitute for these checks. Only then supply an accurately attested compatibility lock.

## Scope after this MVP

Future extensions: a web interface, Linux/container isolation, registry dependency downloads, non-Node build ecosystems, model-judgment evaluators, statistical resampling policies, distributed scheduling, and continuously refilled worker pools. The present CLI uses bounded, explicit procedures.

Limits remain visible in reports: fixture edits/tokens are synthetic; observed ranges are not confidence intervals; exposure history is incomplete outside its registry; token cancellation is not a hard provider cap; and trusted-fixture mode is not suitable for adversarial code.
