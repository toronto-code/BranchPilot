# Implementation status

Updated November 5, 2026. The CLI now has a tested serial Muse 1.4.14 path with Wonder max, per-attempt isolated homes, exact-command approvals, a request-level spending guard, and grading/continuation of safely stopped budget checkpoints. All 231 regression tests pass. A fresh live pilot tied 4/4 on correctness while using 9.2% fewer tokens and 12.3% less elapsed time; these are single-pilot observations. [Full live results, earlier failures, and remaining gates](live-muse-results.md). Earlier sections below retain their historical verification scope; their statements that Muse had not run are superseded by this update.

## Implemented and exercised offline

- Strict configuration separates task, backend, model/effort, strategy, policy, budget, and execution profile.
- Direct, retry, best-of-N, and a deterministic tree beam per depth; manual and automatic switches retain accounting and evidence.
- Baseline/candidate snapshots, immutable lineage, retry feedback, proposals/hypotheses, and snapshot export.
- Executable evaluators, correctness dependencies, repetitions/warmups, frozen seeds/assets, strict parsing, mutation detection, metric thresholds, and compatible Pareto comparison.
- Frozen held-out selection, reserved finalization capacity, and incomplete/failed outcomes.
- Human rubric pauses and assessments with rater provenance.
- Central admission for tokens, work seconds, attempts, experiments, and wall deadline. Unknown usage blocks further dispatch.
- Checksummed append-only transactions, durable execution intent, completion receipts, cache-independent replay, interrupted-tail quarantine, and exclusive local writer.
- Recovery releases proven unstarted work, imports receipts once, and never automatically repeats uncertain dispatched work.
- Owned evaluator process groups, bounded output, cancellation escalation, CLI reporting, and fixture demos.

Tests cover process interruption, partial logs, missing usage, held-out failures, malformed/mutating evaluators, tree bounds, baseline validity, and the CLI checkpoint/switch/resume/export flow.

## Repository review

The subsequent full-repository review reproduced and fixed additional errors with focused regressions:

- Continuation requires a fresh usage observation after answering. Historical totals remain lower bounds, including overruns, and never replace missing final usage. Reconciliation rejects contradictory terminal records rather than promoting the last one.
- Every configured evaluator in the applicable split must pass before feasibility. Mixed passing/not-applicable repetitions are inconclusive. Pareto dominance no longer treats a meaningful-change threshold as permission to worsen another objective.
- Tree proposals examine only populated depths, so an exhausted tree cannot freeze the controller by looping to an enormous configured depth.
- Unknown/repeated CLI options, invalid counts, and missing arguments fail before storage creation. Package-bin symlinks run the entry point correctly, and failed setup removes signal handlers. Configuration rejects unsafe integer counts, duplicate constraint/objective identities, and empty resource-group names.
- Operator resolution releases unused evaluation escrow for failed work. Evaluator materialization failures release proven-undispatched reservations without charging a procedure.
- Evaluator definitions and supporting assets are checked against the real input path, closing directory-alias exposure of trusted or held-out files.
- Committed event transactions survive rebuildable projection-cache errors, which are reported as warnings. Failed atomic writes clean temporary files, and store initialization failures release the writer lock.
- Process output preserves UTF-8 split across chunks and applies byte-based limits. An already-cancelled process request never spawns its executable.

`test/audit.test.ts` covers these repository regressions; recovery-specific cases also live in `test/recovery.test.ts`. The compiler now checks unused locals and parameters. The review covers runtime source, persistence, CLI/configuration, examples, tests, documentation, and CI; real Muse compatibility remains outside offline proof.

## Question continuation, reconciliation, and concurrency

Priorities 3 and 4 now have runnable controller/CLI machinery and offline simulation coverage:

- `answer RUN_DIR WORK_ID answer.json` validates one answer per saved question, including IDs, labels, selection bounds, and text length. It reserves additional token/time capacity, resumes the original session through SDK 1.4.13, and answers that session's original pending input. It never submits `turn/start`. An acknowledgement alone is insufficient: the matching command must durably settle the question and the original turn must terminate before output is promoted.
- `reconcile RUN_DIR WORK_ID` reads `session/read` and at most 100 `view/page` pages of up to 1,000 events each. It never attaches or replays a turn. Session, workspace, permission profile, command-to-turn association, terminal state, and normalized usage must agree. Missing, truncated, foreign, non-durable, or ambiguous evidence retains uncertainty. Read-only cleanup can run after deadline/budget exhaustion and records its bounded elapsed time; provider-capable answering still passes admission.
- Every recovery operation has its own durable intent and receipt, while original attempt/session/turn identity and cumulative accounting remain intact. Answer command IDs persist before sending and survive later inconclusive reads. Receipt recovery imports revisions and clears only the matching work's input exactly once. Known token lower bounds cannot be erased by missing later usage. Separate work-keyed input records support concurrent questions.
- Best-of-N attempts run in bounded waves up to `maxConcurrency`. Before any dispatch, each attempt reserves tokens, attempt time/count, and a per-evaluator development escrow. Evaluators atomically transfer their escrow into executable work; unused holds are released after dependency gating, failure, or cancellation. Work and evaluation records have deterministic archive order despite out-of-order completion.
- Independent candidate evaluations use a bounded queue and in-run `resourceGroup` exclusion. Shared groups serialize, separate groups may overlap, and dependencies stay ordered within each candidate. Human checkpoints remain sequential. Retry/tree development is never parallelized.
- All active attempts/evaluations are awaited before returning, pausing, switching, or finalizing. Cancellation reaches the whole wave. Unknown work or missing usage blocks the next wave. `--pause-after` bounds an incomplete final wave exactly. One controller and writer still own the run.

`test/recovery.test.ts` exercises successful answer/continue and reconciliation, bad/expired question identity, foreign sessions/workspaces/turns, absent usage/durability/terminal evidence, lost answer acknowledgements, crash receipts, deadline handling, multiple pending works, and CLI answer/reconcile/resume. `test/concurrency.test.ts` exercises overlap and limits, reservations, stable selection under reversed completion, shared versus independent evaluator groups, cancellation, uncertainty barriers, sequential retries, and recovery of undispatched waves. `examples/concurrent.json` is an opt-in fixture demonstration.

These tests launch evaluator processes and use the real pinned SDK over synthetic in-memory host frames. They launch no Muse executable or provider connection. Live answer, host reconciliation, and concurrent host isolation require separate lock flags (`questionContinuationVerified`, `hostReconciliationVerified`, `concurrentIsolationVerified`), all false by default. Existing locks cannot silently enable these capabilities. No compatibility lock was created or marked verified.

## Correctness review and offline Muse boundary

The follow-up review fixed these concrete gaps, with focused regressions:

- Unknown work retains observed usage, including overruns above its reservation. The ledger conservatively holds the larger amount until settlement; operator resolution cannot erase observed tokens or elapsed time. Invalid token counts and nonfinite/negative elapsed usage are rejected.
- If an attempt stops but its output cannot be captured, its paid usage and failed outcome remain durable; the controller does not repeat the attempt.
- Cancellation during the final held-out procedure preserves the cancelled run outcome. Further search or development evaluation is rejected after finalist selection, and evaluator phases cannot borrow another split's reserve.
- Tree parents retain allocated beam slots when new revisions change the Pareto frontier. Width, depth, and cumulative child limits still bound subsequent expansion.
- Recovery imports a completed human-assessment receipt and clears the answered pending checkpoint exactly once, including a crash before its completion transaction or prompt-clear event.

`src/muse.ts` keeps local lock/digest verification, sandbox construction, and real host launch. `src/muse-protocol.ts` accepts only a host factory with initialization and close operations; all connection, session, approval, fold, and turn behavior uses the pinned SDK. Production enters this engine only after the existing gate. There is no CLI simulation override for a Muse configuration.

`test/muse-host.ts` supplies a clearly identified in-memory NDJSON host; its synthetic protocol expectations are not compatibility attestations. No executable or authentication is needed. `test/muse.test.ts` exercises:

- Initialization refusal, fingerprint/version mismatch, required permission-profile refusal, host defaults, explicit model/effort selection, unsupported catalogs, and readback mismatches before dispatch.
- Streamed item revisions, normalized cumulative usage, missing/invalid usage, offered approval denial, absent denial choices, and host refusal of a denial command.
- Pending question IDs, including a question followed immediately by a terminal before polling, with no fabricated answer. The correct work/session identities and question artifact remain durable and block controller resume.
- Cancellation with and without terminal confirmation, completion/cancellation races, abort during submission, and failed host shutdown. A cancel acknowledgement alone leaves work unknown.
- Disconnects before and after submission acknowledgement, durable IDs and exact turn payload before transmission, turn identity learned from an event before a lost acknowledgement, and reported usage retained after EOF. Durable, ephemeral, and unrecognized durability profiles never authorize automatic resubmission.
- A simulated edit followed by real executable evaluation against an immutable snapshot, plus replay/resume checks for unknown work and missing usage.

Run everything with `npm test`, or build and run `node --test dist/test/review.test.js dist/test/muse.test.js` for the focused regressions and protocol simulations. These tests exercise controller/SDK behavior against synthetic frames; they do not establish that an installed Muse runtime emits those frames or enforces the requested settings.

## Implemented but not verified with Muse

`src/muse.ts` uses actual types/methods from `@muse-code/sdk` 1.4.14. It checks the binary/lock, initializes MSP, verifies schema fingerprint and server version, requests a permission profile, lists models, applies explicit model/effort settings, checks readback, and starts one turn in a fresh session.

The SDK ID mint records command IDs and the exact turn payload before submission. Session/turn identity, stream items, usage, questions, approvals, cancellation, and terminal outcomes are persisted. An observed turn ID can survive a lost acknowledgement. Ambiguous terminal state stays unknown. Approvals are denied; denial failures request cancellation. Native session forks are disabled.

**No Muse process was launched during implementation.** Compilation does not establish runtime compatibility, authentication, complete token accounting, worker containment, or cancellation behavior.

Before enabling a real run, independently verify:

1. Exact SDK version, binary version/hash, and handshake schema fingerprint.
2. A dedicated authenticated runtime home and an accepted permission profile.
3. Model/effort readback, streaming, and terminal event semantics.
4. Timeout/cancellation, host shutdown, and absence of surviving child work.
5. Isolation between candidate, evaluator, held-out assets, run log, and user files. The runtime home is shared by attempts; ensure it cannot expose prior held-out results.
6. Token accounting for every billable child/tool worker; disable untracked workers.
7. Disconnects around submission, unknown outcomes, and user-input behavior.

The lock is an operator attestation to this exact setup. Its deliberately invalid template cannot authorize execution. `doctor` checks only local fields and binary hash, not these live properties.

## Remaining implementation

| Work | Current behavior |
|---|---|
| Verified Muse pair | Opt-in evidence harness built and simulated; actual live verification still required; adapter gated |
| Live answer/continue compatibility | Protocol engine simulated; current owned stdio transport cannot preserve a question across shutdown; persistent-host integration required |
| Live host reconciliation compatibility | Explicit read-only CLI/state/SDK flow simulated; separately gated; no automatic replay |
| Concurrent Muse isolation | Fixture scheduling and evaluator exclusion exercised; real concurrent hosts separately gated |
| Linux/container isolation and adversarial evaluation | Trusted fixtures or macOS sandbox profile |
| Hard provider token cap | Active usage-driven cancellation implemented; delayed counters and cleanup can overshoot |
| Noise-aware resampling and richer allocation | Small deterministic preset |
| Model-judgment evaluators and judge calibration | Unsupported runtime evaluator kind |
| External holdout-exposure history | Local shared registry implemented; exposure outside it still needs operator tracking |
| Registry dependency downloads and other build ecosystems | Offline npm/vendored dependencies and Node build steps supported; broader installation unsupported |
| Web interface | CLI and Markdown/JSON reports |

The compatibility smoke test is the next step needing Muse. Authentication, real provider calls/edits, advertised settings and event semantics, complete billable usage, process/descendant cancellation, enforced isolation, durable question continuation, reconciliation of real host failures, and concurrent-host isolation remain unverified. Automatic recovery polling, command replay, and the extensions above remain separate work.

## Offline completion and initial result optimization

The remaining supporting machinery is implemented and exercised without launching Muse:

- `muse-smoke.ts` provides local `smoke-plan`/`smoke-report` operations and separately opt-in future `smoke-run` cases for completion, cancellation, host failure, and OS isolation. Binary and installed SDK identities are bound at preparation and rechecked before execution. The writer lock serializes cases. Durable intent precedes host creation; event artifacts preserve command/session/turn IDs. Each case is single-use, even after a crash. Both live/cost flags are mandatory. The harness never creates a compatibility lock, and every summary keeps compatibility unverified. Its simulations use the actual pinned SDK. No live case, including the OS probe, was executed during implementation.
- Executable evaluator definitions support an optional repository workflow: offline npm installation with lifecycle scripts disabled, followed by explicit Node build scripts. The candidate is copied to disposable storage, separate from immutable inputs, and compiled output is exposed through `BRANCHPILOT_BUILD_DIRECTORY`. The frozen definition includes npm version and entry/manifest digests. Setup/build/repetitions use the same timeout and accounting. All owned process evidence is saved; build errors become candidate feedback, while setup/tool failures stop for infrastructure attention. Vendored dependencies need no network or pre-existing node_modules. `examples/repository.json` demonstrates installing a local package, building, and testing the compiled export.
- Optional `branchpilot-result.json` captures a strict proposal/hypothesis structure, with unique IDs and bounded size/count. Normal execution and reconciliation share parsing and preserve candidate claims separately from evidence. Invalid output cannot be promoted, but its measured usage and proven termination remain durable; it cannot trigger blind re-execution. Reports expose hypotheses for code and optimization tasks as well as ideas.
- Opt-in `task.selection.earlyStop: first_feasible` stops code search once every configured development assessment and constraint passes. It is accepted only for code tasks without optimization objectives and with all-constraints acceptance. It checks settled waves, retains spending and reservations, and still freezes finalists before held-out assessment. A held-out failure cannot restart the search. Existing configurations keep their full-search behavior.
- `benchmark.ts` and `npm run bench` run repeated, interleaved fixture cases and save exact inputs, frozen evaluators, environment/controller identities, outcome/cost data, objective improvements, elapsed ranges, and each complete underlying run. Muse and human checkpoints are rejected by this offline command. Reports distinguish fixture usage from actual executable results and make no model-quality claims.

The first three-repetition paired repair measurement kept fixture plans, budgets, input, and evaluators identical. Full search and early stop both produced `goal_met` in every repetition. Early stopping used 120 versus 480 fixture tokens (75% less), one versus four attempts, and two versus five evaluator procedures (60% less). The optimization case retained `best_found` in all repetitions with compatible, externally measured input-read improvements. These are deterministic fixture results, not estimated provider savings or proof of real-model quality. Wall timings are observations only.

`test/finishing.test.ts` covers structured claims and malformed-output accounting, reconciled output failures, observed token lower bounds, offline installation/script suppression/disposable builds, build-feedback retries and timeouts, wave-boundary early stopping, held-out immutability, smoke opt-ins/local-only preparation, SDK simulations of its cases, binary changes, single-use execution, and paired budget measurements. Missing usage appears as unresolved in benchmark summaries, never as zero-cost success. Final local verification passed strict type checking, all 136 offline tests, all 10 runnable example configurations, and whitespace checks. `npm run bench` generates reviewable measurements. Broader statistical allocation and UI work remain deferred until real execution is verified.

## Further repository audit

The next audit reproduced seven additional failures before applying fixes and checked the remaining execution, recovery, persistence, workspace, CLI, report, example, dependency, and CI paths:

- A requested pause now takes precedence over first-feasible stopping. It cannot finalize or consume held-out evidence before the explicit checkpoint. Retry stopping checks the current candidate, rather than a different candidate's latest archived revision.
- Finite repeated measurements no longer overflow while averaging the middle samples. Large finite and subnormal values survive JSON persistence without becoming null or zero accidentally.
- Benchmark output is rejected inside any candidate input, through real-path checks performed before writing suite files or creating output parents.
- Unknown terminal strings never prove stopping in either normal execution or recovery. Recovery pages require the SDK's actual durable provenance shape (`stream`, `first`/`last` record positions, and view cursor), and oversized pages are rejected before being stored. Protocol fixtures now use the pinned SDK's generated `SourceRange` type, while remaining explicitly synthetic.
- Reconciliation requires valid latest usage after the latest answered input. Historical totals remain observed lower bounds. A work-level `usageAfterAnswer` record survives answer settlement, receipt import, and repeated inconclusive reads until usage is resolved. Invalid latest counters cannot fall back to an earlier value as a final total.
- New executable work and model-capable continuation require the frozen Node/OS/CPU/isolation identity. A mismatch pauses for attention without invalidating prior work. Read-only cleanup remains available. Muse compatibility settings are compared with the frozen manifest at admission/recovery and host launch, and local SDK metadata must match the pinned version; mutable lock files cannot silently change a run's runtime profile or enable new capabilities.
- Candidate metadata and smoke edit inspection use bounded regular-file reads with no-follow/nonblocking opens. FIFOs cannot hang the controller, oversized files cannot bypass a prior stat, and symlink output is rejected. Smoke observations retain terminal/usage evidence for missing or invalid edit output and skip uncertain workspaces entirely.
- Attempt timeouts are bounded to Node's supported timer range; unrepresentable wall deadlines and invalid worker timeout/grace values fail before execution.

`test/repo-audit.test.ts` adds 12 regression tests with real fixture/evaluator execution and SDK protocol simulations, including repeated stale reconciliation, invalid latest usage, absent durability metadata, oversized pages, environment restoration, FIFO handling, and malformed smoke outputs. Final local checks passed all 148 tests, strict TypeScript checking, all 10 runnable example configurations, and whitespace validation. No Muse process or provider was contacted, no compatibility lock was fabricated, and real runtime compatibility remains unverified.

## CLI MVP completion — November 3

- New configs request cancellation when observed usage reaches the reserved allocation. Streaming lower bounds persist before cancellation and remain in active/unknown liabilities. Continuations use their enlarged cumulative allocation. Without terminal evidence the work stays unknown. Observe-only mode is explicit; legacy logs retain their previous behavior. SDK polling/cancellation are simulated, not live-verified.
- Shared evaluation history records first exposure with checksummed, atomic no-overwrite publication. Default mode discloses reuse; strict mode rejects prior/development exposure before search and checks again at dispatch. Stable dataset IDs survive evaluator-code changes. Crash claims stay exposed; original-run resumes remain idempotent. This is local evidence, not a global contamination guarantee.
- Normal execution now rejects invalid/decreasing final usage instead of finalizing an earlier counter. Answer cancellation requests terminal evidence before shutdown; a subsequent question still pauses without cancelling the original turn.
- `init` creates standalone offline projects, `runs` lists saved results, and `verify` checks event/artifact/snapshot integrity without execution or workspace dependence.
- Private release packaging includes the compiled CLI, source, examples, and documentation through an explicit allowlist. `release:check` validates compilation, the offline suite, and package assembly. Publishing and live verification are separate actions.

`test/completion.test.ts` covers allocation stops, uncertain cancellation, usage after failure/replay, invalid final totals, exposure reuse/races/identity changes/corruption, starter projects, run listing, and integrity verification after workspace deletion.

Final local validation passed strict compilation, all 161 offline tests, all three starter-template CLI flows, and a fresh-directory extracted-package smoke test using existing dependencies without network access. The private release archive and its package manifest are under `.branchpilot/releases/`. No Muse process was launched and no compatibility attestation was fabricated.

## Performance and evaluation efficiency — November 4

The controller now uses copy-on-write reducers, stable ordered insertion, indexed frontier comparisons, and checkpointed projection-cache writes. Every event-log transaction remains checksummed and fsynced; state readers and recovery replay that log. Failed transactions cannot partially mutate the prior projection. Passive stream events no longer copy or serialize the whole archive. Tree proposals compute one frontier.

Executable development correctness evaluators can explicitly declare `reuseIdentical`. The scheduler coalesces concurrent identical checks and reuses only a settled, passing, metric-free result for the same snapshot/definition/environment in the same run. It verifies the current environment, releases the target attempt's unused evaluation escrow atomically, and preserves the original experiment/evaluation provenance. Failed, changed, metric-bearing, objective, human, and held-out assessments remain fresh. Default behavior is unchanged. Reports identify reused evidence rather than presenting it as new measurement.

`npm run perf` measures five offline workloads against a selected compiled implementation; `npm run perf -- --suite reuse` alternates fresh/reused-check cases. Three repetitions measured roughly 60× faster frontier calculation on 250 tradeoff candidates, 3.2× faster persistence of 1,000 stream events, and 34% lower elapsed time for a 500-item streaming repair. Default outcomes and resource totals matched the saved original implementation. Reuse reduced evaluator procedures from nine to two while preserving the eight-attempt outcome and fixture token total; median elapsed time fell 21%. These describe fixture/controller performance, not live-model quality.

All 171 offline tests passed, including ten performance/efficiency regressions. See [performance details](performance.md) for complete ranges, method, implementation digests, opt-in semantics, and reproduction. The local original compiled implementation and raw measurements are retained under `.branchpilot/performance/`. No Muse process was launched.


## Muse documentation audit — November 4

The official SDK/source/npm metadata was checked and the exact dependency pin updated from 1.4.13 to 1.4.14. Earlier status entries describe the earlier implementation; this audit supersedes their live-answer readiness assessment. [Research, sources, configuration, and limitations](muse-compatibility.md).

The adapter now negotiates experimental permission readback explicitly and verifies the result. It confirms denial mode, session identity, workspace, and asynchronous model/effort application before submitting a turn. The simulated host withholds experimental fields unless negotiated, so an omitted handshake opt-in can no longer pass the tests. Non-durable hosts and reported unavailable sandbox enforcement fail before model work. SDK stable-schema warnings are recorded while the independently verified runtime fingerprint/version remain mandatory.

The backend manifest now binds all installed SDK JavaScript module hashes. The child environment uses explicit HOME/XDG paths and an optional named META_API_KEY input; key values are not serialized and a missing configured key blocks admission. Root-session counters exclude child work: visible native child/workflow/background items request cancellation, preserve unknown usage and stop status, and persist an untracked-work marker. Parent-only recovery cannot settle that liability.

The published stdio shutdown contract cancels active turns. Live answer continuation is consequently disabled for this transport, regardless of an attestation flag; the protocol engine remains simulated for future persistent-host integration. Normal live execution declines dialogs and cancels unexpected questions. Read-only reconciliation and concurrent hosts retain separate gates.

All 182 offline tests passed against the actual pinned SDK, including eleven new compatibility regressions. The Muse template validates without executing a host. No Muse process, authentication, provider request, live smoke case, or fabricated compatibility lock was used.
