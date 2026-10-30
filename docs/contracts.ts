/**
 * BranchPilot architecture contracts, not an application implementation.
 * Every exported type is ours. No type below is claimed to be a Muse SDK API.
 * Runtime boundaries must validate JSON; TypeScript alone does not validate it.
 */
export type Id<K extends string> = string & { readonly __kind: K };
export type RunId = Id<"run">;
export type CandidateId = Id<"candidate">;
export type RevisionId = Id<"revision">;
export type AttemptId = Id<"attempt">;
export type CheckpointId = Id<"checkpoint">;
export type ExperimentId = Id<"experiment">;
export type EvaluationId = Id<"evaluation">;
export type DecisionId = Id<"decision">;
export type ReservationId = Id<"reservation">;
export type OperationId = Id<"operation">;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Digest = string; // Validated SHA-256, including algorithm prefix.
export type Timestamp = string; // Validated UTC ISO 8601.

export interface ArtifactRef {
  digest: Digest;
  mediaType: string;
  bytes: number;
}

export interface AssetInput {
  path: string;
  expectedDigest?: Digest;
}

export interface Objective {
  metric: string;
  direction: "minimize" | "maximize";
  unit: string;
  minMeaningfulChange: number; // Absolute, in the declared unit.
  evidenceKind: EvidenceKind;
}

export type Constraint =
  | { id: string; kind: "check"; evaluatorId: string; check: string }
  | { id: string; kind: "metric"; metric: string; op: "lte" | "gte"; value: number; unit: string }
  | { id: string; kind: "human"; instruction: string };

export type EvidenceKind = "executable" | "model_judgment" | "human_preference";
export type EvaluationSplit = "development" | "held_out";

export interface EvaluatorSpec {
  id: string;
  kind: EvidenceKind;
  split: EvaluationSplit;
  role: "correctness" | "objective" | "rubric";
  definition: AssetInput; // Trusted controller-owned definition, hashed at run creation.
  dependsOn: string[]; // Required evaluators that must pass before this one runs.
  repetitions: number;
  warmups: number;
  timeoutSeconds: number;
  resourceGroup?: string; // E.g. one exclusive benchmark machine.
}

export interface TaskSpec {
  key: string;
  type: "code" | "optimization" | "idea";
  goal: string;
  inputs: AssetInput[];
  constraints: Constraint[];
  objectives: Objective[];
  evaluators: EvaluatorSpec[];
  baseline: { mode: "initial_artifacts" | "status_quo_proposal"; description: string };
  selection: {
    mode: "pareto" | "feasible_first";
    maxFinalists: number;
    acceptance: "all_constraints" | "human_review";
  };
}

export type EffortRequest = { kind: "host-default" } | { kind: "explicit"; value: string };
export interface AgentSettings {
  model: { kind: "host-default" } | { kind: "explicit"; providerId: string; modelId: string };
  effort: EffortRequest;
}

export type StrategyConfig =
  | { name: "direct" }
  | { name: "retry"; maxAttemptsPerCandidate: number }
  | { name: "best-of-n"; n: number }
  | { name: "tree"; width: number; maxDepth: number; maxChildren: number };

export interface PolicyConfig {
  mode: "fixed" | "auto";
  ruleset: "hackathon-v1";
  allowedStrategies: StrategyConfig["name"][];
}

export interface ResourceAmount {
  tokens: number; // Normalized input + output; cache categories must not double count.
  workSeconds: number; // Sum of agent and experiment elapsed work, including overlap.
  attempts: number; // One scheduled agent turn per attempt.
  experiments: number; // One scheduled procedure incl. its bounded repetitions.
}

export interface BudgetSpec {
  total: ResourceAmount;
  wallSeconds: number; // Absolute deadline from run start; pausing does not extend it.
  maxConcurrency: number; // Agent workers + experiment workers together.
  perAttempt: { tokenReservation: number; timeoutSeconds: number };
  finalizationReserve: ResourceAmount; // Part of total, not an extra allowance.
  cancellationGraceSeconds: number;
  missingUsage: "hold-reservation-and-pause";
}

export interface RunConfig {
  schemaVersion: 1;
  task: TaskSpec;
  backend: {
    kind: "muse";
    binary: string;
    compatibilityLock: string; // Exact SDK + binary versions/digests, created by smoke test.
  };
  agent: AgentSettings;
  strategy: StrategyConfig;
  policy: PolicyConfig;
  budget: BudgetSpec;
  execution: {
    isolationProfile: string; // Local profile resolved and verified at preflight.
    approvals: "ask" | "deny-unless-allowlisted";
    userInput: "pause";
    nativeFork: "disabled" | "verified-only";
  };
}

export interface BackendIdentity {
  kind: string;
  sdkVersion: string;
  binaryVersion: string;
  binaryDigest: Digest;
  schemaFingerprint: string;
  durability: "durable" | "ephemeral" | "unknown";
  capabilities: ArtifactRef;
}

export type RunState =
  | "created" | "preparing" | "active" | "quiescing" | "paused"
  | "recovering" | "needs_attention" | "finalizing"
  | "completed" | "cancelled" | "failed";
export type RunPhase = "baseline" | "search" | "held_out" | "report";

export interface Run {
  id: RunId;
  config: RunConfig;
  resolvedManifest: ArtifactRef; // Frozen inputs, evaluators, environment, seeds, config.
  backend: BackendIdentity;
  state: RunState;
  phase: RunPhase;
  activeStrategy: StrategyConfig;
  policy: PolicyConfig;
  strategyEpoch: number;
  baselineRevisionId?: RevisionId;
  finalSelection?: RevisionId[]; // Frozen BEFORE any held-out results are exposed.
  budget: BudgetView;
  startedAt: Timestamp;
  deadline: Timestamp;
  quiesce?: { reason: "switch" | "pause" | "cancel" | "budget"; target?: StrategyConfig };
  recovery?: { previousState: RunState; previousPhase: RunPhase; unresolved: OperationId[] };
  outcome?: "goal_met" | "best_found" | "inconclusive" | "cancelled" | "infrastructure_failure";
}

export interface Hypothesis {
  id: string;
  assumption: string;
  expectedBenefit: string;
  uncertainty: string;
  prediction: string;
  falsificationTest: string;
}

export interface Candidate {
  id: CandidateId;
  runId: RunId;
  parentRevisionIds: RevisionId[]; // A DAG, including future recombination.
  currentRevisionId: RevisionId;
  disposition: "active" | "pruned" | "finalist" | "archived";
  evidenceIds: EvaluationId[]; // Index only; evidence always names an immutable revision.
}

export interface CandidateRevision {
  id: RevisionId;
  candidateId: CandidateId;
  previousRevisionId?: RevisionId;
  proposal: ArtifactRef; // A proposal is sufficient; code is optional.
  hypotheses: Hypothesis[];
  checkpointId?: CheckpointId;
  stage: "proposal" | "prototype" | "implementation";
  producedBy?: AttemptId;
  createdAt: Timestamp;
}

export interface BackendSessionRef {
  backend: string;
  hostInstanceId: string;
  sessionId: string;
  turnId?: string;
  cursor?: string;
}

export interface Checkpoint {
  id: CheckpointId;
  runId: RunId;
  files: ArtifactRef; // Content-addressed manifest; includes permitted untracked files.
  conversation:
    | { mode: "completed_turn"; session: BackendSessionRef; completedTurnId: string; handoff: ArtifactRef }
    | { mode: "handoff"; handoff: ArtifactRef };
  createdAt: Timestamp;
}

export type WorkState =
  | "created" | "reserved" | "starting" | "running"
  | "waiting_for_approval" | "waiting_for_input" | "cancel_requested"
  | "settling" | "unknown" | "reconciling"
  | "completed" | "failed" | "cancelled" | "aborted";

export interface Attempt {
  id: AttemptId;
  runId: RunId;
  candidateId: CandidateId;
  baseRevisionId: RevisionId;
  outputRevisionId?: RevisionId;
  state: WorkState;
  workspace?: { id: string; absolutePath: string; leaseId: string; inputCheckpointId?: CheckpointId };
  operationId: OperationId;
  reservationId?: ReservationId;
  session?: BackendSessionRef;
  continuity: "fresh_handoff" | "same_session" | "native_fork";
  settingsRequested: AgentSettings;
  settingsConfirmed?: { providerId: string | null; modelId: string | null; effort: string | null; evidence: ArtifactRef };
  feedbackIds: EvaluationId[];
  usage: UsageMeasurement[];
  stopEvidence?: ArtifactRef;
}

export interface Experiment {
  id: ExperimentId;
  runId: RunId;
  revisionId: RevisionId;
  checkpointId?: CheckpointId; // Mandatory for executable evaluation; optional for a rubric.
  evaluatorId: string;
  split: EvaluationSplit;
  purpose: "baseline" | "search" | "final";
  procedure: ArtifactRef;
  environment: ArtifactRef; // Hardware/runtime/dependencies/seeds/resource isolation.
  limits: { timeoutSeconds: number; repetitions: number; warmups: number; memoryMiB?: number };
  operationId: OperationId;
  reservationId?: ReservationId;
  state: WorkState;
  outputs: ArtifactRef[];
  repeatedFrom?: ExperimentId; // Explicit paid repetition, never invisible recovery.
}

export interface Metric {
  name: string;
  unit: string;
  samples: number[];
  estimate: number;
  statistic: "mean" | "median" | "count" | "rating";
  uncertainty:
    | { kind: "interval"; low: number; high: number; level: number; method: string }
    | { kind: "unknown"; reason: string };
}

export interface EvaluationResult {
  id: EvaluationId;
  runId: RunId;
  experimentId: ExperimentId;
  revisionId: RevisionId;
  evaluatorId: string;
  evaluatorDigest: Digest;
  environmentDigest: Digest;
  split: EvaluationSplit;
  kind: EvidenceKind;
  validity: "pass" | "fail" | "inconclusive" | "not_applicable";
  checks: { id: string; outcome: "pass" | "fail" | "unknown"; evidence: ArtifactRef[] }[];
  metrics: Metric[];
  failureType?: "correctness" | "constraint" | "infrastructure" | "timeout" | "insufficient_evidence";
  feedback: string;
  findings: { hypothesisId?: string; claim: string; strength: "supported" | "refuted" | "unresolved"; evidence: ArtifactRef[] }[];
  evidence: ArtifactRef[];
}

export interface UsageMeasurement {
  resource: "tokens" | "workSeconds";
  amount: number | null; // Missing is NEVER zero.
  provenance: "host_reported" | "runner_measured" | "estimated" | "missing";
  scope: string; // Backend + session + turn/counter identity.
  semantics: "delta" | "cumulative";
  sourceEventId: string; // Idempotent normalization/reconciliation.
  raw?: ArtifactRef;
}

export interface BudgetView {
  spent: ResourceAmount;
  reserved: ResourceAmount;
  unknownLiability: ResourceAmount;
  protectedFinalization: ResourceAmount;
  availableForSearch: ResourceAmount;
  activeWorkers: number;
}

export interface Reservation {
  id: ReservationId;
  runId: RunId;
  operationId: OperationId;
  maximum: ResourceAmount; // An admission bound; backend token enforcement may be best effort.
  state: "held" | "reconciled" | "unknown_liability" | "released_unstarted";
}

export type SearchAction =
  | { kind: "create_candidate"; proposal: ArtifactRef; hypotheses: Hypothesis[]; fromRevisionId?: RevisionId }
  | { kind: "develop"; candidateId: CandidateId; baseRevisionId: RevisionId; feedbackIds: EvaluationId[]; instruction: string }
  | { kind: "branch"; parentRevisionId: RevisionId; instruction: string }
  | { kind: "evaluate"; revisionId: RevisionId; evaluatorId: string }
  | { kind: "prune"; candidateId: CandidateId; reason: string }
  | { kind: "finish"; finalistRevisionIds: RevisionId[]; reason: string };

export interface Proposal {
  actions: SearchAction[];
  rationale: string;
  evidenceIds: EvaluationId[];
}

export interface Decision extends Proposal {
  id: DecisionId;
  runId: RunId;
  basedOnSequence: number;
  strategyEpoch: number;
  origin: "controller" | "strategy" | "auto_policy" | "user";
  switchTo?: StrategyConfig;
  createdAt: Timestamp;
}

export type DevelopmentEvaluationResult = EvaluationResult & { split: "development" };
export type SearchTaskSpec = Omit<TaskSpec, "evaluators"> & {
  evaluators: (EvaluatorSpec & { split: "development" })[];
};

/** Search receives a projection excluding held-out definitions, results and refs. */
export interface SearchView {
  runId: RunId;
  sequence: number;
  task: Readonly<SearchTaskSpec>;
  candidates: readonly Candidate[];
  revisions: readonly CandidateRevision[];
  developmentResults: readonly DevelopmentEvaluationResult[];
  budget: Readonly<BudgetView>;
  activeWork: readonly { id: AttemptId | ExperimentId; state: WorkState }[];
}

export interface SearchStrategy {
  name: string;
  propose(view: Readonly<SearchView>, config: StrategyConfig): Proposal;
}

export interface SearchPolicy {
  decide(view: Readonly<SearchView>, current: StrategyConfig):
    | { kind: "keep"; reason: string }
    | { kind: "switch"; target: StrategyConfig; reason: string; evidenceIds: EvaluationId[] }
    | { kind: "stop"; reason: string };
}

export interface OperationRecord {
  id: OperationId;
  runId: RunId;
  ownerId: AttemptId | ExperimentId;
  intent: ArtifactRef; // Immutable canonical payload, saved BEFORE external submission.
  backendCommandId?: string; // Separate from BranchPilot's operation ID.
  status: "prepared" | "dispatched" | "acknowledged" | "settled" | "unknown";
  receipt?: ArtifactRef;
}

export type BackendEvent =
  | { kind: "progress"; raw: ArtifactRef }
  | { kind: "usage"; measurement: UsageMeasurement }
  | { kind: "settings_confirmed"; settings: NonNullable<Attempt["settingsConfirmed"]> }
  | { kind: "approval_required" | "input_required"; requestId: string; payload: ArtifactRef }
  | { kind: "host_lost"; details: ArtifactRef }
  | { kind: "terminal"; outcome: "completed" | "failed" | "cancelled"; evidence: ArtifactRef };

export interface BackendCatalog {
  identity: BackendIdentity;
  models: { providerId: string; modelId: string; efforts: string[] | "unknown"; isDefault: boolean }[];
  nativeFork: "unverified" | "verified" | "unavailable";
}

/** Adapter ports below are proposed BranchPilot APIs, not @muse-code/sdk APIs. */
export interface CodingBackend {
  discover(): Promise<BackendCatalog>;
  open(args: { workspace: string; settings: AgentSettings; resume?: BackendSessionRef; handoff: ArtifactRef }): Promise<BackendSessionRef>;
  submit(args: { session: BackendSessionRef; operation: OperationRecord; prompt: ArtifactRef }): Promise<{ session: BackendSessionRef; receipt: ArtifactRef }>;
  observe(session: BackendSessionRef): AsyncIterable<BackendEvent>; // Attached before submission.
  respond(session: BackendSessionRef, requestId: string, answer: ArtifactRef): Promise<void>;
  requestCancel(session: BackendSessionRef, operation: OperationRecord): Promise<void>; // Ack only.
  reconcile(operation: OperationRecord): Promise<
    | { status: "running"; session: BackendSessionRef }
    | { status: "terminal"; evidence: ArtifactRef }
    | { status: "not_admitted"; evidence: ArtifactRef }
    | { status: "unknown"; reason: string }
  >;
  close(): Promise<void>;
}

export interface WorkspaceManager {
  allocate(base?: CheckpointId): Promise<NonNullable<Attempt["workspace"]>>;
  checkpoint(workspaceId: string, conversation: Checkpoint["conversation"]): Promise<Checkpoint>;
  release(workspaceId: string): Promise<void>; // Only after all writers are confirmed stopped.
}

export interface ExperimentRunner {
  run(experiment: Experiment): Promise<{ outputs: ArtifactRef[]; usage: UsageMeasurement[] }>;
  cancel(operationId: OperationId): Promise<{ stopped: boolean; evidence: ArtifactRef }>;
  reconcile(operation: OperationRecord): Promise<"running" | "terminal" | "not_started" | "unknown">;
}

export interface Evaluator {
  evaluate(experiment: Experiment, outputs: readonly ArtifactRef[]): EvaluationResult;
}

export interface BudgetLedger {
  reserve(operationId: OperationId, maximum: ResourceAmount, phase: RunPhase): Promise<Reservation>;
  reconcile(id: ReservationId, usage: readonly UsageMeasurement[], stopEvidence: ArtifactRef): Promise<BudgetView>;
  view(runId: RunId): Promise<BudgetView>;
}

export interface Scheduler {
  execute(decision: Decision): Promise<void>; // Revalidates budgets, epoch and all dependencies.
  quiesce(mode: "drain" | "cancel", graceSeconds: number): Promise<"settled" | "needs_attention">;
  recover(runId: RunId): Promise<"settled" | "needs_attention">;
}

export interface RunEvent {
  schemaVersion: 1;
  eventId: Id<"event">;
  runId: RunId;
  sequence: number;
  recordedAt: Timestamp;
  type: string; // Implementation uses a versioned discriminated union.
  causedBy?: OperationId | DecisionId;
  payload: Json;
}

export interface RunStore {
  append(expectedSequence: number, events: readonly RunEvent[]): Promise<void>;
  replay(runId: RunId, afterSequence?: number): AsyncIterable<RunEvent>;
  putArtifact(bytes: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  searchView(runId: RunId): Promise<SearchView>;
}
