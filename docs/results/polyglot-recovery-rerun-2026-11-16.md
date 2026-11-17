# Completed live comparison — November 16, 2026

The repaired runner completed both arms and all 24 task trials. The comparison reports `comparable: true`, with no quality/integrity reasons. BranchPilot did not improve results on this run.

| Measurement | Direct Muse | BranchPilot |
|---|---:|---:|
| Solved / planned tasks | 10/12 | 7/12 |
| Elapsed | 944.937 s | 1118.456 s |
| Provider tokens | 2,078,751 | 1,977,877 |
| Generation requests | 87 | 85 |
| Conservative nominal usage, USD | 9.190540 | 9.435572 |

BranchPilot used 4.85% fewer tokens, but took 18.36% longer and incurred 2.67% more conservative nominal usage cost. Its larger output-token count explains why fewer total tokens did not translate into a lower cost estimate. These costs use uncached input pricing; they are not cash charges or a provider invoice. Free credits were active at launch.

Paired outcomes were zero BranchPilot wins, three losses and nine ties; the exact two-sided paired p-value is 0.25. This is a small, repeated 12-task subset, so the result does not establish a general accuracy difference. `modelQualityImproved` is false.

## Per-task outcomes

| Task | Direct Muse | BranchPilot |
|---|---|---|
| say | Solved | Solved |
| book-store | Solved | Solved |
| pig-latin | Solved | Solved |
| scale-generator | Solved | Unsolved |
| zebra-puzzle | Solved | Solved |
| robot-name | Solved | Solved |
| killer-sudoku-helper | Solved | Solved |
| forth | Solved | Unsolved |
| twelve-days | Unsolved | Unsolved |
| phone-number | Unsolved | Unsolved |
| state-of-tic-tac-toe | Solved | Unsolved |
| poker | Solved | Solved |

## Follow-up on the three losses

The direct arm had 147 seconds and 360,000 tokens for its turn. BranchPilot budgeted all three possible turns and their development grades in advance, leaving each turn 35.67 seconds and 120,000 tokens. The event logs record 17 budget cancellations in 19 BranchPilot attempts. Six cancelled edits still passed final grading.

| Task lost by BranchPilot | Empty timeout checkpoints | Successful direct turn |
|---|---:|---:|
| scale-generator | 2 | 65.9 s, 169,995 tokens |
| forth | 3 | 107.2 s, 191,946 tokens |
| state-of-tic-tac-toe | 3 | 37.8 s, 162,042 tokens |

All eight attempts on these tasks reached the time limit with the starter files unchanged. Each fresh session had to start the implementation again. The two shared misses had different outcomes. Both versions failed development on `twelve-days`. Both passed development on `phone-number` and failed final grading.

Comparison plan version 2 gives the candidate the direct first prompt and ceiling, and charges each retry against the settled remainder. A read-only check reconstructed the state just before each historical direct attempt, then ran the new prompt builder and budget admission at its recorded timestamp. All 12 prompts matched byte for byte, and all 12 recorded durations and token counts fit. The 24 archived configurations also matched the version 1 plan reader. Post-fix live accuracy and cost remain unmeasured.

## Accounting and reliability

All **172 new generation requests settled**, with no new unknown charges or pending requests. Provider input/output totals reconcile exactly to both arms' recorded totals. Historical unknown requests 205 and 332 retain their full reserves and were not replayed. The cumulative cash guard remained below CAD $50; its final conservative projection was CAD $17.73 after the CAD $100 credit allowance. That projection includes gross historical usage and both retained reserves, so it is not an observed card charge.

The fresh run proves the repaired accounting and execution paths can complete this comparison. It did not encounter another dropped upstream stream, so recovery under induced connection loss remains covered by local regression tests and the successful real stored-response lookup rather than a live outage. All 262 local release tests passed before launch.

## Evidence

Results and both version jobs are saved under `.branchpilot/public-polyglot-recovery-2026-11-16/`, including `comparison/summary.json`, `accounting.json` and `gateway.json`. This completion check independently recomputed solved counts from the 24 run states and matched all new provider-token totals to the ledger. No new model request was sent during the check.
