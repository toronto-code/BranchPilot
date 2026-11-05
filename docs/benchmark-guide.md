# Up to one hour per version: benchmark plan

The current limit is **up to one hour for the direct baseline and one hour for BranchPilot search**. The runner and `examples/comparison.json` default to a 3600-second per-version ceiling, a 240-second per-task allowance, and at most three search attempts sharing the new version's allowance. Time limits are ceilings, not delays: easy tasks can finish sooner. Cancellation and cleanup can overshoot; the report flags that. The example still contains just one offline fixture, not twelve real tasks.

Keep the same explicit model and effort in both versions. Authentication, compatibility checks, dataset preparation, and dependency downloads happen before the timed comparison. For a five-minute functional pilot, explicitly set `armSeconds: 300` and `searchAttempts: 2` with one prepared 240-second task. A single task cannot establish better model accuracy.

## Current spending authorization

The user authorized **less than CAD 150 for the entire benchmark campaign**, not CAD 150 per version. Include paid compatibility checks, the default version, BranchPilot, and any reruns. Plan for at most CAD 100 and leave CAD 50 for exchange-rate changes, taxes, fees, and unresolved/in-flight charges. A rerun does not reset this allowance. This is the recorded authorization, not an implemented currency-denominated billing cap.

Billing is **Meta API pay-as-you-go**. Use the explicit live-catalog identity for `muse-wonder-1.0`; Wonder Full is subscription-only and must not be silently substituted or purchased. Meta currently lists Wonder at USD 4 per million input tokens, USD 0.20 per million cached-input tokens, and USD 20 per million output tokens, with a separate web-search charge. Verify those rates, the CAD conversion, and any taxes before dispatch. [Official pricing](https://dev.meta.ai/docs/pricing-rate-limits), [Wonder availability](https://dev.meta.ai/models/muse-wonder).

**Paid-run blocker:** Meta documents its dashboard spend limit as an email alert, not a hard usage cap. BranchPilot's token reservations and cancellation can overshoot and do not cover all separately billed work. Do not treat either as a guarantee that this campaign will remain under CAD 150. Request-level worst-case cost reservations and complete billing coverage must be verified before paid dispatch under this strict ceiling; if cost or stopped-work status is unknown, start no further paid work. [Meta's spend-limit explanation](https://dev.meta.ai/help/billing/spend-limit-alert).

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

**Integration status:** the paired runner below works with BranchPilot task/evaluator configurations. It does not yet import Aider datasets, export SWE-bench patch predictions, or supply a Harbor/container adapter. Those mappings and reference-verifier checks are still required for these public benchmark recommendations. The included runnable comparison is explicitly a local fixture. No public benchmark result is claimed.

## Fair default-versus-new comparison

Both versions use the same task inputs, development and final tests, exact model ID and effort, environment, total token allowance, total wall allowance, and concurrency one. A Muse comparison requires explicit provider/model/effort rather than dynamic preferences, so entitlement changes cannot silently switch the model. Choose the verified Wonder Full identity for both if available; otherwise explicitly choose Wonder for both.

- **Default:** one direct Muse attempt, basic task/evaluation prompt, no search. It can use the task's full model-token allowance and remaining attempt time. The common adapter supplies isolation, recording, and external grading; this is not a measurement of the standalone Muse CLI's defaults.
- **New:** automatic BranchPilot search with evidence handoffs. The default maximum is three attempts, sharing the same total allowance. Each reserves one-third of the task token allowance and a smaller time slice. Passing development checks stop further search; final grading remains separate.

The comparison is the full controller treatment, not an ablation of one individual feature. It cannot tell you whether handoff text, retrying, or search-policy changes caused a gain. Model changes must be evaluated separately.

Set aside final tests that neither version can read or use during search. For public benchmark adapters, preserve reference grading and clearly document any development-test split or protocol change; custom budgets/subsets and changed feedback rules are not directly comparable to official leaderboard scores. Do not weaken tests, remove failed cases, or select the next subset after looking at which tasks BranchPilot solves.

Choose all task IDs, the dataset revision, and the limits before starting. A reproducible selection method is to hash a recorded seed plus each eligible task ID, sort the hashes, and take the first N. Verify dependencies and the reference grader before freezing that pool. Exclude a task for documented infrastructure incompatibility before seeing model results, never because one version fails it.

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
  "taskTokens": 24000,
  "searchAttempts": 3,
  "cases": [
    { "id": "actual-task-id", "config": "tasks/actual-task-id/config.json" }
  ]
}
```

The displayed single entry illustrates the format; it does not create twelve tasks. Paths are relative to the specification. `taskSeconds` includes baseline evaluation, model work, development evaluation, final grading, and an allowance for setup. The planner subtracts declared evaluator limits and reserves final grading before allocating attempt time. If those limits leave too little model time, preparation fails. `taskTokens` covers all attempts for one version of one task; it is not a dollar limit or a provider-enforced hard cap.

Preparation fingerprints the inputs/evaluator bundles, records the exact controller build and configuration, and starts neither Muse nor an evaluator. Both versions refuse source/environment drift and stale implementation fingerprints. A version job has its own wall deadline and will not start a task unless that task's full declared allowance still fits. Cancellation/cleanup can overshoot, which the report flags rather than hiding.

After actual Muse compatibility verification and authentication are available, the same runner accepts Muse task configs with the existing verified lock. Live execution additionally requires these explicit CLI flags:

```sh
node dist/src/cli.js compare-run COMPARISON_DIRECTORY default --allow-live --allow-provider-cost
node dist/src/cli.js compare-run COMPARISON_DIRECTORY new --allow-live --allow-provider-cost
```

These are future instructions, not commands executed during this implementation pass. A comparison plan never creates or certifies a Muse compatibility lock.

## What counts as improvement

The report retains every planned task in the denominator and shows solved tasks, paired wins/losses, elapsed time, and known token/work usage. It verifies event/artifact integrity, planned configuration, source/evaluator/environment identities, confirmed model/effort, and backend identity. A missing case, an interrupted job, infrastructure failure, unresolved usage, or a declared-limit overrun invalidates the comparison. Unknown token usage is never averaged as zero.

`modelQualityImproved` is true only for a complete comparable live comparison, with held-out evaluators for every task, more paired wins than losses, and a two-sided exact paired binomial/McNemar p-value at most 0.05. That is evidence on the frozen subset, not a guarantee about future tasks. The test is computed on task pairs, not on individual unit tests or repeated copies of one task. A single win has p=1; six wins and no losses have p=0.03125. Small pilots will often be inconclusive even when the new version looks promising.

Use one prespecified primary comparison. Do not rerun or tune until a p-value passes; confirm an initial gain on a fresh frozen set. Report costs alongside success: more solved tasks within the same ceiling and lower tokens per solved task are different claims. A faster run that solves fewer tasks is not automatically better.

The controller's local performance benchmark remains separate (`npm run perf`). It measures scheduling, persistence, frontier selection, and known fixture execution. It cannot establish Muse reasoning quality or public benchmark accuracy.
