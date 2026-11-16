# Frozen Polyglot JavaScript public subset — 2026-11-05

November 13 follow-up: see the [failure review and repairs](benchmark-failure-repair-2026-11-13.md). The current cumulative spending ceiling is **CAD $50**; the C$100 limit mentioned in this historical report has been superseded. The original results and unresolved charge are preserved.

Run: `.branchpilot/public-polyglot-2/`. Status: stopped with unresolved billing; incomplete, noncomparable. No improvement established. This is a 12-task public subset, not the full 225-task leaderboard protocol. The failed `public-polyglot-1` configuration launch made no paid calls.

The frozen plan is `docs/results/polyglot-2026-11-05-plan.json`; prepared assets are `.branchpilot/polyglot-prepared-1/`. Wonder 1.0 at max effort, 240 seconds and 360,000 total tokens per task, 3,600 seconds per version. Preparation validated official references/starters and 36 isolation checks; 234 active assertions comprise 145 development and 89 final checks.

| Recorded result | Direct baseline | BranchPilot |
|---|---:|---:|
| Solved / all 12 planned tasks | 11/12 | 1/12 |
| Job elapsed | 919.952 s (15m20s) | 4,049.973 s (67m30s) |
| Host token total | 2,599,169 | Unknown overall; 178,988 recorded |
| Settled provider input tokens | 2,528,072 | 176,212 |
| Settled provider output tokens | 71,097 | 2,776 |
| Settled conservative cost, USD | 11.534228 | 0.760368 |
| Unresolved reserve, USD | 0 | 7.000000 |
| Settled cost plus unresolved reserve, USD | 11.534228 | 7.760368 |

Baseline completed all 12 tasks; only `phone-number` was unsolved. BranchPilot solved `say`; `book-store`, `pig-latin`, `scale-generator`, `zebra-puzzle`, and `robot-name` exceeded task allowances; `killer-sudoku-helper` was interrupted. `forth`, `twelve-days`, `phone-number`, `state-of-tic-tac-toe`, and `poker` were not completed. Missing confirmed model settings affect several candidate cases; these do not establish that a different model actually ran. BranchPilot exceeded the version ceiling by 449.973 seconds. Combined recorded job time is 4,969.924 seconds (82m50s), excluding settlement and inter-arm overhead.

The stored all-planned-task tally is 0 BranchPilot wins, 10 losses, and 2 ties. Failures and missing cases remain in the denominator. The comparison is invalid: this tally and its stored p-value cannot support a model-quality conclusion. Lower recorded candidate token use/cost does not establish efficiency because the arm is incomplete.

Baseline provider and host tokens match exactly: 2,528,072 + 71,097 = 2,599,169. Candidate settled provider usage equals its recorded host subtotal (178,988), but request 205 has unknown usage/charge, so complete reconciliation is impossible. Candidate `accounting.json` arm data was never finalized. The gateway records a response timeout and the script exited with `Unsettled billing stops the campaign`. `finishedAt` on the candidate job does not mean all tasks or billing completed. Follow-up diagnosis confirmed host clamshell/maintenance sleep aligned with the long waits, plus deadline and failure-propagation defects; see [diagnosis and repairs](polyglot-2026-11-05-diagnosis.md). The provider outcome of request 205 remains unknown.

Billing reconstructed without changing the ledger: entries 1–94 preceded this benchmark (USD 8.848884); entries 95–196 belong to baseline; entries 197–205 belong to BranchPilot (8 settled, 1 unknown). This benchmark has USD 12.294596 settled plus USD 7 unresolved reserve, conservatively USD 19.294596. Entire shared campaign: USD 21.143480 settled plus USD 7 reserve, conservatively USD 28.143480. These are gateway conservative charges/reservations, not a final provider invoice. No current CAD conversion, taxes, or fees have been verified. The revised user limit is C$100 total campaign spending; the existing immutable USD 40 gateway ceiling remains unchanged.

Preserved evidence: `comparison/summary.json`, both version `job.json` files and run artifacts, `accounting.json`, `gateway.json`, `.branchpilot/public-polyglot-2.log`, and `.branchpilot/live-campaign-ledger.json`. During the initial inspection, no requests or arms were replayed, no tests rerun, and no source, adapters, settings, ledger, or caps changed. The linked follow-up records subsequent source repairs and new offline regression tests. No further paid work while request 205 remains unknown. Reconcile it against provider billing before considering any fresh authorized experiment; do not replay this started arm.
