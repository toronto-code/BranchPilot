# Up to one hour per version: benchmark plan

The current limit is **up to one hour for the direct baseline and one hour for BranchPilot search**. The runner and `examples/comparison.json` default to a 3600-second per-version ceiling, a 240-second per-task allowance, and at most three search attempts sharing the new version's allowance. Time limits are ceilings, not delays: easy tasks can finish sooner. Cancellation and cleanup can overshoot; the report flags that. The example still contains just one offline fixture, not twelve real tasks.

Keep the same explicit model and effort in both versions. Authentication, compatibility checks, dataset preparation, and dependency downloads happen before the timed comparison. For a five-minute functional pilot, explicitly set `armSeconds: 300` and `searchAttempts: 2` with one prepared 240-second task. A single task cannot establish better model accuracy.

## Current spending authorization

The [November 16 recovery repair](results/recovery-fix-2026-11-16.md) adds stored-response billing recovery and per-attempt provider reconciliation. All 262 release tests passed. A fresh authenticated billing check showed $139.57 free credits active and CA$0.00 outstanding; the renewed policy retains a conservative CAD $100 credit allowance, all charges/reserves, and the CAD $50 cash cap.

The [November 13 failure review](results/benchmark-failure-repair-2026-11-13.md) explains the interrupted public run, the repaired deadline/dispatch defects, and the unsuccessful read-only recovery of its missing provider usage. All 253 local release tests passed; no fresh live benchmark has validated the repairs.

The [November 13 local rebenchmark](results/rebenchmark-2026-11-13.md) completed nine fixture trials and fresh controller/reuse measurements. All expected outcomes passed. Its initial spending block was based on incorrectly treating nominal usage as cash spending; the user subsequently supplied current free-credit evidence.

The user's latest confirmed limit is **no more than CAD $50 out of pocket for the entire benchmark campaign**, not per version or per request. Confirmed free credits offset projected cash; nominal API usage is still recorded in full. Include all prior usage, currency conversion, taxes, fees, and unresolved/in-flight reserves. A rerun does not reset those liabilities. Both live benchmark wrappers require `--budget POLICY.json` alongside `--ledger`. The policy binds the ledger's canonical path and freezes prior entries with a digest; truncating or rewriting that history is refused. The gateway rounds converted costs upward and checks projected cash at startup and before every paid dispatch.

Billing is **Meta API pay-as-you-go**. Use the explicit live-catalog identity for `muse-wonder-1.0`; Wonder Full is subscription-only and must not be silently substituted or purchased. Meta currently lists Wonder at USD 4 per million input tokens, USD 0.20 per million cached-input tokens, and USD 20 per million output tokens, with a separate web-search charge. Verify those rates, the CAD conversion, and any taxes before dispatch. [Official pricing](https://dev.meta.ai/docs/pricing-rate-limits), [Wonder availability](https://dev.meta.ai/models/muse-wonder).

**Live-pilot guard:** `src/muse-gateway.ts` reserves US$7 before each supported Wonder request and verifies catalog prices/limits. That reserve covers the maximum supported uncached text request; it is not the campaign's authorized budget. The original US$40 ledger remains unchanged. A version-2 credit-funded ledger carries forward all 205 entries and their digest, with an aggregate US$80 usage ceiling. The CAD policy subtracts only a conservative CAD $100 credit allowance backed by the user's current screenshot. Even the full US$80 nominal ceiling, converted at CAD 1.75/USD, projects at most CAD $40 cash after that allowance. Counting old credited usage again makes this conservative. The credit and conversion evidence expires November 14 at 03:00 UTC.

Historical unknown requests 205 and 332 are explicitly retained without blocking the separate fresh comparison: their full US$14 remains counted, their frozen entries cannot change, and neither is replayed. Every new request must settle; a new unknown blocks admission and stops the live run. The benchmark drains and reconciles provider work after each owned host closes, before another task starts. Hosted tools, other models, remote continuations, and premium tiers are refused. These controls cover the benchmark gateway, not arbitrary Muse use or concurrent account activity. The credit allowance relies on the current balance evidence and must be reverified before renewal. Meta documents its dashboard spend limit as an email alert, not a hard usage cap. [Meta's spend-limit explanation](https://dev.meta.ai/help/billing/spend-limit-alert).

Run the read-only preflight without credentials or provider calls:

```sh
npm run build
node bench/campaign-budget.mjs --ledger .branchpilot/live-campaign-credits-2026-11-13.json --budget .branchpilot/campaign-budget-credits-2026-11-13.json
```

It prints nominal headroom, the credit allowance, projected cash, retained liabilities and admission status. Exit code 1 means no new request is admissible. The original [budget preflight report](results/campaign-budget-2026-11-13.md) contains the superseded pre-credit calculation.

The policy's remaining fields are `schemaVersion: 1`, `currency: "CAD"`, `limitCad: 50`, `ledgerFile` (relative to the policy file), `priorEntries` and `priorEntriesSha256`. Build the last two from the existing `readMuseSpendLedger(ledgerFile).entries` using its length and `campaignHistoryDigest(entries)` from `src/campaign-budget.ts`. Store it separately from the historical ledger. Renewing a conversion assumption must preserve that history; resolving an unknown entry requires provider evidence and an explicitly updated policy digest.

## Which benchmarks

The following allocations are our proposed limits, not measured Muse runtimes. Each reserves 48 minutes for serial tasks and leaves about 12 minutes for controller/setup/reporting overhead. Build environments and install dependencies before either timed version; cold container downloads can exceed the allowance.

| Priority | Benchmark subset | Per-version allocation | What it measures |
|---|---|---|---|
| First | Aider Polyglot, 12 fixed JavaScript exercises | 12 × 4 minutes | Converting a coding request into correct edits, with useful opportunities for test-feedback repair. |
| Next | SWE-bench Verified, 4 fixed issues whose prepared test suites fit the limit | 4 × 12 minutes | Repository navigation and realistic multi-file issue fixing. Four issues give weak statistical evidence; rotate through fresh preselected batches. |
| Later | Terminal-Bench 2.0, 6 fixed CPU-only coding/debugging tasks | 6 × 8 minutes | Longer tool sequences and environment handling. Pin the dataset version and explicitly choose tasks with suitable resources. |

Aider's official Polyglot dataset contains 225 selected harder Exercism tasks across six languages, including 49 JavaScript tasks. Its harness supports filtering/count limits and is designed for container execution. A JavaScript-only subset suits the current repo's Node-oriented evaluator machinery, but it is not the official full Polyglot score. [Dataset description](https://aider.chat/2024/12/21/polyglot.html), [official harness](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md).

SWE-bench's official harness evaluates patches in containers and supports explicit instance IDs and per-instance timeouts. Give the two versions different run IDs: the official harness can reuse cached verdicts for an existing run/instance ID. Prebuild/check images, and use the same reference grading procedure. [Evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/), [current CLI reference](https://github.com/SWE-bench/SWE-bench/blob/main/docs/reference/cli.md).

Terminal-Bench 2.0 uses Harbor. Harbor exposes separate agent and verifier timeouts; their sum plus setup must fit your per-task allowance. The current general Terminal-Bench run page targets 4.0 and includes GPU tasks, so an unrestricted default run is a poor fit for this small local pilot. [2.0 announcement](https://www.tbench.ai/news/announcement-2-0), [Harbor task configuration](https://docs.harborframework.com/tasks/configuration), [current run page](https://www.tbench.ai/run).

HumanEval+/MBPP+ can be a quick correctness smoke check, but they exercise function synthesis more than BranchPilot's repository search and recovery. Use them as supplementary checks, not the main evidence for harder agentic tasks. [EvalPlus project](https://evalplus.github.io/).

**Integration status:** the frozen 12-task Aider Polyglot JavaScript adapter is implemented; official references/starters and 36 real isolation checks passed preparation (145 development and 89 final assertions). The first paid public subset run stopped with unresolved billing: baseline solved 11/12, BranchPilot recorded 1/12 with time overruns, interrupted and unstarted cases. The comparison is incomplete and noncomparable; improvement is not established. See the [public subset report](results/polyglot-2026-11-05-public-run.md) for timing, token reconciliation, conservative spending, and preserved failures. No further paid work is permitted while billing is unknown. Follow-up [diagnosis and repairs](results/polyglot-2026-11-05-diagnosis.md) confirmed host sleep and failure-propagation defects; source fixes passed new offline regression cases, with no benchmark replay. SWE-bench patch export and Harbor/container adapters remain unimplemented. The fixture and original live pilot are also documented in [live results and reproduction](live-muse-results.md).

## Fair default-versus-new comparison

Both versions use the same task inputs, development and final tests, exact model ID and effort, environment, total token allowance, total wall allowance, and concurrency one. A Muse comparison requires explicit provider/model/effort rather than dynamic preferences, so entitlement changes cannot silently switch the model. Choose the verified Wonder Full identity for both if available; otherwise explicitly choose Wonder for both.

- **Default:** one direct Muse attempt, basic task/evaluation prompt, no search. It can use the task's full model-token allowance and remaining attempt time. The common adapter supplies isolation, recording, and external grading; this is not a measurement of the standalone Muse CLI's defaults.
- **BranchPilot** starts with the same first-turn ceilings. The generic runner uses the same direct prompt by default. The public adapter freezes `candidatePrompt: "code-verification"` in its plan. That profile puts a working edit early, groups development results by verdict, and asks Muse to check a representative example and boundary case from the public task. After a development failure, BranchPilot can use feedback and the remaining tokens and time for another attempt. Each admission protects the next development grade and final assessment. Passing development checks stop search. The default maximum is three attempts in total.

The comparison is the full controller treatment, not an ablation of one individual feature. It cannot tell you whether handoff text, retrying, or search-policy changes caused a gain. Model changes must be evaluated separately.

The machine-readable summary records each first attempt's outcome, captured-edit status, time and tokens, along with whether development selected a finalist. This distinguishes a turn that ended before saving an edit from a candidate that passed development and failed final grading.

Newly prepared Polyglot suites run Jest in UTC and report a verdict for each named development test after Jest executes the complete development split. The runner freezes the upstream data files that file-oriented exercises need. Automatic retries can restore an earlier checkpoint that passed every check the latest edit passed and at least one additional check. The aggregate correctness gate requires every selected assertion to pass. Existing preparations use their frozen grader.

Set aside final tests that neither version can read or use during search. For public benchmark adapters, preserve reference grading and clearly document any development-test split or protocol change; custom budgets/subsets and changed feedback rules are not directly comparable to official leaderboard scores. Do not weaken tests, remove failed cases, or select the next subset after looking at which tasks BranchPilot solves.

Choose all task IDs, the dataset revision, and the limits before starting. A reproducible selection method is to hash a recorded seed plus each eligible task ID, sort the hashes, and take the first N. Verify dependencies and the reference grader before freezing that pool. Exclude a task for documented infrastructure incompatibility before seeing model results, never because one version fails it.

Prepare a disjoint Polyglot sample from the pinned checkout and runtime with a new seed. The manifest records the selected cases and exclusions. The JavaScript `ledger` exercise asks for a refactor and its starter passes the full official suite, so a correctness-only comparison cannot score that task.

```sh
node bench/prepare-polyglot.mjs \
  --dataset .branchpilot/datasets/polyglot-benchmark \
  --runtime .branchpilot/toolchains/polyglot/runtime.tgz \
  --exclude-prepared .branchpilot/polyglot-prepared-1 \
  --seed branchpilot-polyglot-js-2026-11-18-verify-v1 \
  --out .branchpilot/polyglot-final-2026-11-18
node bench/verify-polyglot.mjs --prepared .branchpilot/polyglot-final-2026-11-18
```

Preparation and OS isolation checks make no provider calls. `--exclude-prepared` can be repeated for prior preparations, and `--count` supports 1–14 cases within the one-hour arm limit. Twelve cases are a pilot. If direct Muse again solves ten, even a perfect candidate run can produce at most two paired wins on that sample.

## Runner already implemented

Try the complete offline workflow; it normally takes seconds, despite its one-hour ceiling:

```sh
npm run build
node dist/src/cli.js compare-plan examples/comparison.json --out .branchpilot/my-comparison
node dist/src/cli.js compare-run .branchpilot/my-comparison default
node dist/src/cli.js compare-run .branchpilot/my-comparison new
node dist/src/cli.js compare-report .branchpilot/my-comparison
```

Use a new output directory for each comparison. Each version executes at most once; an interrupted or uncertain job is never automatically replayed. The run records remain available for inspection. Fixing infrastructure or changing code requires a new comparison plan, and unsuccessful pilot records should be retained.

For a prepared 12-task dataset, provide this specification with **all twelve actual entries**:

```json
{
  "schemaVersion": 1,
  "dataset": "your-pinned-polyglot-js-subset",
  "datasetRevision": "EXACT_DATASET_COMMIT",
  "armSeconds": 3600,
  "taskSeconds": 240,
  "taskTokens": 360000,
  "searchAttempts": 3,
  "cases": [
    { "id": "actual-task-id", "config": "tasks/actual-task-id/config.json" }
  ]
}
```

The displayed single entry illustrates the format; it does not create twelve tasks. Paths are relative to the specification. `taskSeconds` includes baseline evaluation, model work, development evaluation, final grading, and an allowance for setup. The planner subtracts declared evaluator limits and reserves final grading before allocating attempt time. If those limits leave too little model time, preparation fails. `taskTokens` covers all attempts for one version of one task; it is not a dollar limit or a provider-enforced hard cap.

Live testing observed about 19,000 input tokens per model step even on a tiny edit. The old 24,000-token fixture allowance is too small for realistic Muse tool use. The live pilot uses 360,000 total tokens per task, shared across up to three search attempts; this is a ceiling, not a target. Budget-stopped edits are graded only after known usage and terminal/host-stop confirmation.

Preparation fingerprints the inputs/evaluator bundles, records the exact controller build and configuration, and starts neither Muse nor an evaluator. Both versions refuse source/environment drift and stale implementation fingerprints. A version job has its own wall deadline and will not start a task unless that task's full declared allowance still fits. Cancellation/cleanup can overshoot, which the report flags rather than hiding.

After actual Muse compatibility verification and authentication are available, the same runner accepts Muse task configs with the existing verified lock. Live execution additionally requires these explicit CLI flags:

```sh
node dist/src/cli.js compare-run COMPARISON_DIRECTORY default --allow-live --allow-provider-cost
node dist/src/cli.js compare-run COMPARISON_DIRECTORY new --allow-live --allow-provider-cost
```

The live pilot wraps these operations with the spending gateway and verified runtime settings. The generic comparison planner never creates or certifies a Muse compatibility lock. Do not run the generic live commands directly under this campaign's spending limit without that gateway.

## What counts as improvement

The report retains every planned task in the denominator and shows solved tasks, paired wins/losses, elapsed time, and known token/work usage. It verifies event/artifact integrity, planned configuration, source/evaluator/environment identities, confirmed model/effort, and backend identity. A missing case, an interrupted job, infrastructure failure, unresolved usage, or a declared-limit overrun invalidates the comparison. Unknown token usage is never averaged as zero.

`modelQualityImproved` is true only for a complete comparable live comparison, with held-out evaluators for every task, more paired wins than losses, and a two-sided exact paired binomial/McNemar p-value at most 0.05. That is evidence on the frozen subset, not a guarantee about future tasks. The test is computed on task pairs, not on individual unit tests or repeated copies of one task. A single win has p=1; six wins and no losses have p=0.03125. Small pilots will often be inconclusive even when the new version looks promising.

Use one prespecified primary comparison. Do not rerun or tune until a p-value passes; confirm an initial gain on a fresh frozen set. Report costs alongside success: more solved tasks within the same ceiling and lower tokens per solved task are different claims. A faster run that solves fewer tasks is not automatically better.

The controller's local performance benchmark remains separate (`npm run perf`). It measures scheduling, persistence, frontier selection, and known fixture execution. It cannot establish Muse reasoning quality or public benchmark accuracy.
