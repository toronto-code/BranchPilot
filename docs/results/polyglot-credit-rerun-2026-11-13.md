# Credit-funded public subset rerun — November 13, 2026

Status: live comparison in progress. No outcome or quality claim is established by this plan record.

The user supplied a current billing screenshot showing **$143.46 free credits in use** and **CA$0.00 outstanding**. Earlier budget reports incorrectly treated conservative nominal API usage as cash spending. The revised guard tracks nominal usage and projected cash separately while preserving the CAD $50 out-of-pocket campaign cap.

## Prespecified comparison

Both arms use the same prepared 12-task JavaScript subset, exact Wonder 1.0 model, max effort, isolated runtime and external graders. Each arm has a one-hour ceiling, each task has 240 seconds and 360,000 model tokens, and the candidate has at most three search attempts sharing its allowance. The existing prepared seed, task order, input assets and grader digests are unchanged. This is a repeat of the known subset after infrastructure repairs, not an independent fresh sample or the full Polyglot leaderboard protocol.

The 12 tasks are `say`, `book-store`, `pig-latin`, `scale-generator`, `zebra-puzzle`, `robot-name`, `killer-sudoku-helper`, `forth`, `twelve-days`, `phone-number`, `state-of-tic-tac-toe`, and `poker`.

Only the previously verified installed Muse 1.4.14 binary/SDK pair is used. All 256 local release tests passed before launch. Fresh output directory: `.branchpilot/public-polyglot-credits-2026-11-13/`. No started historical job or uncertain request is replayed.

## Credit and cash accounting

The policy uses only **CAD $100** as its credit allowance, conservatively below the displayed $143.46 without relying on that display's unspecified dollar denomination. Gross nominal charges, including old credited usage, are converted upward at the existing CAD 1.75 per USD ceiling before the allowance is subtracted. Counting old usage against the current allowance again reduces available credit capacity rather than creating extra spending room.

The new version-2 ledger carries all 205 original entries forward unchanged, retains their prefix digest and the original ledger's SHA-256, and imposes an aggregate US$80 nominal ceiling. At that ceiling, CAD $140 gross minus CAD $100 credited projects CAD $40 cash, below the CAD $50 cap. The budget and credit evidence expire November 14 at 03:00 UTC. The assumption depends on the supplied current credit evidence; concurrent account activity is outside the gateway's accounting.

Historical unknown request 205 keeps its full US$7 reserve and frozen contents. It is explicitly retained without blocking this separate comparison. Every newly pending request serializes admission; any new unknown billing outcome stops the run. Terminal usage is recorded as soon as received, with provider identifiers saved durably.

Local evidence and policy:

```text
.branchpilot/billing-evidence-2026-11-13/credits.png
.branchpilot/campaign-budget-credits-2026-11-13.json
.branchpilot/live-campaign-credits-2026-11-13.json
```

The original ledger remains unchanged at SHA-256 `eb3aed983a32fd7fcb2bacaba0950da094a219abe43e611e411589865bb27328`. Account/payment settings were not changed.
