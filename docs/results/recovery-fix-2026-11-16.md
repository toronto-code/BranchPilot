# Connection-failure recovery — November 16, 2026

Completed follow-up: the [fresh live comparison](polyglot-recovery-rerun-2026-11-16.md) finished both arms with all 172 new requests settled and no execution errors. Direct Muse solved 10/12; BranchPilot solved 7/12 and took longer. Reliability improved; a model-quality gain was not established.

The November 13 connection loss exposed two accounting defects: a cancelled Muse host could return before its last provider request settled, and the runner could start the next task using incomplete host token totals. The old gateway had no stored-response recovery path. Request 332's stream then ended without final usage, and the safety stop correctly halted the comparison.

## Repairs

- The public benchmark explicitly stores its public-task responses. After a broken stream or an early EOF, the gateway makes bounded, read-only retrieval attempts for the same response ID. It accepts only matching model/identity, terminal status and valid complete usage. A persistence-lag 404 may be retried; the generation POST is never replayed. General gateway callers retain the existing storage behavior unless recovery is enabled.
- Read-only model-catalog requests retry transient failures. This does not retry billable generation.
- Each sequential Muse attempt now drains admitted provider requests before its usage is final or the next task starts. Provider input/output totals, including an in-flight response missed by a cancelled host, are charged to the owning attempt. Raw host totals remain in the receipt; provider-derived usage has its own source label and evidence.
- An automatic search that reaches a confirmed, fully accounted budget checkpoint without an edit can use its remaining retry allowance. It no longer ends after that first empty checkpoint. Direct-baseline behavior, the total shared allowance and held-out-test isolation are unchanged.

Recovering billing does not invent missing streamed output or a host completion. If output/termination remains uncertain, the run still stops safely. Requests with no response ID, invalid recovery evidence or exhausted deadlines retain their full reserves.

Meta documents [stored-response persistence, retrieval and short retries for persistence lag](https://dev.meta.ai/docs/protocols/responses). This repair uses those read-only operations and preserves the existing generation limits.

## Verification and current funding

`npm run release:check` passed **262/262 tests**, TypeScript validation and the package dry run. New regressions cover interrupted streams and clean early EOF, catalog retry, delayed response persistence, one generation POST only, wrong/missing recovery evidence, accounting after host cancellation, and retry after an empty checkpoint. A test teardown ordering issue was corrected before the full passing run.

An authenticated, read-only billing check showed **$139.57 free credits active and CA$0.00 outstanding**. No payment, credit setting or account setting was changed. The renewed local policy conservatively uses CAD $100 of credits and retains the CAD $50 out-of-pocket cap, the aggregate US$80 nominal limit and every prior charge/reserve. The CAD 1.75/USD conversion ceiling remains above the latest published Bank of Canada USD rate inspected (CAD 1.4257 on November 13; November 16's daily average was not yet published). [Daily exchange rates](https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/).

Historical requests 205 and 332 remain unknown with US$14 reserved in total. The read-only lookup for response 332 still returned 404; its charge was not fabricated or zeroed. The original campaign ledger and failed comparison artifacts were preserved. Renewed credit evidence is saved at `.branchpilot/repair-2026-11-16/billing-balance.json`; the policy is `.branchpilot/campaign-budget-credits-2026-11-16.json`.

A fresh comparison uses a new output directory, `.branchpilot/public-polyglot-recovery-2026-11-16/`, with the same prespecified 12 tasks, model, effort, time/token ceilings and graders. It runs locally in the background without chat progress polling. Its comparison report and gateway ledger are the completion evidence; the repairs alone do not establish an accuracy improvement.

The fresh run started November 16 at 18:50 UTC. Its first task passed, with provider-reported usage recorded by the new wrapper. A read-only retrieval of its already-completed request 333 returned HTTP 200, `store: true`, and input/output usage matching the ledger exactly. This confirms that new public benchmark responses are retrievable on the actual provider; it does not claim a real network interruption was induced. The lookup evidence is `.branchpilot/repair-2026-11-16/live-retrieval-check.json`. Background process details and log location are in `.branchpilot/repair-2026-11-16/background-run.json`.
