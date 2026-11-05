# Controller performance — November 4, 2026

These measurements cover local controller overhead and deterministic fixture evaluation. No Muse process, model provider, authentication, or live-model quality experiment was used. Three repetitions are useful local observations, not a confidence interval or a prediction for other machines.

## Measured changes

Measured on an Apple M5, macOS/Darwin 25.6.0, Node v26.7.0. Each implementation ran the same five workloads three times, sequentially, without concurrent test-suite execution. The original implementation ran first; the optimized implementation ran afterward. Timing includes the work described below, including close/replay in the persistence cases. Process CPU is recorded separately in JSON; child-process CPU is not included in that counter.

| Workload | Original median (range), ms | Optimized median (range), ms | Speedup |
|---|---:|---:|---:|
| Three Pareto-frontier queries, 250 mutually nondominated candidates | 226.82 (214.43–254.02) | 3.79 (2.67–6.20) | 59.9× |
| Persist 1,000 stream events against a 250-candidate archive; close and replay | 12,219.53 (11,127.27–12,427.24) | 3,807.95 (3,799.39–3,847.08) | 3.21× |
| Persist 250 decisions against that archive; close and replay | 3,054.94 (3,021.54–3,151.78) | 1,023.85 (1,000.35–1,029.85) | 2.98× |
| Complete eight repair alternatives, concurrency two, fresh checks | 1,109.40 (1,109.37–1,143.88) | 939.43 (912.80–954.74) | 1.18× |
| Complete a repair with 500 distinct stream-item artifacts | 6,649.10 (6,562.93–6,732.17) | 4,417.03 (4,261.98–4,541.39) | 1.51× |

The event-only case shares one content artifact; the streaming-repair case stores 500 distinct artifacts and exercises the complete controller. The synthetic frontier is deliberately a difficult tradeoff set where no candidate can be eliminated early. Smaller archives and different tradeoffs can produce different gains. Disk fsync latency, filesystem caching, runtime warmup, and other host activity affect these results. Default behavior retains every evaluation: both implementations used nine procedures and 960 fixture tokens in the eight-alternative case, and 120 tokens in the streaming repair. Every repetition passed its outcome and replay assertions; frontier identity and ordering matched.

Local raw results are in `.branchpilot/performance/before/results.json` and `.branchpilot/performance/after/results.json`. They contain every sample, timing range, process CPU, machine identity, implementation digest, and checked evidence. The compiled original implementation is preserved locally under `.branchpilot/performance/baseline/src`; generated files are excluded from version control and the release package.

Implementation digests, computed from the sorted filenames and hashes of all compiled `.js` modules:

These identify the measured implementations before the subsequent Muse compatibility audit and SDK 1.4.14 update. The figures measure the controller/fixture workloads described here; they do not benchmark that SDK's live runtime.

- Original: `7e70201cd1f9d7386313f2eb3d76275403e4f79444cff255d3766b80caa6bf08`
- Optimized: `34e37d09b4a86a5ccb729d9e6c6583c1eefd23a52da92bb329b803fbb1980340`

## What became faster

- State transitions use copy-on-write collections. A raw stream event that does not change the projection shares the existing state, rather than cloning all revisions, evaluations, and work records. Transaction validation still completes before the log write, so invalid transactions leave both live state and the log unchanged.
- The checksummed event log still fsyncs **every transaction**. Only the derived `state.json` cache is throttled. It refreshes on run-status transitions, settled or uncertain work, close, and after 32 projection-changing transactions or on an append at least one second after its last refresh while changes are pending. It may lag during execution. Readers and recovery replay the verified log and do not trust that cache.
- Frontier calculation indexes development evidence by revision, extracts objective values and sample bounds once, then compares the indexed points. It preserves evaluator/environment compatibility, meaningful-change thresholds, sample separation, feasibility, and stable selection order. Tree scheduling computes its frontier once per proposal.
- Revisions and evaluations use stable ordered insertion instead of sorting the full archive after every addition. Randomized comparison tests check the frontier against the original comparison rules.

## Spend less evaluation budget

Opt into reuse on an evaluator only when its correctness checks are deterministic functions of the frozen input, definition, and environment:

```json
{
  "id": "addition-tests",
  "kind": "executable",
  "split": "development",
  "role": "correctness",
  "definition": { "path": "./evaluators/repair.json" },
  "timeoutSeconds": 5,
  "reuseIdentical": true
}
```

This flag is an explicit assertion about the evaluator, not an automatic proof of determinism. Leave it disabled for randomness, timing, network calls, mutable external state, or flaky tests. The scheduler reuses only a settled passing result with **no metrics**, identical snapshot, evaluator ID, definition digest, and environment digest in the same run. It verifies the current environment before reuse. Changed snapshots, failures, and metric-bearing correctness results execute again. Configuration rejects reuse for objective, human, and held-out evaluators. There is no cross-run result cache.

Concurrent checks for the same snapshot share a queue slot. Once the first passes, followers record derived evaluations with `reusedFrom` pointing to the original evaluation/revision and `workId` pointing to the original charged experiment. Their unused evaluation reservations are released atomically. Reports disclose reuse. Derived rows are neither new independent evidence nor extra paid procedures.

In a paired three-repetition fixture, with case order alternating between repetitions:

| Eight alternatives, concurrency two | Fresh checks | Reuse enabled |
|---|---:|---:|
| Successful outcomes | 3/3 | 3/3 |
| Attempts per run | 8 | 8 |
| Fixture tokens per run | 960 | 960 |
| Executed evaluator procedures per run, including baseline | 9 | 2 |
| Reused checks per run | 0 | 7 |
| Median elapsed (range), ms | 892.79 (881.73–911.83) | 702.62 (621.50–723.15) |

That is 78% fewer evaluator procedures and 21% lower median elapsed time for identical predetermined repairs. Raw samples are in `.branchpilot/performance/reuse/results.json`. A separate budget regression test limits both variants to four evaluator procedures: fresh checks admit three alternatives, while reuse admits all eight. The generated candidates are identical, so this demonstrates available search capacity rather than improved solution quality.

For code tasks where any fully feasible candidate satisfies the goal, the existing `task.selection.earlyStop: "first_feasible"` also saves attempts and tokens. It checks settled waves and still performs frozen held-out assessment. Keep full search when optimizing objectives. Concurrency hides independent attempt latency, but timing-sensitive evaluators should retain a shared `resourceGroup` to prevent interference. Reuse honors that group.

## Reproduce

From a source checkout with the pinned dependencies installed:

```sh
npm run perf
npm run perf -- --suite reuse
npm run perf -- --repetitions 5 --out .branchpilot/performance/new-measurement
```

Output directories must be new. The runner accepts only fixture backends with executable evaluators, rejects output inside candidate inputs, and removes its temporary run workspaces after checking results. It stores timing/evidence summaries rather than full run archives; use `npm run bench` when complete fixture run archives are required.

To repeat the local original/optimized comparison while the preserved original exists:

```sh
node bench/performance.mjs --implementation .branchpilot/performance/baseline/src --out .branchpilot/performance/original-repeat
node bench/performance.mjs --out .branchpilot/performance/optimized-repeat
```

Run them sequentially on an otherwise idle machine. Do not run tests concurrently with timing measurements. The separate `reuse` suite requires the new implementation. An extracted release package can run `node bench/performance.mjs` directly after dependencies are available; it includes compiled source and the benchmark runner.

All 171 offline tests passed after the original performance changes. Coverage includes concurrent reuse, experiment-budget accounting, changed and failing snapshots, metric-bearing results, disabled/default behavior, configuration gates, transaction rollback, cache-free replay, and randomized frontier equivalence. Real Muse/model performance still requires the separately gated live verification.

## Remeasurement after frontier and comparison work — November 4, 2026

The saved original implementation and current implementation each ran the same five workloads three times, sequentially, after the 214-test suite completed. No tests ran alongside timing. Machine/Node identities matched the earlier measurements. Original ran first, current second; these are small local samples, not randomized timing experiments. The original's third repetition was slower on several workloads, and the full ranges are retained.

| Workload | Original median (range), ms | Current median (range), ms | Result |
|---|---:|---:|---|
| Frontier: 250 tradeoffs, three queries | 453.73 (388.70–456.19) | 7.76 (5.56–8.20) | 58.44× for this narrow lookup workload |
| Persist/replay 1,000 stream events | 11,448.35 (10,972.18–14,790.28) | 3,874.18 (3,586.42–3,911.00) | 2.96× |
| Persist/replay 250 decisions | 2,848.85 (2,546.02–3,444.20) | 1,002.40 (998.77–1,004.42) | 2.84× |
| Complete eight fixture repair alternatives | 1,163.14 (1,159.35–2,115.56) | 1,027.54 (1,009.49–1,036.67) | 11.7% less elapsed time |
| Complete fixture repair with 500 stream items | 6,647.18 (6,413.89–7,910.82) | 4,333.02 (4,331.81–4,357.99) | 34.8% less elapsed time |

All workload evidence matched exactly: frontier identity/order, replay equality, outcomes, attempts, procedures, and fixture token counts. This supports a controller-overhead improvement against the saved original, including after the new handoff logic. It does not compare live Muse runs or establish improved solution quality.

Raw results: `.branchpilot/performance/comparison-original/results.json` and `.branchpilot/performance/comparison-current/results.json`. Original implementation SHA-256: `7e70201cd1f9d7386313f2eb3d76275403e4f79444cff255d3766b80caa6bf08`; current: `6fde948d8fac6897abe18fa55be89fbe07cc1f8886b72b0f8efd295ab67167e5`.

The [live Muse report](live-muse-results.md) now records a separate real comparison: tied correctness on four fresh tasks, 9.2% fewer tokens and 12.3% lower elapsed time in one pilot. Those observations do not establish a general speed or quality gain.

The [paired benchmark guide](benchmark-guide.md) describes the separate one-hour-per-version model-quality experiment. Its included fixture example proves workflow mechanics and explicitly cannot pass the model-quality improvement gate.
