import type { Config, Resources, Strategy, EvaluatorSpec } from './config.js';
export type { Config, Resources, Strategy, EvaluatorSpec };
export type Digest = string;
export type Phase = 'baseline' | 'search' | 'held_out' | 'report';
export type Status = 'preparing' | 'active' | 'paused' | 'needs_attention' | 'finalizing' | 'completed' | 'cancelled' | 'failed';
export interface FileEntry { path: string; blob: Digest; executable: boolean }
export interface Snapshot { files: FileEntry[] }
export interface Revision {
  id: string; candidateId: string; parentIds: string[]; previousId?: string;
  snapshot: Digest; proposal: string; hypotheses: Hypothesis[];
  depth: number; attemptId?: string; createdAt: string;
}
export interface Hypothesis { id: string; assumption: string; expectedBenefit: string; uncertainty: string; prediction: string; falsificationTest: string }
export interface Measurement { name: string; unit: string; samples: number[]; estimate: number; uncertainty: { kind: 'range'; low: number; high: number } | { kind: 'unknown' } }
export interface Evaluation {
  id: string; workId: string; revisionId: string; evaluatorId: string;
  split: 'development' | 'held_out'; kind: EvaluatorSpec['kind'];
  definitionDigest: Digest; environmentDigest: Digest;
  validity: 'pass' | 'fail' | 'inconclusive' | 'not_applicable';
  checks: { id: string; outcome: 'pass' | 'fail' | 'unknown' }[];
  metrics: Measurement[]; feedback: string; findings: string[]; evidence: Digest[];
  failureType?: 'correctness' | 'constraint' | 'infrastructure' | 'timeout' | 'insufficient_evidence';
  reusedFrom?: { evaluationId: string; revisionId: string };
}
export interface Work {
  id: string; kind: 'attempt' | 'experiment'; phase: Phase; revisionId: string; candidateId?: string; evaluatorId?: string;
  reservation: Resources; state: 'reserved' | 'running' | 'settled' | 'unknown' | 'released';
  intent: Digest; workspace: string; index: number; epoch: number;
  startedAt?: string; outcome?: 'completed' | 'failed' | 'cancelled' | 'unknown';
  actual?: Omit<Resources, 'tokens'> & { tokens: number | null };
  observedTokens?: number;
  untrackedWork?: true;
  agentSettings?: import('./muse-models.js').ConfirmedAgentSettings;
  usageSource?: 'fixture' | 'host_reported' | 'runner_measured' | 'missing';
  receipt?: Digest; sessionId?: string; commandId?: string; turnId?: string;
  outputRevisionId?: string; preparedAt?: string; resourceGroup?: string;
  evaluationReservations?: Record<string, Resources>;
  operation?: { id: string; kind: 'answer' | 'reconcile'; intent: Digest; state: 'running' | 'unknown' | 'completed'; commandId?: string; userInputId?: string };
  pendingAnswer?: { commandId: string; userInputId: string };
  usageAfterAnswer?: { commandId: string; userInputId: string };
}
export interface FrozenEvaluator { spec: EvaluatorSpec; definitionDigest: Digest; bundle: Digest; entry: string; script?: string }
export interface EvaluationExposure {
  key: Digest; runId: string; evaluatorId: string; definitionDigest: Digest;
  datasetId?: string; split: Evaluation['split']; at: string;
  prior?: { runId: string; split: Evaluation['split']; definitionDigest: Digest; at: string };
}
export interface Manifest { configDigest: Digest; initialSnapshot: Digest; evaluators: FrozenEvaluator[]; environment: Digest; backend: Record<string, unknown>; evaluationHistory?: { directory: string; reuse: 'record' | 'reject' } }
export interface Decision { id: string; epoch: number; reason: string; evidenceIds: string[]; action: string; revisionId?: string }
export interface State {
  id: string; config: Config; manifest: Manifest; startedAt: string; deadline: string;
  status: Status; phase: Phase; strategy: Strategy; epoch: number;
  revisions: Revision[]; works: Record<string, Work>; evaluations: Evaluation[]; decisions: Decision[];
  baselineId?: string; finalists?: string[]; outcome?: string; message?: string;
  epochStartAttempts: number; pending?: { revisionId: string; evaluatorId: string; phase: Phase };
  backendInput?: { workId: string; artifact: Digest };
  backendInputs?: Record<string, Digest>;
  evaluationExposures?: EvaluationExposure[];
}
export type Event =
  | { type: 'run.created'; state: State }
  | { type: 'run.status'; status: Status; phase?: Phase; outcome?: string; message?: string; pending?: State['pending'] | null }
  | { type: 'revision.created'; revision: Revision; baseline?: boolean }
  | { type: 'work.reserved'; work: Work }
  | { type: 'work.updated'; work: Work }
  | { type: 'evaluation.recorded'; evaluation: Evaluation }
  | { type: 'evaluation.exposed'; exposure: EvaluationExposure }
  | { type: 'decision.recorded'; decision: Decision }
  | { type: 'strategy.changed'; strategy: Strategy; reason: string; policyMode: 'fixed' | 'auto' }
  | { type: 'finalists.selected'; revisionIds: string[] }
  | { type: 'backend.event'; workId: string; kind: string; artifact: Digest }
  | { type: 'backend.input_cleared'; workId: string }
  | { type: 'recovery.tail_discarded'; bytes: number };
export interface Envelope { schemaVersion: 1; sequence: number; previousHash: string; timestamp: string; events: Event[]; hash: string }

/** Persistent projection: unchanged records are shared; earlier states are never mutated. */
export function reduce(state: State | undefined, event: Event): State {
  if (event.type === 'run.created') { if (state) throw Error('Duplicate run.created'); return structuredClone(event.state); }
  if (!state) throw Error('Log must begin with run.created');
  switch (event.type) {
    case 'run.status': {
      const { type: _, pending, ...patch } = event;
      const next = { ...state, ...patch };
      if (pending === null) delete next.pending; else if (pending) next.pending = pending;
      return next;
    }
    case 'revision.created': {
      if (state.revisions.some(r => r.id === event.revision.id)) throw Error('Duplicate revision');
      for (const parent of event.revision.parentIds) if (!state.revisions.some(r => r.id === parent)) throw Error('Missing parent revision');
      const order = (r: Revision) => r.attemptId ? state.works[r.attemptId]!.index + 1 : 0;
      return { ...state, revisions: insertOrdered(state.revisions, event.revision, (a, b) => order(a) - order(b)), ...(event.baseline ? { baselineId: event.revision.id } : {}) };
    }
    case 'work.reserved':
      if (state.works[event.work.id]) throw Error('Duplicate work');
      return { ...state, works: { ...state.works, [event.work.id]: event.work } };
    case 'work.updated':
      if (!state.works[event.work.id]) throw Error('Unknown work');
      return { ...state, works: { ...state.works, [event.work.id]: event.work } };
    case 'evaluation.recorded': {
      if (state.evaluations.some(e => e.id === event.evaluation.id)) throw Error('Duplicate evaluation');
      const revisions = new Map(state.revisions.map((r, index) => [r.id, index]));
      const evaluators = new Map(state.config.task.evaluators.map((e, index) => [e.id, index]));
      const compare = (a: Evaluation, b: Evaluation) => (revisions.get(a.revisionId) ?? -1) - (revisions.get(b.revisionId) ?? -1) || (evaluators.get(a.evaluatorId) ?? -1) - (evaluators.get(b.evaluatorId) ?? -1);
      return { ...state, evaluations: insertOrdered(state.evaluations, event.evaluation, compare) };
    }
    case 'decision.recorded': return { ...state, decisions: [...state.decisions, event.decision] };
    case 'evaluation.exposed': return { ...state, evaluationExposures: [...(state.evaluationExposures ?? []), event.exposure] };
    case 'strategy.changed': return {
      ...state, strategy: event.strategy, epoch: state.epoch + 1,
      config: { ...state.config, policy: { ...state.config.policy, mode: event.policyMode } },
      epochStartAttempts: Object.values(state.works).filter(w => w.kind === 'attempt' && w.state !== 'released').length,
    };
    case 'finalists.selected':
      if (state.finalists) throw Error('Finalists already frozen');
      return { ...state, finalists: event.revisionIds };
    case 'recovery.tail_discarded': return state;
    case 'backend.event':
      if (event.kind !== 'muse.input_required') return state;
      return { ...state, backendInputs: { ...(state.backendInputs ?? (state.backendInput ? { [state.backendInput.workId]: state.backendInput.artifact } : {})), [event.workId]: event.artifact }, backendInput: { workId: event.workId, artifact: event.artifact } };
    case 'backend.input_cleared': {
      const inputs = { ...(state.backendInputs ?? (state.backendInput ? { [state.backendInput.workId]: state.backendInput.artifact } : {})) };
      delete inputs[event.workId];
      const next = { ...state, backendInputs: inputs }; const remaining = Object.entries(inputs)[0];
      if (remaining) next.backendInput = { workId: remaining[0], artifact: remaining[1] }; else delete next.backendInput;
      return next;
    }
    default: throw Error(`Unsupported event type: ${(event as { type: string }).type}`);
  }
}

/** Stable upper-bound insertion preserves dispatch order without sorting the whole archive. */
function insertOrdered<T>(values: T[], value: T, compare: (a: T, b: T) => number): T[] {
  let low = 0; let high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (compare(values[middle]!, value) <= 0) low = middle + 1; else high = middle; }
  const next = values.slice(); next.splice(low, 0, value); return next;
}
