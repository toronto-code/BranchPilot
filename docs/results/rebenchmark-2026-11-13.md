# Rebenchmark — November 13, 2026

Later update: the user supplied current free-credit evidence. A credit-aware policy now separates nominal API usage from cash spending and permits a fresh live comparison without erasing historical charges or the unknown reserve. The spending block described below records the earlier pre-credit interpretation.

The repaired controller completed all fresh local benchmark suites. No new live Muse comparison was started: the existing CAD $50 campaign preflight refuses admission with request 205 unresolved. These measurements establish local fixture behavior and controller overhead, not live model quality or provider savings.

## Fixture outcomes

`npm run bench` completed three repetitions per case. All nine trials passed their expected outcomes; inputs, evaluators and environment match within each case, and no usage liabilities remain.

| Case | Outcome | Median fixture tokens | Attempts | Evaluator procedures | Median seconds |
|---|---|---:|---:|---:|---:|
| Repair, full search | Goal met, 3/3 | 480 | 4 | 5 | 0.666 |
| Repair, stop on success | Goal met, 3/3 | 120 | 1 | 2 | 0.289 |
| Optimization | Best found, 3/3 | 430 | 3 | 10 | 1.587 |

Both optimization finalists improved the objective in every repetition. Edits and token counts are deterministic fixture inputs; the measured timings and evaluator outcomes are real local observations. Fixture token differences are not evidence of live model-token savings.

Results: `.branchpilot/benchmarks/e400e4bd-86ee-46f7-a0d0-8ab1fa99e6a1/summary.json`.

## Controller performance against the archived original

Each implementation ran the same overhead suite for three repetitions, sequentially, on Node v26.7.0, macOS kernel 25.6.0, Apple M5. Independently compared evidence matches for every workload: outcomes, token/attempt/evaluation counts, durable replay and frontier-result digest. Implementation fingerprints differ as expected.

| Workload | Archived original median | Repaired current median | Observed ratio |
|---|---:|---:|---:|
| Three frontier queries, 250 tradeoff candidates | 549.159 ms | 7.386 ms | 74.35× faster |
| 1,000 durable stream events | 11,968.117 ms | 3,797.868 ms | 3.15× faster |
| 250 durable decisions | 3,047.285 ms | 1,019.137 ms | 2.99× faster |
| Eight fixture alternatives | 1,289.878 ms | 1,034.486 ms | 1.25× faster |
| Repair with 500 synthetic stream items | 6,849.034 ms | 4,488.725 ms | 1.53× faster |

These ratios describe controller workloads, not model speed. The current implementation ran before the archived original; this is a small local timing comparison without randomized order or statistical confidence intervals. Differences from the November 12 measurements do not establish an additional optimization gain.

Raw results:

```text
.branchpilot/performance/rebenchmark-2026-11-13-current/results.json
.branchpilot/performance/rebenchmark-2026-11-13-original/results.json
.branchpilot/performance/rebenchmark-2026-11-13-comparison.json
```

## Deterministic check reuse

The reuse suite ran three repetitions with alternating order. Both variants met the goal with eight attempts and 960 fixture tokens. Reuse reduced executed evaluator procedures from nine to two, reusing seven eligible development checks. Median elapsed time fell from **1,045.816 ms to 702.668 ms**, an observed **32.81% reduction**. Held-out and performance measurements are not reused.

Results: `.branchpilot/performance/rebenchmark-2026-11-13-reuse/results.json`.

## Live comparison and budget status

The current read-only preflight reports US$28.143480 committed, including the full US$7 reserve for unknown request 205. Under the existing all-in CAD 1.75 per USD assumption, that is CAD $49.26 after rounding upward, leaving CAD $0.74 available. Another full request reserve would project CAD $61.51, exceeding the CAD $50 cap. Unresolved billing independently blocks admission. The conversion assumption expires November 14 at 22:00 UTC.

No historical job was replayed and no ledger entry was changed. The public summary and campaign ledger retain their prior fingerprints. The previous live public comparison remains incomplete; its 11/12 versus 1/12 recorded result cannot establish a model-quality conclusion. See the [failure review](benchmark-failure-repair-2026-11-13.md) and [budget report](campaign-budget-2026-11-13.md).

The preceding full release check passed all 253 tests. This rebenchmark changed no controller source; all fresh suites completed their built-in correctness/accounting assertions, and the archived/current evidence comparison passed.
