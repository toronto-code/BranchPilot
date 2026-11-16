# Campaign budget preflight — November 13, 2026

Superseded later the same day: the user supplied current evidence of $143.46 free credits and CA$0.00 outstanding. This report's pre-credit conversion treated nominal API usage as cash spending and therefore overstated the cash restriction. The credit-aware policy now carries all historical entries and the full unknown reserve forward, applies only CAD $100 of evidenced credits, and preserves the CAD $50 out-of-pocket limit. The original ledger remains unchanged.

No new model request was submitted. The existing credential file was located in the earlier architecture chat and confirmed present; authentication is available. The campaign remains blocked by unresolved provider work and insufficient room for another maximum-size request reserve.

The CAD $50 ceiling covers the entire campaign. The original ledger remains unchanged: 205 requests, 204 settled, one unknown. Settled conservative charges are US$21.143480; the unknown request retains US$7. No unknown charge was converted to zero or replayed.

The Bank of Canada's latest published USD rate inspected was CAD 1.4255 for November 12. The local policy uses **CAD 1.75 per USD**, a deliberately higher all-in ceiling for exchange, taxes and payment fees, valid until November 14 at 22:00 UTC. This is a conservative admission assumption, not an invoice or a verified card conversion rate. [Bank of Canada daily rates](https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/).

| Preflight quantity | Amount |
|---|---:|
| Settled charges plus retained unknown reserve | US$28.143480 |
| Converted commitment, rounded upward | CAD $49.26 |
| Remaining room under the ceiling | CAD $0.74 |
| Commitment plus another US$7 request reserve | CAD $61.51 |
| Admissible new paid requests | None |

The authenticated provider dashboard showed 205 requests, free credits in use and CA$0.00 outstanding. Its rounded usage totals and credit display do not establish the missing request's final usage. The CSV export stalled and produced no usable evidence. No credit, payment or account setting was changed. The conservative ledger was not replaced by the dashboard's zero cash balance.

Both live benchmark wrappers now require a CAD policy tied to the existing ledger and its prior-entry digest. The gateway checks its expiry and cumulative CAD allowance before each paid dispatch; unknown entries always retain their full reserve. `bench/campaign-budget.mjs` provides a read-only preflight without a credential or provider call. The existing US$40 ledger ceiling remains an additional historical restriction. These controls cover the benchmark gateway; conversion assumptions must be reverified before renewal.

Local policy: `.branchpilot/campaign-budget-cad.json`. Reproduce with:

```sh
node bench/campaign-budget.mjs --ledger .branchpilot/live-campaign-ledger.json --budget .branchpilot/campaign-budget-cad.json
```

The expected exit code for the current campaign is 1. Reconcile request 205 from provider evidence before preparing a new paid comparison. The previous public comparison remains incomplete and cannot establish improved model quality.

## Verification

`npm run release:check` passed: TypeScript validation, all **247 tests**, and the package dry run. The five new budget tests cover rounding, full unknown reserves, history protection, ledger binding, expiry, cumulative admission and reopening without resetting charges. The full check also exposed an existing concurrency test's 120 ms timing assumption; independent evaluator workers now rendezvous explicitly, and both resource-group cases passed in the complete rerun. All three changed benchmark scripts pass syntax checks, and the diff has no whitespace errors.

The historical ledger SHA-256 remains `eb3aed983a32fd7fcb2bacaba0950da094a219abe43e611e411589865bb27328`. The read-only CAD preflight returned `canDispatch: false` as expected. Full local check output is saved at `.branchpilot/release-check-2026-11-13.log`.
