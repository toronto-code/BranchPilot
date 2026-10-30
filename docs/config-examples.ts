import type { RunConfig } from "./contracts";

// Illustrative authoring configuration. Referenced repositories/evaluators and the
// smoke-tested Muse lock must exist before these can become runnable configurations.
// Preflight freezes input contents, evaluator hashes, environment and settings.
export const benchmarkOptimization = {
  schemaVersion: 1,
  task: {
    key: "ranking-latency",
    type: "optimization",
    goal: "Reduce ranking latency while preserving output equivalence and a 256 MiB memory limit.",
    inputs: [{ path: "./fixtures/ranking-service" }],
    constraints: [
      { id: "same-results", kind: "check", evaluatorId: "correctness", check: "output-equivalence" },
      { id: "memory-cap", kind: "metric", metric: "peak_rss", op: "lte", value: 256, unit: "MiB" },
    ],
    objectives: [
      { metric: "p95_latency", direction: "minimize", unit: "ms", minMeaningfulChange: 0.5, evidenceKind: "executable" },
      { metric: "peak_rss", direction: "minimize", unit: "MiB", minMeaningfulChange: 2, evidenceKind: "executable" },
    ],
    evaluators: [
      { id: "correctness", kind: "executable", split: "development", role: "correctness", definition: { path: "../branchpilot-evaluators/ranking/correctness.json" }, dependsOn: [], repetitions: 1, warmups: 0, timeoutSeconds: 60 },
      { id: "benchmark", kind: "executable", split: "development", role: "objective", definition: { path: "../branchpilot-evaluators/ranking/benchmark-dev.json" }, dependsOn: ["correctness"], repetitions: 7, warmups: 2, timeoutSeconds: 120, resourceGroup: "benchmark-machine" },
      { id: "heldout-correctness", kind: "executable", split: "held_out", role: "correctness", definition: { path: "../branchpilot-evaluators/ranking/correctness-final.json" }, dependsOn: [], repetitions: 1, warmups: 0, timeoutSeconds: 60 },
      { id: "heldout-benchmark", kind: "executable", split: "held_out", role: "objective", definition: { path: "../branchpilot-evaluators/ranking/benchmark-final.json" }, dependsOn: ["heldout-correctness"], repetitions: 10, warmups: 2, timeoutSeconds: 120, resourceGroup: "benchmark-machine" },
    ],
    baseline: { mode: "initial_artifacts", description: "Unmodified input snapshot, evaluated with the same fixed procedures." },
    selection: { mode: "pareto", maxFinalists: 2, acceptance: "all_constraints" },
  },
  backend: { kind: "muse", binary: "muse", compatibilityLock: "./muse-runtime.lock.json" },
  agent: { model: { kind: "host-default" }, effort: { kind: "host-default" } },
  strategy: { name: "direct" },
  policy: { mode: "auto", ruleset: "hackathon-v1", allowedStrategies: ["direct", "retry", "best-of-n", "tree"] },
  budget: {
    total: { tokens: 120_000, workSeconds: 2400, attempts: 8, experiments: 30 },
    wallSeconds: 1800,
    maxConcurrency: 2,
    perAttempt: { tokenReservation: 15_000, timeoutSeconds: 180 },
    // Held-out evaluation of baseline + 2 finalists: 3 * (60s + 120s), 6 experiments.
    finalizationReserve: { tokens: 0, workSeconds: 540, attempts: 0, experiments: 6 },
    cancellationGraceSeconds: 10,
    missingUsage: "hold-reservation-and-pause",
  },
  execution: { isolationProfile: "local-isolated-worker", approvals: "deny-unless-allowlisted", userInput: "pause", nativeFork: "disabled" },
} satisfies RunConfig;

export const ideaExploration = {
  schemaVersion: 1,
  task: {
    key: "search-result-cache-design",
    type: "idea",
    goal: "Explore ways to reduce repeated search work; test whether reuse survives changing queries and bounded memory.",
    inputs: [{ path: "./briefs/cache-design.md" }, { path: "./fixtures/search-prototype" }],
    constraints: [
      { id: "private-data", kind: "human", instruction: "Use synthetic inputs; no customer data or external data collection." },
    ],
    objectives: [
      { metric: "repeat_work_reduction", direction: "maximize", unit: "percentage_points", minMeaningfulChange: 5, evidenceKind: "executable" },
      { metric: "assumption_clarity", direction: "maximize", unit: "rating_1_to_5", minMeaningfulChange: 1, evidenceKind: "human_preference" },
    ],
    evaluators: [
      { id: "idea-rubric", kind: "human_preference", split: "development", role: "rubric", definition: { path: "../branchpilot-evaluators/cache/idea-rubric.json" }, dependsOn: [], repetitions: 1, warmups: 0, timeoutSeconds: 180 },
      { id: "prototype-correctness", kind: "executable", split: "development", role: "correctness", definition: { path: "../branchpilot-evaluators/cache/prototype-checks.json" }, dependsOn: [], repetitions: 1, warmups: 0, timeoutSeconds: 30 },
      { id: "reuse-experiment", kind: "executable", split: "development", role: "objective", definition: { path: "../branchpilot-evaluators/cache/query-shift.json" }, dependsOn: ["prototype-correctness"], repetitions: 5, warmups: 1, timeoutSeconds: 60 },
    ],
    baseline: { mode: "status_quo_proposal", description: "No-cache design with measured repeated work from the supplied minimal prototype." },
    selection: { mode: "pareto", maxFinalists: 2, acceptance: "human_review" },
  },
  backend: { kind: "muse", binary: "muse", compatibilityLock: "./muse-runtime.lock.json" },
  agent: { model: { kind: "host-default" }, effort: { kind: "host-default" } },
  strategy: { name: "best-of-n", n: 3 },
  policy: { mode: "fixed", ruleset: "hackathon-v1", allowedStrategies: ["best-of-n", "retry", "tree"] },
  budget: {
    total: { tokens: 60_000, workSeconds: 2100, attempts: 6, experiments: 12 },
    wallSeconds: 1800,
    maxConcurrency: 1,
    perAttempt: { tokenReservation: 10_000, timeoutSeconds: 180 },
    finalizationReserve: { tokens: 0, workSeconds: 0, attempts: 0, experiments: 0 },
    cancellationGraceSeconds: 10,
    missingUsage: "hold-reservation-and-pause",
  },
  execution: { isolationProfile: "local-isolated-worker", approvals: "ask", userInput: "pause", nativeFork: "disabled" },
} satisfies RunConfig;
