import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { actualUsage, add, admit, zero } from './budget.js';
import { FixtureBackend } from './backend.js';
import type { Backend, BackendAnswer, BackendOperation } from './backend.js';
import { backendAnswerSchema, validateBackendAnswer } from './backend-input.js';
import { MuseBackend, verifyMuseLock } from './muse.js';
import { aggregate, outputSchema } from './evaluation.js';
import type { EvaluatorOutput } from './evaluation.js';
import { capture, contained, materialize, rejectEvaluatorInsideInput } from './workspaces.js';
import { atomicWrite, hash, id, RunStore } from './store.js';
import { runProcess, sandboxCommand } from './process.js';
import type { Evaluation, FrozenEvaluator, Phase, Revision, Work } from './types.js';
import type { DevelopmentPlan } from './search.js';
import { candidateOutput } from './candidate-output.js';
import { executableDefinitionSchema, npmTool } from './repository-workflow.js';
import type { RepositoryWorkflow } from './repository-workflow.js';
import { executionEnvironment } from './environment.js';
import { HoldoutReuseError, recordEvaluationExposure } from './evaluation-history.js';
import { museEnvironment } from './muse-environment.js';
import { buildAttemptPrompt } from './handoff.js';

export class InteractionRequired extends Error {}
export interface Completion { work: Work; revision?: Revision; evaluation?: Evaluation; clearInput?: boolean }

export function freezeEvaluator(store: RunStore, spec: FrozenEvaluator['spec'], input?: string): FrozenEvaluator {
  if (input) rejectEvaluatorInsideInput(input, spec.definition.path);
  const raw: unknown = JSON.parse(readFileSync(spec.definition.path, 'utf8'));
  const definition = spec.kind === 'executable'
    ? executableDefinitionSchema.parse(raw)
    : z.object({ schemaVersion: z.literal(1), rubric: z.array(z.string()).min(1) }).strict().parse(raw);
  const paths = 'script' in definition ? [...new Set([definition.script, ...definition.files])].sort() : [];
  const files = paths.map(path => {
    const file = contained(dirname(spec.definition.path), path);
    if (input) rejectEvaluatorInsideInput(input, file);
    return { path, blob: store.put(readFileSync(file)), executable: false };
  });
  const bundle = store.putJSON({ files });
  return { spec, definitionDigest: store.putJSON({ definition, bundle, ...('workflow' in definition && definition.workflow?.install ? { npm: npmTool() } : {}) }), bundle, entry: spec.definition.path, ...('script' in definition ? { script: definition.script } : {}) };
}

export class Scheduler {
  readonly store: RunStore;
  readonly backend: Backend;
  readonly signal: AbortSignal;
  constructor(store: RunStore, signal: AbortSignal, backend?: Backend) {
    this.store = store; this.signal = signal;
    this.backend = backend ?? (store.state.config.backend.kind === 'fixture' ? new FixtureBackend() : new MuseBackend());
  }
  private verifyEnvironment(): void {
    if (hash(JSON.stringify(executionEnvironment(this.store.state.config))) === this.store.state.manifest.environment) return;
    const message = 'Execution environment differs from the frozen manifest; restore it or create a new run before dispatching work';
    this.store.append({ type: 'run.status', status: 'needs_attention', message });
    throw new InteractionRequired(message);
  }
  private verifyBackend(): void {
    const state = this.store.state; const config = state.config.backend;
    if (config.kind !== 'muse') return;
    try {
      const current = { kind: 'muse', ...verifyMuseLock(config.binary, config.compatibilityLock) };
      museEnvironment(current.runtimeHome, this.store.dir, config.apiKeyEnv);
      if (hash(JSON.stringify(current)) !== hash(JSON.stringify(state.manifest.backend))) throw Error('Muse compatibility settings differ from the frozen manifest; restore the lock or create a new run');
    } catch (error) {
      this.store.append({ type: 'run.status', status: 'needs_attention', message: String(error) });
      throw new InteractionRequired(String(error));
    }
  }
  private reserve(work: Work, source?: { work: Work; evaluatorId: string }): void {
    this.signal.throwIfAborted();
    const state = this.store.state;
    if (work.kind === 'attempt' || state.manifest.evaluators.find(evaluator => evaluator.spec.id === work.evaluatorId)?.spec.kind === 'executable') this.verifyEnvironment();
    if (work.kind === 'attempt') this.verifyBackend();
    const cost = { ...work.reservation };
    for (const reservation of Object.values(work.evaluationReservations ?? {})) add(cost, reservation);
    let parent: Work | undefined;
    let admission = state;
    if (source?.work.evaluationReservations?.[source.evaluatorId]) {
      parent = { ...state.works[source.work.id]!, evaluationReservations: { ...state.works[source.work.id]!.evaluationReservations } };
      delete parent.evaluationReservations![source.evaluatorId];
      admission = { ...state, works: { ...state.works, [parent.id]: parent } };
    }
    admit(admission, cost, work.phase);
    if (work.resourceGroup && Object.values(state.works).some(w => w.resourceGroup === work.resourceGroup && ['reserved', 'running', 'unknown'].includes(w.state))) throw Error(`Resource group is occupied: ${work.resourceGroup}`);
    this.store.append(...(parent ? [{ type: 'work.updated' as const, work: parent }] : []), { type: 'work.reserved', work });
  }
  releaseEvaluations(revision: Revision): void {
    const work = revision.attemptId ? this.store.state.works[revision.attemptId] : undefined;
    if (work && Object.keys(work.evaluationReservations ?? {}).length) this.store.append({ type: 'work.updated', work: { ...work, evaluationReservations: {} } });
  }
  releasePrepared(works: Work[]): void {
    for (const work of works) if (this.store.state.works[work.id]?.state === 'reserved') this.store.append({ type: 'work.updated', work: { ...this.store.state.works[work.id]!, state: 'released', evaluationReservations: {} } });
  }
  private evaluationSource(revision: Revision, evaluatorId: string): { work: Work; evaluatorId: string } | undefined {
    const work = revision.attemptId ? this.store.state.works[revision.attemptId] : undefined;
    return work ? { work, evaluatorId } : undefined;
  }
  private activeEvaluations = 0;
  private groups = new Set<string>();
  private evaluationQueue: { group?: string; enter: () => void }[] = [];
  private drainEvaluations(): void {
    for (let i = 0; i < this.evaluationQueue.length && this.activeEvaluations < this.store.state.config.budget.maxConcurrency;) {
      const entry = this.evaluationQueue[i]!;
      if (entry.group && this.groups.has(entry.group)) { i++; continue; }
      this.evaluationQueue.splice(i, 1); this.activeEvaluations++;
      if (entry.group) this.groups.add(entry.group);
      entry.enter();
    }
  }
  private async withEvaluationResource<T>(group: string | undefined, run: () => Promise<T>): Promise<T> {
    await new Promise<void>(enter => { this.evaluationQueue.push({ group, enter }); this.drainEvaluations(); });
    try { return await run(); }
    finally { this.activeEvaluations--; if (group) this.groups.delete(group); this.drainEvaluations(); }
  }
  private start(work: Work): Work {
    const started: Work = { ...work, state: 'running', startedAt: new Date().toISOString() };
    this.store.append({ type: 'work.updated', work: started }); return started;
  }
  private expose(evaluator: FrozenEvaluator): void {
    try { recordEvaluationExposure(this.store, evaluator); }
    catch (error) {
      if (!(error instanceof HoldoutReuseError)) throw error;
      this.store.append({ type: 'run.status', status: 'needs_attention', message: error.message });
      throw new InteractionRequired(error.message);
    }
  }
  private usageObserver(getWork: () => Work, setWork: (work: Work) => void, controller: AbortController): (tokens: number) => void {
    let requested = false;
    return tokens => {
      const work = getWork();
      actualUsage(work, tokens, 0);
      if (work.observedTokens === undefined || tokens > work.observedTokens) {
        const updated = { ...work, observedTokens: Math.max(work.observedTokens ?? 0, tokens) };
        this.store.append({ type: 'work.updated', work: updated }); setWork(updated);
      }
      if (!requested && this.store.state.config.budget.tokenLimitPolicy === 'cancel-at-reservation' && tokens >= work.reservation.tokens) {
        requested = true;
        this.store.append({ type: 'backend.event', workId: work.id, kind: 'budget.token_limit', artifact: this.store.putJSON({ observed: tokens, allocation: work.reservation.tokens, action: 'request_cancellation', hardProviderLimit: false }) });
        controller.abort(Error('Attempt token allocation reached'));
      }
    };
  }
  private complete(result: Completion): void {
    const path = join(this.store.dir, 'operations', result.work.operation?.id ?? result.work.id); mkdirSync(path, { recursive: true });
    const digest = this.store.putJSON(result);
    atomicWrite(join(path, 'result.json'), JSON.stringify({ digest }));
    this.importCompletion(result);
  }
  importCompletion(result: Completion): void {
    const existing = this.store.state.works[result.work.id];
    if (!existing) throw Error('Completion does not belong to known work');
    if (existing.operation?.id !== result.work.operation?.id) throw Error('Completion does not match the current recovery operation');
    if (existing.state === 'settled' && existing.operation?.state !== 'running') return;
    if (existing.state === result.work.state && existing.receipt === result.work.receipt && existing.operation?.state === result.work.operation?.state) return;
    this.store.append(
      { type: 'work.updated', work: result.work },
      ...(result.revision ? [{ type: 'revision.created' as const, revision: result.revision }] : []),
      ...(result.evaluation ? [{ type: 'evaluation.recorded' as const, evaluation: result.evaluation }] : []),
      ...(result.clearInput ? [{ type: 'backend.input_cleared' as const, workId: result.work.id }] : []),
    );
  }
  async develop(plan: DevelopmentPlan): Promise<Revision | undefined> {
    const work = this.prepare(plan);
    return this.executePrepared(work);
  }
  prepare(plan: DevelopmentPlan): Work {
    const state = this.store.state; const base = state.revisions.find(r => r.id === plan.baseId);
    if (state.finalists || ['completed', 'cancelled', 'failed'].includes(state.status)) throw Error('Search is closed after final selection or termination');
    if (!base) throw Error('Unknown base revision');
    const workId = id(); const candidateId = plan.candidateId ?? id();
    const index = Object.values(state.works).filter(w => w.kind === 'attempt' && w.state !== 'released').length;
    const prompt = buildAttemptPrompt(state, base, plan, digest => this.store.getJSON(digest));
    let work: Work = { id: workId, kind: 'attempt', phase: 'search', revisionId: base.id, candidateId, reservation: { tokens: state.config.budget.perAttempt.tokenReservation, workSeconds: state.config.budget.perAttempt.timeoutSeconds, attempts: 1, experiments: 0 }, state: 'reserved', outputRevisionId: id(), preparedAt: new Date().toISOString(), evaluationReservations: Object.fromEntries(state.manifest.evaluators.filter(e => e.spec.split === 'development').map(e => [e.spec.id, { ...zero(), experiments: 1, workSeconds: e.spec.kind === 'human_preference' ? 0 : e.spec.timeoutSeconds }])), intent: this.store.putJSON({ prompt, baseRevisionId: base.id, candidateId, index, retry: Boolean(plan.candidateId) }), workspace: join(this.store.dir, 'workspaces', workId), index, epoch: state.epoch };
    this.reserve(work);
    return work;
  }
  async executePrepared(prepared: Work): Promise<Revision | undefined> {
    const state = this.store.state;
    if (state.works[prepared.id]?.state !== 'reserved') throw Error('Attempt is not reserved');
    let work = state.works[prepared.id]!;
    const { prompt, retry } = this.store.getJSON<{ prompt: string; retry?: boolean }>(work.intent);
    const base = state.revisions.find(r => r.id === work.revisionId)!;
    const workId = work.id; const candidateId = work.candidateId!;
    try { this.signal.throwIfAborted(); materialize(this.store, base.snapshot, work.workspace); }
    catch (error) { this.releasePrepared([work]); throw error; }
    work = this.start(work);
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', onAbort, { once: true });
    if (this.signal.aborted) onAbort();
    const timeout = setTimeout(() => controller.abort(new Error('Attempt timeout')), state.config.budget.perAttempt.timeoutSeconds * 1000);
    let stopped = false;
    try {
      const result = await this.backend.execute({ config: state.config, backendIdentity: state.manifest.backend, work, base, prompt, signal: controller.signal, reportUsage: this.usageObserver(() => work, updated => { work = updated; }, controller), record: (kind, data, identity) => {
        const artifact = this.store.putJSON(data);
        if (identity) work = { ...work, ...identity };
        if (kind === 'muse.untracked_work') work = { ...work, untrackedWork: true };
        if (kind === 'muse.settings_confirmed') work = { ...work, agentSettings: data as Work['agentSettings'] };
        this.store.append({ type: 'backend.event', workId, kind, artifact }, ...(identity || kind === 'muse.untracked_work' || kind === 'muse.settings_confirmed' ? [{ type: 'work.updated' as const, work }] : []));
      } });
      const receipt = this.store.putJSON(result.receipt);
      const actual = actualUsage(work, result.tokens, (Date.now() - Date.parse(work.startedAt!)) / 1000);
      if (result.observedTokens !== undefined) actualUsage(work, result.observedTokens, 0);
      const observedTokens = Math.max(work.observedTokens ?? 0, result.tokens ?? 0, result.observedTokens ?? 0);
      if (actual.tokens !== null && actual.tokens < observedTokens) actual.tokens = null;
      const usageSource = actual.tokens === null ? 'missing' : state.config.backend.kind === 'fixture' ? 'fixture' : 'host_reported';
      work = { ...work, actual, usageSource, receipt, observedTokens };
      if (!result.stopped || result.outcome === 'unknown') {
        work = { ...work, state: 'unknown', outcome: 'unknown', actual, usageSource, receipt };
        this.store.append({ type: 'work.updated', work }, { type: 'run.status', status: 'needs_attention', message: `Attempt ${work.id} has an unknown outcome; do not resubmit it` });
        return;
      }
      stopped = true;
      let revision: Revision | undefined;
      // A local attempt allowance is a checkpoint, not a user cancellation.
      // Grade the actual files only after confirmed stop and complete usage;
      // keep the cancelled outcome and never treat the model's claims as proof.
      const checkpoint = result.outcome === 'cancelled' && state.config.task.type === 'code'
        && controller.signal.aborted && !this.signal.aborted && actual.tokens !== null && !work.untrackedWork;
      if (result.outcome === 'completed' || checkpoint) {
        const output = checkpoint ? { proposal: base.proposal, hypotheses: base.hypotheses }
          : candidateOutput(work.workspace, result, state.config.task.type === 'idea', state.config.backend.kind === 'muse');
        const snapshot = capture(this.store, work.workspace);
        if (!checkpoint || snapshot !== base.snapshot) revision = { id: work.outputRevisionId ?? id(), candidateId, parentIds: [base.id], ...(retry ? { previousId: base.id } : {}), snapshot, ...output, depth: base.depth + 1, attemptId: work.id, createdAt: work.preparedAt ?? work.startedAt! };
        if (checkpoint) this.store.append({ type: 'backend.event', workId, kind: 'attempt.checkpoint', artifact: this.store.putJSON({ revisionId: revision?.id, snapshot, unchanged: !revision, reason: String(controller.signal.reason), modelOutcome: result.outcome, requiresExternalGrading: Boolean(revision) }) });
      } else {
        this.store.append({ type: 'backend.event', workId, kind: 'partial_snapshot', artifact: capture(this.store, work.workspace) });
      }
      work = { ...work, state: 'settled', outcome: result.outcome, ...(!revision ? { evaluationReservations: {} } : {}) };
      this.complete({ work, revision });
      if (actual.tokens === null) this.store.append({ type: 'run.status', status: 'needs_attention', message: `Missing usage for ${work.id}; its token reservation remains a liability` });
      return revision;
    } catch (error) {
      if (stopped && work.actual) {
        // Output capture can fail after a proven stop. Keep its paid usage and
        // reject the output without manufacturing uncertain execution.
        work = { ...work, state: 'settled', outcome: 'failed', evaluationReservations: {}, receipt: this.store.putJSON({ backendReceipt: work.receipt, error: String(error) }) };
        this.complete({ work });
        this.store.append({ type: 'run.status', status: 'needs_attention', message: `Attempt output could not be saved: ${String(error)}` });
        return;
      }
      // Any exception after dispatch is ambiguous. Preserve the reservation and workspace.
      work = { ...work, state: 'unknown', outcome: 'unknown', receipt: this.store.putJSON({ error: String(error) }) };
      this.store.append({ type: 'work.updated', work }, { type: 'run.status', status: 'needs_attention', message: `Attempt interrupted: ${String(error)}` });
      return;
    } finally { clearTimeout(timeout); this.signal.removeEventListener('abort', onAbort); }
  }

  async evaluate(revision: Revision, evaluator: FrozenEvaluator, phase: Phase): Promise<Evaluation | undefined> {
    // Identical deterministic checks share a queue slot: the first executes and
    // followers can reuse its settled pass instead of duplicating in-flight work.
    const group = evaluator.spec.resourceGroup ?? (evaluator.spec.reuseIdentical ? `snapshot:${evaluator.spec.id}:${revision.snapshot}` : undefined);
    return this.withEvaluationResource(group, () => this.evaluateOwned(revision, evaluator, phase));
  }
  private async evaluateOwned(revision: Revision, evaluator: FrozenEvaluator, phase: Phase): Promise<Evaluation | undefined> {
    if (this.store.state.status === 'needs_attention' || this.store.state.backendInput) throw new InteractionRequired('Dispatch stopped for unresolved work or input');
    const spec = evaluator.spec;
    this.signal.throwIfAborted();
    if ((phase === 'held_out') !== (spec.split === 'held_out') || phase === 'report') throw Error('Evaluator phase must match its data split');
    if (spec.split === 'development' && this.store.state.finalists) throw Error('Development evaluation is closed after final selection');
    if (spec.split === 'held_out' && ![this.store.state.baselineId, ...(this.store.state.finalists ?? [])].includes(revision.id)) throw Error('Held-out evaluation requires a frozen finalist or baseline');
    const existing = this.store.state.evaluations.find(e => e.revisionId === revision.id && e.evaluatorId === spec.id);
    if (existing) return existing;
    if (phase !== 'held_out' && spec.split === 'held_out') throw Error('Held-out evaluator is unavailable during search');
    if (spec.split === 'held_out' && !this.store.state.finalists) throw Error('Freeze finalists before held-out evaluation');
    for (const dependency of spec.dependsOn) {
      if (!this.store.state.evaluations.some(e => e.revisionId === revision.id && e.evaluatorId === dependency && e.validity === 'pass')) return;
    }
    if (spec.reuseIdentical && spec.kind === 'executable' && spec.role === 'correctness' && spec.split === 'development') {
      this.verifyEnvironment();
      const state = this.store.state;
      const snapshots = new Map(state.revisions.map(r => [r.id, r.snapshot]));
      // Metric-bearing results always run fresh, including metrics emitted by a
      // correctness evaluator. Reuse must not impersonate another measurement.
      const source = state.evaluations.find(e => e.evaluatorId === spec.id && e.split === 'development' && e.kind === 'executable' && e.validity === 'pass' && !e.failureType && !e.metrics.length && e.definitionDigest === evaluator.definitionDigest && e.environmentDigest === state.manifest.environment && state.works[e.workId]?.state === 'settled' && snapshots.get(e.revisionId) === revision.snapshot);
      if (source) {
        const evaluation: Evaluation = { ...source, id: id(), revisionId: revision.id, reusedFrom: source.reusedFrom ?? { evaluationId: source.id, revisionId: source.revisionId } };
        const original = this.evaluationSource(revision, spec.id)?.work;
        const updated = original ? { ...original, evaluationReservations: { ...original.evaluationReservations } } : undefined;
        if (updated) delete updated.evaluationReservations![spec.id];
        this.store.append(...(updated ? [{ type: 'work.updated' as const, work: updated }] : []), { type: 'evaluation.recorded', evaluation });
        return evaluation;
      }
    }
    if (spec.kind === 'human_preference') {
      this.expose(evaluator);
      this.store.append({ type: 'run.status', status: 'paused', pending: { revisionId: revision.id, evaluatorId: spec.id, phase }, message: `Human assessment required: ${spec.id} for ${revision.id}` });
      throw new InteractionRequired('Use the assess command to record the rubric result, then resume');
    }
    const workId = id();
    let work: Work = { id: workId, kind: 'experiment', phase, revisionId: revision.id, evaluatorId: spec.id, reservation: { ...zero(), workSeconds: spec.timeoutSeconds, experiments: 1 }, state: 'reserved', intent: this.store.putJSON({ revisionId: revision.id, snapshot: revision.snapshot, evaluator: evaluator.definitionDigest, environment: this.store.state.manifest.environment }), workspace: join(this.store.dir, 'workspaces', workId, 'input'), resourceGroup: spec.resourceGroup, index: 0, epoch: this.store.state.epoch };
    this.reserve(work, this.evaluationSource(revision, spec.id));
    const evaluatorDir = join(dirname(work.workspace), 'evaluator');
    const scratch = join(dirname(work.workspace), 'scratch');
    let frozen: { definition: { seed: number; workflow?: RepositoryWorkflow }; npm?: ReturnType<typeof npmTool> };
    const buildDirectory = join(scratch, 'project');
    try {
      this.signal.throwIfAborted();
      materialize(this.store, revision.snapshot, work.workspace);
      materialize(this.store, evaluator.bundle, evaluatorDir); mkdirSync(scratch);
      frozen = this.store.getJSON(evaluator.definitionDigest);
      if (frozen.definition.workflow) materialize(this.store, revision.snapshot, buildDirectory);
      this.expose(evaluator);
    } catch (error) { this.releasePrepared([work]); throw error; }
    work = this.start(work);
    const samples: EvaluatorOutput[] = []; const evidence: string[] = []; let failure: Evaluation['failureType']; let feedback = ''; let stopped = true;
    const started = Date.now();
    try {
      const workflow = frozen.definition.workflow;
      const stages: { stage: string; command: string; args: string[] }[] = [];
      if (workflow?.install) {
        const npm = npmTool();
        if (JSON.stringify(npm) !== JSON.stringify(frozen.npm)) throw Error('npm CLI changed after evaluator freezing');
        stages.push({ stage: 'install', command: process.execPath, args: [npm.path, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(scratch, 'npm-cache')] });
      }
      for (const build of workflow?.build ?? []) stages.push({ stage: 'build', command: process.execPath, args: [contained(buildDirectory, build.script), ...build.args] });
      for (const stage of stages) {
        const remaining = spec.timeoutSeconds * 1000 - (Date.now() - started);
        if (remaining <= 0) { failure = 'timeout'; feedback = 'Repository workflow exceeded its total time limit'; break; }
        let { command, args } = stage;
        if (this.store.state.config.execution.isolationProfile === 'sandbox-exec') [command, args] = sandboxCommand(command, args, [work.workspace, evaluatorDir], [scratch]);
        const result = await runProcess(command, args, { cwd: buildDirectory, timeoutMs: remaining, graceMs: this.store.state.config.budget.cancellationGraceSeconds * 1000, signal: this.signal, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, npm_config_userconfig: join(scratch, 'empty.npmrc'), npm_config_globalconfig: join(scratch, 'empty-global.npmrc'), npm_config_offline: 'true', npm_config_ignore_scripts: 'true' } });
        evidence.push(this.store.putJSON({ stage: stage.stage, command, args, ...result }));
        if (!result.stopped) { stopped = false; break; }
        if (result.timedOut || result.cancelled) { failure = 'timeout'; feedback = `Repository ${stage.stage} timed out or was cancelled`; break; }
        if (result.code !== 0 || result.truncated) { failure = stage.stage === 'build' && !result.truncated ? 'correctness' : 'infrastructure'; feedback = `Repository ${stage.stage} failed: ${result.stderr.slice(0, 2000)}`; break; }
      }
      for (let repetition = 0; repetition < spec.warmups + spec.repetitions; repetition++) {
        if (failure || !stopped) break;
        const remaining = spec.timeoutSeconds * 1000 - (Date.now() - started);
        if (remaining <= 0) { failure = 'timeout'; feedback = 'Experiment exceeded its total time limit'; break; }
        const script = contained(evaluatorDir, evaluator.script!);
        let command = process.execPath; let args = [script, work.workspace];
        if (this.store.state.config.execution.isolationProfile === 'sandbox-exec') [command, args] = sandboxCommand(command, args, [work.workspace, evaluatorDir], [scratch]);
        const processResult = await runProcess(command, args, { cwd: scratch, timeoutMs: remaining, graceMs: this.store.state.config.budget.cancellationGraceSeconds * 1000, signal: this.signal, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, BRANCHPILOT_REPETITION: String(repetition), BRANCHPILOT_SEED: String(frozen.definition.seed), ...(workflow ? { BRANCHPILOT_BUILD_DIRECTORY: buildDirectory } : {}) } });
        evidence.push(this.store.putJSON({ repetition, warmup: repetition < spec.warmups, ...processResult }));
        if (!processResult.stopped) { stopped = false; break; }
        if (processResult.timedOut || processResult.cancelled) { failure = 'timeout'; feedback = processResult.cancelled ? 'Experiment cancelled' : 'Experiment timed out'; break; }
        if (processResult.code !== 0 || processResult.truncated) { failure = 'infrastructure'; feedback = `Evaluator exited ${processResult.code}; stderr: ${processResult.stderr.slice(0, 2000)}`; break; }
        const output = outputSchema.parse(JSON.parse(processResult.stdout));
        if (repetition >= spec.warmups) samples.push(output);
      }
      if (capture(this.store, work.workspace) !== revision.snapshot || capture(this.store, evaluatorDir) !== evaluator.bundle) { failure = 'infrastructure'; feedback = 'Evaluator changed its input snapshot or trusted evaluator assets'; }
    } catch (error) { failure = 'infrastructure'; feedback = String(error); }
    if (!stopped) {
      this.store.append({ type: 'work.updated', work: { ...work, state: 'unknown', outcome: 'unknown' } }, { type: 'run.status', status: 'needs_attention', message: `Cannot confirm experiment ${workId} stopped` });
      return;
    }
    let summary: ReturnType<typeof aggregate>;
    try { summary = failure ? { validity: failure === 'correctness' ? 'fail' : 'inconclusive', checks: [], metrics: [], feedback, findings: [] } : aggregate(samples); }
    catch (error) { failure = 'infrastructure'; summary = { validity: 'inconclusive', checks: [], metrics: [], feedback: String(error), findings: [] }; }
    const evaluation: Evaluation = { ...summary, id: id(), workId, revisionId: revision.id, evaluatorId: spec.id, split: spec.split, kind: spec.kind, definitionDigest: evaluator.definitionDigest, environmentDigest: this.store.state.manifest.environment, evidence, ...(failure ? { failureType: failure } : summary.validity === 'fail' ? { failureType: 'correctness' as const } : {}) };
    work = { ...work, state: 'settled', outcome: failure ? 'failed' : 'completed', actual: actualUsage(work, 0, (Date.now() - started) / 1000), usageSource: 'runner_measured', receipt: this.store.putJSON({ evaluationId: evaluation.id, evidence }) };
    this.complete({ work, evaluation });
    return evaluation;
  }

  assess(output: EvaluatorOutput, rater: string): Evaluation {
    const state = this.store.state; const pending = state.pending;
    if (!pending || state.status !== 'paused') throw Error('No pending human assessment');
    const evaluator = state.manifest.evaluators.find(e => e.spec.id === pending.evaluatorId)!;
    const workId = id(); const evidence = this.store.putJSON({ output, rater, recordedAt: new Date().toISOString(), rubricDigest: evaluator.definitionDigest });
    let work: Work = { id: workId, kind: 'experiment', phase: pending.phase, revisionId: pending.revisionId, evaluatorId: pending.evaluatorId, reservation: { ...zero(), experiments: 1 }, state: 'reserved', intent: evidence, workspace: '', index: 0, epoch: state.epoch };
    this.reserve(work, this.evaluationSource(state.revisions.find(r => r.id === pending.revisionId)!, pending.evaluatorId)); work = this.start(work);
    const evaluation: Evaluation = { ...aggregate([output]), id: id(), workId, revisionId: pending.revisionId, evaluatorId: pending.evaluatorId, split: evaluator.spec.split, kind: 'human_preference', definitionDigest: evaluator.definitionDigest, environmentDigest: state.manifest.environment, evidence: [evidence] };
    work = { ...work, state: 'settled', outcome: 'completed', actual: actualUsage(work, 0, 0), usageSource: 'runner_measured', receipt: evidence };
    this.complete({ work, evaluation });
    this.store.append({ type: 'run.status', status: 'paused', pending: null, message: 'Assessment recorded; resume to continue' });
    return evaluation;
  }

  async recoverBackend(workId: string, kind: BackendOperation, input?: unknown): Promise<void> {
    this.recover();
    const state = this.store.state; let work = state.works[workId];
    if (!work || work.kind !== 'attempt') throw Error('Select an existing backend attempt');
    if (state.finalists || ['completed', 'cancelled', 'failed'].includes(state.status)) throw Error('Backend recovery is closed after final selection or termination');
    if (Object.values(state.works).some(w => w.state === 'running' || w.state === 'reserved')) throw Error('Settle active work before backend recovery');
    if (!work.sessionId || !work.commandId) throw Error('Work has no durable backend session/command identity');
    const run = kind === 'answer' ? this.backend.answer : this.backend.reconcile;
    if (!run) throw Error(`Backend does not support ${kind}`);
    this.verifyBackend();
    this.backend.checkOperation?.(kind, state.config);
    let answer: BackendAnswer | undefined;
    if (kind === 'answer') {
      if (work.state !== 'unknown' || !work.turnId) throw Error('Answering requires a nonterminal uncertain attempt with an observed turn ID; reconcile terminal work instead');
      if (work.pendingAnswer || (work.operation?.kind === 'answer' && work.operation.state !== 'completed')) throw Error('An earlier answer is uncertain; reconcile it before sending another answer');
      const parsed = backendAnswerSchema.parse(input);
      const artifact = state.backendInputs?.[workId] ?? (state.backendInput?.workId === workId ? state.backendInput.artifact : undefined);
      if (!artifact) throw Error('No pending backend input for this work');
      const questions = this.store.getJSON<unknown[]>(artifact);
      const question = questions.find(q => typeof q === 'object' && q !== null && 'userInputId' in q && q.userInputId === parsed.userInputId);
      answer = validateBackendAnswer(parsed, question, work.sessionId, work.turnId);
    } else if (work.state !== 'unknown' && !(work.state === 'settled' && (work.actual?.tokens === null || state.backendInputs?.[workId] || state.backendInput?.workId === workId))) throw Error('Work has no unresolved execution, input or usage');
    const base = state.revisions.find(r => r.id === work!.revisionId)!;
    const previousSeconds = work.actual?.workSeconds ?? 0;
    const reservation = { ...work.reservation, tokens: Math.max(work.reservation.tokens, work.actual?.tokens ?? 0, work.observedTokens ?? 0) + (answer ? state.config.budget.perAttempt.tokenReservation : 0), workSeconds: Math.max(work.reservation.workSeconds, previousSeconds) + state.config.budget.perAttempt.timeoutSeconds };
    const cost = { ...reservation };
    for (const escrow of Object.values(work.evaluationReservations ?? {})) add(cost, escrow);
    // Reconciliation may inspect one unknown operation without pardoning any
    // other unknown work. Answering also requires every other liability settled.
    const admission = { ...state, works: Object.fromEntries(Object.entries(state.works).map(([key, value]) => [key, key === workId ? { ...value, state: 'released' as const } : value])) };
    this.signal.throwIfAborted();
    // Inspection cannot dispatch model work and remains available for cleanup
    // after a deadline or exhausted budget. Its bounded elapsed time is charged.
    if (kind === 'answer') { this.verifyEnvironment(); admit(admission, cost, 'search'); }
    const operation = { id: id(), kind, intent: this.store.putJSON({ kind, workId, sessionId: work.sessionId, turnId: work.turnId, originalCommandId: work.commandId, answer }), state: 'running' as const, ...(answer ? { userInputId: answer.userInputId } : {}) };
    work = { ...work, reservation, operation, state: 'unknown', receipt: undefined, usageAfterAnswer: work.usageAfterAnswer ?? work.pendingAnswer };
    this.store.append({ type: 'work.updated', work }, { type: 'run.status', status: 'needs_attention', message: `${kind} in progress for ${workId}` });
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', abort, { once: true }); if (this.signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(Error('Backend recovery timeout')), state.config.budget.perAttempt.timeoutSeconds * 1000);
    const began = Date.now();
    let stopped = false;
    try {
      const request = { config: state.config, backendIdentity: state.manifest.backend, work, base, prompt: '', signal: controller.signal, ...(kind === 'answer' ? { reportUsage: this.usageObserver(() => work!, updated => { work = updated; }, controller) } : {}), record: (event: string, data: unknown, identity?: Partial<Pick<Work, 'sessionId' | 'commandId' | 'turnId'>>) => {
        if (identity?.sessionId && identity.sessionId !== work!.sessionId) throw Error('Recovery changed the original session identity');
        if (identity?.commandId && identity.commandId !== work!.commandId) throw Error('Recovery changed the original turn command identity');
        if (identity?.turnId && work!.turnId && identity.turnId !== work!.turnId) throw Error('Recovery changed the original turn identity');
        work = { ...work!, ...identity };
        if (event === 'muse.untracked_work') work.untrackedWork = true;
        if (event === 'muse.answer_prepared') {
          const commandId = (data as { commandId: string }).commandId;
          work.operation = { ...work.operation!, commandId };
          work.pendingAnswer = { commandId, userInputId: answer!.userInputId };
          work.usageAfterAnswer = { ...work.pendingAnswer };
        }
        this.store.append({ type: 'backend.event', workId, kind: event, artifact: this.store.putJSON(data) }, { type: 'work.updated', work });
      } };
      const result = kind === 'answer' ? await this.backend.answer!(request, answer!) : await this.backend.reconcile!(request);
      const seconds = previousSeconds + (Date.now() - began) / 1000;
      if (result.observedTokens !== undefined) actualUsage(work, result.observedTokens, 0);
      const observed = Math.max(work.actual?.tokens ?? 0, work.observedTokens ?? 0, result.observedTokens ?? 0);
      const actual = actualUsage(work, result.tokens === null ? observed : Math.max(observed, result.tokens), seconds);
      const validUsage = result.tokens !== null && result.tokens >= observed;
      work = { ...work, actual, observedTokens: Math.max(work.observedTokens ?? 0, actual.tokens ?? 0), receipt: this.store.putJSON(result.receipt) };
      const settled = result.stopped && result.outcome !== 'unknown';
      stopped = settled;
      work = { ...work, actual: { ...actual, tokens: validUsage ? actual.tokens : null }, usageSource: validUsage ? 'host_reported' : 'missing', ...(settled && validUsage ? { usageAfterAnswer: undefined } : {}) };
      let revision: Revision | undefined;
      if (settled && result.outcome === 'completed' && !this.store.state.revisions.some(r => r.attemptId === workId)) {
        const retry = this.store.getJSON<{ retry?: boolean }>(work.intent).retry;
        const output = candidateOutput(work.workspace, result, state.config.task.type === 'idea', state.config.backend.kind === 'muse');
        revision = { id: work.outputRevisionId ?? id(), candidateId: work.candidateId!, parentIds: [base.id], ...(retry ? { previousId: base.id } : {}), snapshot: capture(this.store, work.workspace), ...output, depth: base.depth + 1, attemptId: workId, createdAt: work.preparedAt ?? work.startedAt! };
      }
      work = { ...work, ...(settled || result.answerSettled ? { pendingAnswer: undefined } : {}), ...(settled && validUsage ? { usageAfterAnswer: undefined } : {}), state: settled ? 'settled' : 'unknown', outcome: settled ? result.outcome : 'unknown', actual: { ...actual, tokens: validUsage ? actual.tokens : null }, usageSource: validUsage ? 'host_reported' : 'missing', receipt: this.store.putJSON(result.receipt), operation: { ...work.operation!, state: settled || result.answerSettled ? 'completed' : 'unknown' }, ...(settled && result.outcome !== 'completed' ? { evaluationReservations: {} } : {}) };
      this.complete({ work, revision, clearInput: settled });
      const unresolved = Object.values(this.store.state.works).some(w => w.state === 'unknown' || w.actual?.tokens === null);
      this.store.append({ type: 'run.status', status: unresolved || this.store.state.backendInput ? 'needs_attention' : 'paused', message: settled ? 'Backend result reconciled; resume to continue' : 'Backend work remains uncertain; no command was replayed' });
    } catch (error) {
      if (stopped) {
        work = { ...work, state: 'settled', outcome: 'failed', evaluationReservations: {}, pendingAnswer: undefined, operation: { ...work.operation!, state: 'completed' }, receipt: this.store.putJSON({ backendReceipt: work.receipt, outputError: String(error) }) };
        this.complete({ work, clearInput: true });
        this.store.append({ type: 'run.status', status: 'needs_attention', message: `Reconciled output could not be saved: ${String(error)}` });
        return;
      }
      work = { ...work, state: 'unknown', outcome: 'unknown', operation: { ...work.operation!, state: 'unknown' }, actual: actualUsage(work, work.actual?.tokens ?? null, previousSeconds + (Date.now() - began) / 1000), receipt: this.store.putJSON({ error: String(error) }) };
      this.store.append({ type: 'work.updated', work }, { type: 'run.status', status: 'needs_attention', message: String(error) });
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort); }
  }

  recover(): void {
    this.store.repairTail();
    for (const work of Object.values(this.store.state.works)) {
      if (work.state !== 'running' && work.state !== 'unknown' && work.state !== 'reserved') continue;
      const path = join(this.store.dir, 'operations', work.operation?.id ?? work.id, 'result.json');
      if (existsSync(path)) {
        const receipt = JSON.parse(readFileSync(path, 'utf8')) as { digest: string };
        const result = this.store.getJSON<Completion>(receipt.digest);
        if (result.work.id !== work.id || result.work.intent !== work.intent || result.work.operation?.id !== work.operation?.id) throw Error('Completion receipt does not match original intent');
        this.importCompletion(result);
      } else if (work.state === 'reserved') this.store.append({ type: 'work.updated', work: { ...work, state: 'released', evaluationReservations: {} } });
      else this.store.append({ type: 'work.updated', work: { ...work, state: 'unknown', outcome: 'unknown', ...(work.operation ? { operation: { ...work.operation, state: 'unknown' } } : {}) } });
    }
    // A crash can land after an assessment receipt but before clearing the
    // pending prompt. Its imported evaluation is the answer, not a new request.
    const pending = this.store.state.pending;
    if (pending && this.store.state.evaluations.some(e => e.revisionId === pending.revisionId && e.evaluatorId === pending.evaluatorId)) this.store.append({ type: 'run.status', status: 'paused', pending: null, message: 'Recovered completed human assessment; resume to continue' });
  }
}
