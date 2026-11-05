# BranchPilot

A local TypeScript controller for budgeted coding and experiment search. It owns candidate snapshots, external evaluation, strategy decisions, accounting, checkpoints, and reports.

**The CLI runs offline and with a live Muse 1.4.14 runtime.** The pinned SDK/runtime pair has completed a real edit with reported usage and an OS isolation probe. A guarded coding pilot exercises Wonder at max effort with external development and hidden grading. Verified locks are specific to the tested installation; the shipped template remains deliberately invalid. See [live results and limitations](docs/live-muse-results.md) and [release scope](docs/release.md).

For difficult Muse work, start with [the frontier template](examples/muse-frontier.template.json): prefer an advertised **Muse Wonder Full**, allow **Wonder** as an explicit fallback, and use the highest advertised known reasoning effort. It never falls back to Spark. Actual runtime IDs, entitlement, and settings still need verification. See [model policy and research-inspired improvements](docs/research-improvements.md).

For comparisons, the [benchmark guide](docs/benchmark-guide.md) defaults to **up to one hour per version**: one direct Muse attempt versus up to three BranchPilot attempts per task, with matching model and total allowances. The live pilot adds a request-level **US$40 campaign guard**, including setup and reruns, within the authorized C$150 ceiling. Token cancellation alone is not a dollar cap. Fixture improvements, incomplete trials, mismatched models, and unknown usage cannot establish a model-quality gain. Public benchmark import/container adapters remain separate work.

## Run without Muse

Use Node.js 22 or newer on macOS or Linux:

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

`demo` fixes a deliberately broken addition function, evaluates the original and candidate, and prints a run directory and report path. Input files stay unchanged. Candidate changes are stored in snapshots and can be exported.

Create a standalone project or browse saved results:

```sh
npm start -- init /absolute/new-project --template code
npm start -- run /absolute/new-project/config.json --out /absolute/new-project/runs
npm start -- runs /absolute/new-project/runs --limit 20
npm start -- verify RUN_DIRECTORY
```

Templates are `code`, `optimization`, and `idea`; all use the offline fixture backend. `init` refuses existing directories. `runs` lists recent results and reports unreadable runs individually. `verify` checks the event chain, artifact hashes, and referenced snapshot contents without executing anything; stop the writer first. It does not certify evaluator validity or runtime compatibility.

After the first build, use `npm start -- <command>`:

```sh
npm start -- run examples/retry.json
npm start -- run examples/auto.json
npm start -- run examples/optimization.json
npm start -- run examples/ideas.json
npm start -- run examples/tree.json
npm start -- run examples/concurrent.json
npm start -- run examples/repository.json
npm run bench
```

| Example | Demonstration |
|---|---|
| `repair.json` | Direct attempt; failing baseline becomes a passing candidate |
| `retry.json` | Incorrect first edit, evaluator feedback, second revision of the same candidate |
| `auto.json` | Logged switch from direct to retry without resetting spending |
| `optimization.json` | Three alternatives, correctness gates, repeated measurements, Pareto selection, held-out assessment |
| `ideas.json` | Proposals and falsifiable hypotheses; structure checks do not establish scientific validity |
| `tree.json` | Bounded branching and deeper development from archived revisions |
| `human-review.json` | Explicit human rubric assessment and resume |
| `concurrent.json` | Independent best-of-N attempts in waves of two; shared evaluator resource group |
| `repository.json` | Offline installation of a vendored npm dependency, disposable build, compiled-output evaluation |
| `benchmark.json` | Three repeated, interleaved fixture cases with outcome, budget, and objective measurements |

The optimization example measures indexed array reads on synthetic data, **not runtime latency**. Reports distinguish fixture token counts, executable evidence, human assessments, and untested idea claims.

## Checkpoints and reports

Substitute the printed absolute run directory for `RUN_DIR`:

```sh
npm start -- run examples/retry.json --pause-after 1
npm start -- inspect RUN_DIR
npm start -- switch RUN_DIR '{"name":"best-of-n","n":2}'
npm start -- resume RUN_DIR
npm start -- report RUN_DIR
npm start -- export RUN_DIR REVISION_ID EMPTY_DIRECTORY
```

Switching keeps the run ID, original wall deadline, revisions, evaluations, and cumulative spending. It starts a new strategy epoch; manual switching sets policy to fixed. Finalist selection is irreversible within a run. Completed or cancelled runs cannot restart search.

An explicit `--pause-after` checkpoint takes precedence over early stopping, so it cannot silently trigger held-out assessment. A retry continues its own candidate even when another archived candidate already passed. Before executing new work, BranchPilot checks the frozen Node/OS/CPU/isolation identity; restore that environment or start a new run if it changes. Read-only reporting and host reconciliation remain available for cleanup.

Fresh-session handoffs include current development evidence, cumulative changed-file summaries, and bounded ancestor history. Tree branches can also see labeled sibling findings; best-of-N remains independent. Alternatives receive different task-specific focus prompts. Automatic retry switches to independent alternatives when two settled attempts repeat identical content and complete failed development evidence. Fixed retry limits remain unchanged, and no extra model calls are added for these decisions.

`inspect` lists revision IDs, status, pending assessments, and the budget ledger. `report` reconstructs Markdown from the event log and artifacts. Each run also has `report.md` and `report.json`. `export` accepts only an empty destination.

The CLI rejects unknown/repeated options and invalid argument counts before creating run storage. The event log is authoritative and every transaction is fsynced. The rebuildable `state.json` cache refreshes at checkpoints and periodically during state changes; it can lag during an active run. CLI reads replay the verified log. Cache-write failures are reported as storage warnings without invalidating committed work.

Press Ctrl-C to cancel and settle active work. After a crash, `resume` imports durable completion receipts exactly once. Dispatched work without a receipt becomes unknown and stops the run. Missing token usage remains a liability.

Reported usage survives uncertain execution and output-capture failures. Unknown work holds at least the larger of its reservation and observed usage; overruns are never clipped to the reservation. Operator resolution cannot reduce usage already recorded. A recovered human assessment clears its answered checkpoint without requesting or charging for it again.

New configurations default to `budget.tokenLimitPolicy: "cancel-at-reservation"`. While a turn runs, the adapter observes normalized session usage and the scheduler requests cancellation when it reaches the attempt's reserved tokens. Continued answers use their enlarged cumulative allocation. Lower bounds are persisted before cancellation. `"observe"` records usage without requesting a token stop; old persisted configs without the field retain this behavior. Polling is every 100 ms, so delayed counters and cancellation can overshoot: this is **not a hard provider token cap**. Acknowledgement without terminal evidence keeps work unknown. Invalid or decreasing latest usage cannot turn an earlier counter into final spend.

After independently confirming that unknown work has stopped and measuring its actual usage, record the evidence:

```sh
npm start -- resolve RUN_DIR WORK_ID --tokens 123 --seconds 4.2 --evidence evidence.json --stopped
npm start -- resume RUN_DIR
```

This records an operator assertion, not automatic process verification. Unknown attempts resolve as failed; their output is not silently promoted into a candidate.

## Backend questions and host reconciliation

`inspect` exposes each pending backend question with its work, session, turn, question, and input IDs. Create an answer file using exactly those IDs and offered labels:

```json
{"userInputId":"INPUT_ID","answers":[{"questionId":"QUESTION_ID","selectedLabel":"Offered label"}]}
```

Answer every question once. `freeText` (up to 500 characters) or `selectedLabels` for a multiple-choice question may replace `selectedLabel`; each entry may also include a `note`.

```sh
npm start -- answer RUN_DIR WORK_ID answer.json
npm start -- reconcile RUN_DIR WORK_ID
npm start -- resume RUN_DIR
```

`answer` validates the saved request, reserves continuation capacity, reattaches to the original session, and waits for durable question settlement and the original turn's terminal result. It never starts a replacement turn. Answers and their command IDs are recorded before transmission. An uncertain answer cannot be submitted again until reconciliation establishes what happened.

`reconcile` reads the saved session and bounded, cursor-paged history without resuming it or replaying a command. It requires matching session/workspace/turn identity and terminal evidence before importing output. Missing usage and ambiguous outcomes still block search. Read-only inspection remains available after the run deadline; its elapsed time is charged. Multiple pending works retain separate question records.

Recovery validates durable source ranges against the pinned SDK's wire types and rejects pages larger than 1,000 events. Unrecognized terminal values remain unknown. An answer creates a persistent usage requirement: historical pre-answer totals, malformed latest usage, or absent answer-settlement evidence cannot become final spend, even after repeated reconciliation. `inspect` exposes this as `usageAfterAnswer` until fresh usage or measured operator resolution settles it.

These paths are exercised through offline SDK simulations. **Live Muse answering is unavailable with the current owned stdio transport:** closing the host cancels its active turn. A compatibility flag cannot enable it; persistent-host integration is still required. Production runs decline dialogs and cancel/preserve any unexpected request. The answer engine remains available to simulations and future backend implementations. Live read-only reconciliation remains gated by `hostReconciliationVerified`, false when absent. A terminal/cancelled question cannot be continued; reconciliation can settle or clear the stale request. See the [Muse audit](docs/muse-compatibility.md).

## Concurrency and resource groups

Set `budget.maxConcurrency` above one to overlap independent best-of-N attempts. The controller reserves every attempt and its development evaluation bundle before launching a wave, waits for all active work, then evaluates the resulting snapshots. Archive and selection order follow dispatch intent, independent of completion timing. Direct, retry, and tree development stay sequential; human assessments keep their explicit checkpoint order.

Executable evaluations for independent candidates may overlap within the same limit. Give evaluators the same `resourceGroup` to exclude overlapping procedures in that group within a run. Different groups may overlap. Finalization and switching occur only after the wave settles; uncertainty stops further dispatch. `--pause-after` limits attempts exactly, including partial waves. Finalization reserves remain protected, and cancelled runs release unused evaluation holds.

Concurrent live Muse execution additionally requires `concurrentIsolationVerified` in the compatibility lock. No such verified lock is shipped. Resource groups coordinate this controller's workers; they do not lock unrelated processes or other runs.

## Evaluators

Configuration paths are relative to the configuration file. Trusted evaluators must be outside the candidate input directory. Use `--out` to choose run storage outside the input tree. Snapshots include ordinary tracked and untracked files, reject symlinks, and exclude `.git`, `.branchpilot`, `.branchpilot-tmp`, `node_modules`, `.env*`, `.aws`, `.codex`, and `.agents`. Each snapshot is limited to 64 MiB and 10,000 files.

An executable evaluator definition names a Node.js module and explicit supporting files:

```json
{"schemaVersion":1,"script":"check.mjs","files":[],"seed":1}
```

BranchPilot freezes these files before search and runs `node check.mjs INPUT_DIRECTORY` with a scratch working directory and a reduced environment. Definition and asset locations are checked using their real paths so directory aliases cannot hide evaluators inside candidate inputs. `BRANCHPILOT_SEED` comes from the frozen definition; the evaluator must implement seeded randomness itself. `BRANCHPILOT_REPETITION` includes warmups. The timeout covers the entire procedure, including all warmups and repetitions.

Exit zero and write exactly one JSON value to stdout; diagnostics belong on stderr:

```json
{
  "validity":"pass",
  "checks":[{"id":"output-correct","outcome":"pass"}],
  "metrics":[{"name":"input_reads","unit":"reads","value":500}],
  "feedback":"Output matches the reference on the declared cases.",
  "findings":[]
}
```

Use `validity: "fail"` for a candidate failure. Process errors, malformed output, and changed input/evaluator assets are infrastructure failures. Validity values are `pass`, `fail`, `inconclusive`, and `not_applicable`; check outcomes are `pass`, `fail`, and `unknown`. Every configured evaluator for the current split must pass for a candidate to be feasible. Mixed passing/not-applicable repetitions are inconclusive. Each output stream is limited to 1 MiB of bytes, with UTF-8 decoded across chunk boundaries.

Use `dependsOn` to gate objectives on correctness. Dependencies must be acyclic and stay within one data split. Held-out evaluators run after finalist IDs are frozen; their failures affect the final outcome without restarting search. Reserve finalization capacity for the baseline plus the maximum finalists.

### Held-out reuse across runs

New runs record evaluation exposure in `.evaluation-history` inside their runs directory. Before execution or presentation of a human rubric, an atomic receipt records the first exposure. Default `evaluationHistory.reuse: "record"` permits repeated fixtures and benchmarks while disclosing reuse in reports; it does not claim independent held-out evidence.

For strict experiments, add this top-level configuration:

```json
{"evaluationHistory":{"directory":"./shared-evaluation-history","reuse":"reject"}}
```

Strict mode refuses held-out data already exposed in the registry or shared with development evaluation. It checks before search and atomically claims again before execution, so concurrent runs cannot both treat the same data as fresh. Interrupted claims remain conservatively exposed. Resume within the original run remains valid.

Give related evaluators the same stable `datasetId` to track data reuse even if their code changes. Without an ID, identity is the frozen evaluator definition digest. Keep the registry when archiving runs and share its directory across related experiments. This local history does not prove anything about exposure elsewhere, relabelled data, or semantic overlap. Legacy runs have no retroactive guarantee.

Repeated samples report a median and observed range, not a confidence interval. Dominance requires compatible units, evidence kinds, evaluator definitions, environments, and splits: no objective may worsen, and at least one must show a separated improvement above its meaningful-change threshold. Missing objectives are not measured success. Metric constraints apply to every matching sample, including held-out measurements. A correct optimization baseline can exceed a target metric limit; an incorrect or unmeasured baseline blocks comparison.

Median calculation preserves finite values at extreme magnitudes. Configuration rejects attempt timeouts beyond Node's supported timer range and wall deadlines that cannot be represented, rather than allowing timer overflow to turn a long timeout into immediate cancellation.

### Repository setup and builds

An executable evaluator definition can request a controlled workflow:

```json
{
  "schemaVersion": 1,
  "script": "check-build.mjs",
  "workflow": {
    "install": "npm-ci-offline",
    "build": [{ "script": "build.mjs", "args": [] }]
  }
}
```

BranchPilot materializes the candidate into a disposable project directory. Optional installation runs `npm ci --offline --ignore-scripts --no-audit --no-fund` with an isolated cache and npm configuration. Dependencies must be available in the frozen repository, such as vendored local packages; no registry downloads or lifecycle scripts are enabled. The npm CLI version and entry/manifest digests are frozen and checked before installation. Build scripts are repository-relative Node modules executed without a shell. Run each explicitly authorized build step in `build`; package lifecycle hooks are skipped.

The evaluator still receives the immutable input directory as its first argument, and `BRANCHPILOT_BUILD_DIRECTORY` points to installed dependencies and generated output. Setup, all build steps, warmups, and repetitions share one evaluator timeout and one experiment reservation; process receipts and time cover the complete procedure. Build failure supplies candidate feedback for retries. Installation/tool failures remain infrastructure failures. Original inputs, revision snapshots, and evaluator assets are checked for changes; generated dependencies/output stay in disposable storage. The configured isolation profile still applies, so trusted fixtures require trusted code.

### Structured candidate output

A backend may write optional `branchpilot-result.json` in its assigned workspace:

```json
{
  "schemaVersion": 1,
  "proposal": "Optional explanation",
  "hypotheses": [{
    "id": "faster-lookup",
    "assumption": "Repeated membership tests dominate work",
    "expectedBenefit": "Fewer indexed reads",
    "uncertainty": "Memory overhead",
    "prediction": "Input reads fall on the declared benchmark",
    "falsificationTest": "Run correctness and read-count evaluators"
  }]
}
```

The strict format permits at most 64 uniquely identified hypotheses and 256 KiB. Successful execution and reconciliation use the same parser, freeze metadata with the revision, and display claims in reports for every task type. Malformed output rejects promotion while preserving paid usage and the proven stop. An idea's `proposal.md` remains its proposal text. Candidate claims never become executable evidence by themselves.

## Measuring and improving results

The controller now avoids copying the entire archive for each event, checkpoints its derived cache, and indexes evidence before comparing candidates. A three-repetition offline comparison measured approximately **60× faster frontier calculation** on 250 tradeoff candidates, **3.2× faster durable stream persistence**, and **34% lower elapsed time** for a 500-item streaming repair fixture. Outcomes, token totals, and default evaluator counts matched the original implementation. These are local controller measurements; they do not imply a 60× faster model. Separate [live results](docs/live-muse-results.md) now cover a small Muse comparison. See [performance measurements and tuning](docs/performance.md) for workloads, ranges, and reproduction commands.

```sh
npm run perf
npm run perf -- --suite reuse
```

For a deterministic executable **development correctness** evaluator, opt into `"reuseIdentical": true` on its configuration entry. This declares that its checks depend only on the frozen snapshot, evaluator definition, and environment. Within that run, identical snapshots can share a settled passing result. Concurrent identical checks coalesce, unused evaluation reservations are released, and reports link each reused row to the original experiment. Reuse is off by default. Failures, metric-bearing results, objective evaluators, human assessments, and held-out assessments always run fresh. Do not enable it for flaky checks or checks depending on time, network, or mutable external state.

The paired reuse fixture completed the same eight alternatives with **two instead of nine evaluator procedures** (78% fewer), unchanged 960 fixture tokens, and the same successful outcome. Median elapsed time fell 21%. This saves evaluation capacity; it does not claim smarter generated candidates. With a four-procedure limit, a regression test confirms capacity for eight alternatives instead of three. Actual opportunity depends on how often identical snapshots recur.

`npm run bench` runs the fixture-only benchmark three times per case and prints a Markdown/JSON summary. Cases are interleaved by repetition. Reports retain every run, input snapshot, evaluator/environment identity, controller implementation digest, objective improvements, elapsed ranges, and complete spending/liabilities. Existing output directories cannot be overwritten. This command rejects Muse configurations and human checkpoints.

Benchmark output is checked against every candidate input, including directory aliases, before creating files. It cannot write its reports into an input tree.

For code tasks with no optimization objectives and `all_constraints` acceptance, set `task.selection.earlyStop` to `first_feasible` to stop dispatching after all development constraints pass. The default is `never`. It checks only at settled wave boundaries; already-dispatched siblings finish. Held-out assessment still runs after selection is frozen and cannot restart search. Tasks that optimize objectives must continue their declared search.

The included paired repair benchmark keeps inputs, budgets, fixture plans, and evaluators identical. In the measured three-repetition run, both variants met the goal every time; early stopping used **120 versus 480 fixture tokens** and **two versus five evaluator procedures**. These results demonstrate saved controller work on predetermined repairs. They do not estimate live model success, provider cost, or general performance. The optimization case measures synthetic input reads rather than latency.

## Human assessments

Run `npm start -- run examples/human-review.json`. It pauses for the baseline and then each applicable candidate. Inspect the proposal and rubric, write your own evaluator-format JSON, and submit it:

```sh
npm start -- assess RUN_DIR my-assessment.json --rater "Reviewer name"
npm start -- resume RUN_DIR
```

`examples/assessment.json` is a format template, not an assessment to accept automatically. Rater provenance and rubric digests are stored. Free-form `human` constraints remain unresolved; use a check constraint tied to a `human_preference` evaluator for a concrete human decision.

## Muse readiness

A Muse config requires `backend.kind: "muse"`, `binary`, `compatibilityLock`, and `execution.isolationProfile: "sandbox-exec"`. Model and effort may be host defaults or explicit host-advertised selections. Start from `examples/muse.template.json`; its placeholder paths and invalid lock prevent execution. The [November 4 Muse research and compatibility audit](docs/muse-compatibility.md) links Meta's model/runtime documentation and records the offline fixes and remaining live checks.

The pinned SDK is **1.4.14**. The adapter explicitly negotiates experimental permission-profile readback, confirms the denial mode and workspace, rejects non-durable sessions and reported unavailable sandbox enforcement, and waits for model/effort changes to take effect. The SDK's stable-schema warning is advisory; the exact independently verified runtime fingerprint/version must still match the lock.

Authentication defaults to the dedicated runtime home. For an API key, optionally configure `backend.apiKeyEnv: "META_API_KEY"`; only the variable name is saved, and a missing value blocks admission. The child environment explicitly binds HOME and both XDG directories to that home. Unrelated environment variables are excluded. A smoke spec accepts the same optional field.

Parent-session usage excludes native child/workflow usage. Visible child or background work triggers cancellation and an unknown liability with a persistent marker; parent-only reconciliation cannot clear it. The verified runtime must disable those workers. Reports never substitute the parent's token total for complete child usage.

```sh
npm start -- validate path/to/config.json
npm start -- doctor path/to/config.json
```

Both commands **never launch Muse**. `validate` checks configuration; `doctor` also checks the lock and binary digest. Neither proves runtime compatibility. `examples/muse-lock.template.json` is deliberately invalid. Do not enable its verification flags without performing the checks in [implementation status](docs/implementation.md).

The installed SDK version and all runtime JavaScript module hashes are checked as well. Runs freeze that SDK identity and their compatibility settings; changing them requires restoring the frozen setup or starting a new run. The check is repeated at admission and host launch.

The adapter implements handshake checks, model/effort readback, fresh sessions, durable command identity and submission payloads, event capture, approval denial, cancellation, and conservative missing-usage handling. Native forks and automatic replay of uncertain turns are disabled.

`src/muse-protocol.ts` isolates protocol execution behind a small injectable host boundary. Offline tests run the pinned SDK's actual connection, session, approval router, folds, and turn iterator over an in-memory transport. They cover initialization refusal/mismatch, settings readback, streamed revisions, denial failures, pending questions, missing/invalid usage, cancellation races, shutdown failure, and disconnects around submission. Lost acknowledgements retain known session/command/turn identities; recovery never resubmits the uncertain turn. Cancellation acknowledgement alone never settles work.

These are explicitly **protocol simulations**. They create no compatibility lock, launch no Muse process, and establish no live authentication, provider, isolation, or cancellation guarantees. Production still verifies the compatibility lock and sandbox before opening a host. Run the simulation suite independently after building with `node --test dist/test/muse.test.js`.

### Future opt-in smoke testing

`examples/muse-smoke.template.json` describes the exact binary, expected handshake, dedicated runtime home, permission profile, and explicit model/effort to investigate. Fill these from independently observed runtime information. Preparing and reporting are local operations:

```sh
npm start -- smoke-plan my-smoke-spec.json --out /absolute/new-smoke-directory
npm start -- smoke-report /absolute/new-smoke-directory
```

The completion and OS isolation cases have now passed on the tested installation. Cancellation and abrupt-host-failure experiments remain separate gates. Running any live case requires both explicit opt-ins:

```sh
npm start -- smoke-run /absolute/new-smoke-directory completion --allow-live --allow-provider-cost
npm start -- smoke-run /absolute/new-smoke-directory cancellation --allow-live --allow-provider-cost
npm start -- smoke-run /absolute/new-smoke-directory host-failure --allow-live --allow-provider-cost
npm start -- smoke-run /absolute/new-smoke-directory isolation --allow-live --allow-provider-cost
```

The first three cases may incur provider costs; there is no enforceable provider token cap. The harness binds the exact binary/SDK identity, records intent before host creation and events before later actions, and serializes cases through a writer lock. Each case can execute once per plan, including after interruption; it never automatically repeats an uncertain turn. Completion checks a nonce-specific file edit and records settings, streaming, and reported usage. Cancellation waits for terminal evidence beyond an acknowledgement. Host failure closes the host after turn admission and records uncertainty. Isolation probes denied file reads/writes using the same macOS profile; it does not contact Muse.

Every smoke summary retains `compatibilityVerified: false`; the smoke harness itself cannot authorize production. The live pilot separately checks the real completion/isolation evidence and native worker configuration, then pins settings and creates isolated session homes. Its gateway bounds supported Wonder text requests, including retries, and blocks on uncertain billing. Durable answers, real reconciliation, concurrent hosts, native child workers, and other failure timings remain unsupported or unverified. See [live results](docs/live-muse-results.md).

Edit inspection runs only after a known terminal and host stop. It uses bounded regular-file reads, rejects symlinks/FIFOs, and preserves usage and protocol evidence when output is missing or malformed. Uncertain workspaces are left uninspected.

## Current limits

- Concurrency uses bounded waves, rather than continuously refilling slots. Attempt execution and candidate evaluation occupy separate stages of each wave.
- Active token cancellation depends on reported usage and cannot guarantee a hard provider cap. Actual overruns remain recorded and reduce future capacity. Cleanup can exceed a timeout.
- `trusted-fixture` is for known code, not an OS sandbox. Imported candidate code shares the evaluator process; this is not an adversarial test harness.
- `sandbox-exec` is macOS-specific and has passed a live read/write containment probe. There is no Linux/container isolation backend. Sandboxed evaluators cannot use the network; Muse can connect through the billing gateway.
- The automatic preset handles failure → retry, repeated identical failed repairs or exhausted search → alternatives, and multiple feasible alternatives → bounded tree. Noise-aware resampling remains future work. Opt-in first-feasible stopping saves work on code tasks with no optimization objectives.
- Model-judgment evaluators, automatic polling/replay of unknown host work, and a web UI are not implemented. Explicit answer/reconcile commands exist; live reconciliation is unverified and gated, while live answering requires persistent-host integration.
- Both selection modes currently retain feasible, non-dominated candidates in stable archive order. `feasible_first` has no additional weighted ranking.
- Persistence is tested for interrupted processes and incomplete records, not distributed operation or filesystem failure.

## Source map

Active contracts: [src/config.ts](src/config.ts) and [src/types.ts](src/types.ts). The earlier [architecture](docs/architecture.md), [design contracts](docs/contracts.ts), and [configuration sketches](docs/config-examples.ts) describe the broader target, not executable configuration.

| Module | Responsibility |
|---|---|
| `controller.ts`, `search.ts` | Lifecycle, search proposals, switching, final selection |
| `scheduler.ts`, `budget.ts` | Dispatch, reservations, accounting, evaluation, recovery |
| `store.ts`, `workspaces.ts` | Transactions, checksums, writer lock, immutable snapshots |
| `backend.ts`, `backend-input.ts`, `muse.ts`, `muse-protocol.ts`, `muse-recovery.ts` | Fixture backend, answer validation, gated host launch, and injectable SDK execution/recovery |
| `process.ts`, `evaluation.ts` | Worker ownership, timeout, validation, comparison |
| `repository-workflow.ts`, `candidate-output.ts` | Frozen offline setup/build contracts and structured candidate claims |
| `muse-smoke.ts`, `benchmark.ts` | Opt-in future compatibility evidence and fixture outcome/cost measurements |
| `evaluation-history.ts` | Shared exposure receipts and held-out reuse checks |
| `cli.ts`, `project.ts`, `report.ts` | Commands, starter projects, run listing, integrity checks, reports |

`npm test` builds and runs offline integration tests without invoking Muse or contacting a provider. CI is configured for Linux/macOS with Node 22/24.

## Package locally

```sh
npm run release:check
npm pack
```

The private tarball contains the compiled CLI, TypeScript source, examples, and documentation. It excludes run artifacts, user workspaces, tests, and node_modules. Install with `npm install /path/to/branchpilot-0.1.0.tgz` in another project, then invoke `npx branchpilot --help`. Dependency installation may need registry access. The `private` flag prevents accidental npm publication. Packaging does not launch Muse or verify its runtime.
