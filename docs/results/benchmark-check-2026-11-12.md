# Benchmark check — November 12, 2026

The saved evidence does **not establish a model-quality improvement**. The small live confirmation tied on correctness; the larger public comparison was an operational failure and is incomplete. Offline controller improvements reproduce, but they do not establish better model reasoning.

This check made no paid calls, restarted no live arm, and changed no historical comparison, grader, charge, or ledger entry. Existing source changes were preserved. The user confirmed a **CAD $50 cumulative campaign ceiling**, including prior costs, unresolved liabilities, currency conversion, taxes, and fees. This checkout still contains the older US$7 request reservation and US$40 ledger configuration; neither is the current authorized campaign budget or a sufficient CAD-denominated guard. Any future paid dispatch must fit the remaining CAD allowance, including existing liabilities. Historical records remain unchanged.

## Saved live results

| Experiment | Direct baseline | BranchPilot | Interpretation |
|---|---:|---:|---|
| Original four-task pilot | 4/4 solved | 0/4 solved | Preserved failed controller treatment before budget-checkpoint handling was repaired. |
| Fresh four-task confirmation | 4/4 solved | 4/4 solved | Comparable small local pilot, four correctness ties, paired p=1. |
| Frozen 12-task public JavaScript subset | 11/12 solved | 1/12 recorded | Incomplete and noncomparable; interrupted/unstarted cases remain in the denominator. |

The confirmation used 463,182 versus 510,169 reported tokens (9.21% fewer), and 119.95 versus 136.74 seconds (12.28% less). These are observations from one fixed-order run on four local tasks, not statistical evidence of a general cost, timing, or accuracy advantage.

The public baseline finished in 919.952 seconds. BranchPilot recorded 4,049.973 seconds, exceeding its 3,600-second version ceiling by 449.973 seconds. Only seven candidate tasks started; five were unstarted. The saved diagnosis associates the long waits with host sleep and records deadline/failure-propagation repairs. Those repairs have not been validated by a fresh live comparison. The stored 0 wins/10 losses/2 ties and p-value cannot support a quality inference because the experiment is invalid. Lower recorded candidate spending is not efficiency evidence for an incomplete arm.

Sources: [confirmation](muse-confirmation-2026-11-05.json), [initial failed pilot](muse-pilot-before-checkpoint-2026-11-05.json), [public run](polyglot-2026-11-05-public-run.md), [operational diagnosis](polyglot-2026-11-05-diagnosis.md).

## Independent integrity and accounting checks

- Replayed and checked all **35 saved live-run records and 2,586 content-addressed artifacts**, read-only. Configurations match the frozen comparison plans; independently recomputed solved counts match the saved summaries. There were no mismatches.
- Reproduced selection of the 12 public tasks from the saved seed and eligible pool. All 96 frozen evaluator-asset digests match, including the adapter and test runtime. Prepared task order matches the frozen plan.
- The saved preparation contains 36 passing isolation checks and 234 active assertions: 145 development and 89 additional final-only assertions. These preparation checks were inspected, not rerun or modified. Final grading uses the full suite, including development cases.
- The campaign ledger still matches the saved public gateway snapshot: **205 requests, 204 settled, request 205 unknown**. Settled campaign charges total US$21.143480; the historical outstanding reservation is US$7, giving US$28.143480 of settled charges plus retained reserve. These are local conservative accounting figures, not a provider invoice or a current currency conversion.
- For the public comparison alone, settled charges are US$12.294596 plus the US$7 retained reserve. Baseline provider tokens reconcile exactly to its host total, 2,599,169. The candidate's settled provider subtotal matches 178,988 host tokens; its complete total remains unknown.

No unknown usage or charge was set to zero, and no old request was replayed. The remaining liability must be included in any future cumulative spending calculation.

Evidence fingerprints at this check:

```text
public summary SHA-256: a6568fa7af7d0dd6997bfc2897ac1f92abbb01a78fdfad17ac15d322d5976643
campaign ledger SHA-256: eb3aed983a32fd7fcb2bacaba0950da094a219abe43e611e411589865bb27328
```

## Fresh offline measurements

`npm run bench` completed three repetitions per case using the current build:

| Fixture case | Outcome | Median fixture tokens | Attempts | Evaluator procedures | Median seconds |
|---|---|---:|---:|---:|---:|
| Repair, full search | goal met in 3/3 | 480 | 4 | 5 | 0.753 |
| Repair, stop on success | goal met in 3/3 | 120 | 1 | 2 | 0.312 |
| Optimization | best found in 3/3 | 430 | 3 | 10 | 1.657 |

Inputs/evaluator/environment identities match within each case and no liabilities remain. Both optimization finalists measured 500 input reads versus 32,024 for the baseline, in every measured sample. This is an executable indexed-read measurement on synthetic data, not runtime latency. Repair token savings are predetermined fixture accounting; they cannot be advertised as live provider savings.

Results: `.branchpilot/benchmarks/5c1dfbd6-460b-4a9f-83e0-89b4f9df8d15/`.

The fresh deterministic-check reuse benchmark retained eight attempts, 960 fixture tokens, and a passing outcome in both variants. Reuse reduced executed evaluator procedures from nine to two. Median elapsed time was 711 versus 990 ms (28.15% lower), over three repetitions with alternating order. This applies only to eligible deterministic checks; performance/held-out evaluations are not reused.

Results: `.branchpilot/performance/run-1794511961810/results.json`.

The current and archived-original controller overhead suites each ran three repetitions on the same recorded Node/OS/CPU environment. Outcomes, counts, replay assertions, and frontier-result digests match. Measurements are sequential local observations, not randomized timing experiments or model-quality evidence.

| Controller workload | Archived original median | Current median | Observed ratio |
|---|---:|---:|---:|
| Three frontier queries, 250 tradeoff candidates | 453.520 ms | 7.512 ms | 60.37× faster |
| 1,000 durable stream events | 13,238.134 ms | 3,553.717 ms | 3.73× faster |
| 250 durable decisions | 3,307.086 ms | 929.989 ms | 3.56× faster |
| Eight fixture alternatives | 1,260.172 ms | 1,050.025 ms | 1.20× faster |
| Repair with 500 synthetic stream items | 7,307.092 ms | 4,523.557 ms | 1.62× faster |

Current results: `.branchpilot/performance/run-1794511925873/results.json`. Archived-original rerun: `.branchpilot/performance/run-1794512142282/results.json`.

## Verification and caveats

- All **29 focused comparison, checkpoint, and performance regression tests passed**.
- `node bench/validate-pilot.mjs` passed for both four-task suites: every starting implementation fails, and every independent reference passes both graders.
- Current fixture benchmarks, both controller overhead implementations, and the reuse suite completed with their built-in correctness/accounting assertions.
- No full regression suite or public model run was executed during this check.
- Older prose contains stale adapter-status and spending snapshots. The four-task live-results page's 94 settled requests describe the earlier pilot, not the current 205-entry campaign. The public adapter now exists; the public comparison remains invalid. Do not present the older pilot's positive observations as a successful public benchmark.

A claim that BranchPilot improves live benchmark accuracy needs a fresh, complete, prespecified comparison after operational and billing issues are addressed. This check did not launch one or assume additional spending authorization.
