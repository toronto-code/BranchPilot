import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Backend } from './backend.js';
import { BudgetError, budgetView, keys } from './budget.js';
import type { Config, Phase, Revision, State, Strategy, Work } from './types.js';
import { configSchema } from './config.js';
import { feasible, finalists, resultsFor } from './evaluation.js';
import { verifyMuseLock } from './muse.js';
import { freezeEvaluator, InteractionRequired, Scheduler } from './scheduler.js';
import { autoSwitch, nextPlan } from './search.js';
import { id, RunStore } from './store.js';
import { capture, materialize, rejectEvaluatorInsideInput, rejectNestedStorage } from './workspaces.js';
import { writeReport } from './report.js';
import { executionEnvironment } from './environment.js';
import { checkEvaluationHistory } from './evaluation-history.js';

export function createRun(configInput: Config, parent: string): RunStore {
  const config = configSchema.parse(configInput); const runId = id(); const dir = join(parent, runId);
  const input = config.task.inputs[0]?.path;
  const evaluationHistory = { directory: resolve(config.evaluationHistory?.directory ?? join(parent, '.evaluation-history')), reuse: config.evaluationHistory?.reuse ?? 'record' as const };
  if (input) {
    rejectNestedStorage(input, dir);
    rejectNestedStorage(input, evaluationHistory.directory);
    for (const evaluator of config.task.evaluators) {
      rejectEvaluatorInsideInput(input, evaluator.definition.path);
    }
  }
  const backend = config.backend.kind === 'muse'
    ? { kind: 'muse', ...verifyMuseLock(config.backend.binary, config.backend.compatibilityLock) }
    : { kind: 'fixture', simulated: true };
  const store = new RunStore(dir, true);
  try {
    const bootstrap = join(dir, 'workspaces', 'baseline'); mkdirSync(bootstrap, { recursive: true });
    if (input) materialize(store, capture(store, input), bootstrap);
    if (config.task.type === 'idea') writeFileSync(join(bootstrap, 'proposal.md'), config.task.proposal ?? config.task.baseline.description);
    const initialSnapshot = capture(store, bootstrap);
    const evaluators = config.task.evaluators.map(e => freezeEvaluator(store, e, input));
    checkEvaluationHistory(evaluationHistory, evaluators, runId);
    const startedAt = new Date().toISOString();
    const state: State = {
      id: runId, config, manifest: { configDigest: store.putJSON(config), initialSnapshot, evaluators, environment: store.putJSON(executionEnvironment(config)), backend, evaluationHistory },
      startedAt, deadline: new Date(Date.parse(startedAt) + config.budget.wallSeconds * 1000).toISOString(), status: 'preparing', phase: 'baseline', strategy: config.strategy, epoch: 0,
      revisions: [], works: {}, evaluations: [], decisions: [], epochStartAttempts: 0,
    };
    store.append({ type: 'run.created', state });
    return store;
  } catch (error) { store.close(); throw error; }
}

function recordDecision(store: RunStore, action: string, reason: string, revisionId?: string): void {
  store.append({ type: 'decision.recorded', decision: { id: id(), epoch: store.state.epoch, action, reason, revisionId, evidenceIds: store.state.evaluations.filter(e => e.split === 'development').map(e => e.id) } });
}

export function switchStrategy(store: RunStore, strategy: Strategy, mode: 'fixed' | 'auto' = 'fixed', reason = 'Manual switch at a settled checkpoint'): void {
  const state = store.state;
  if (['completed', 'cancelled', 'failed'].includes(state.status) || state.finalists) throw Error('Cannot switch after final selection or termination');
  if (Object.values(state.works).some(w => ['reserved', 'running', 'unknown'].includes(w.state)) || keys.some(k => budgetView(state).unknown[k] > 0)) throw Error('Settle all active/unknown work and usage before switching');
  if (!state.config.policy.allowedStrategies.includes(strategy.name)) throw Error('Strategy is not allowed by this run');
  recordDecision(store, `switch:${strategy.name}`, reason);
  store.append({ type: 'strategy.changed', strategy, reason, policyMode: mode });
}

export async function runController(store: RunStore, options: { signal?: AbortSignal; pauseAfter?: number; backend?: Backend; onProgress?: (message: string) => void } = {}): Promise<State> {
  const signal = options.signal ?? new AbortController().signal;
  const scheduler = new Scheduler(store, signal, options.backend);
  const say = options.onProgress ?? (() => undefined);
  let attemptsThisInvocation = 0;
  const evaluate = async (revision: Revision, phase: Phase): Promise<void> => {
    const split = phase === 'held_out' ? 'held_out' : 'development';
    const ordered: typeof store.state.manifest.evaluators = [];
    const visit = (e: typeof ordered[number]) => { if (ordered.includes(e)) return; for (const dependency of e.spec.dependsOn) visit(store.state.manifest.evaluators.find(x => x.spec.id === dependency)!); ordered.push(e); };
    for (const evaluator of store.state.manifest.evaluators.filter(e => e.spec.split === split)) visit(evaluator);
    for (const evaluator of ordered) {
      say(`Evaluate ${revision.id.slice(0, 8)}: ${evaluator.spec.id}`);
      const result = await scheduler.evaluate(revision, evaluator, phase);
      if (store.state.status === 'needs_attention') throw new InteractionRequired(store.state.message);
      signal.throwIfAborted();
      if (result?.failureType === 'infrastructure') {
        store.append({ type: 'run.status', status: 'needs_attention', message: `Evaluator ${evaluator.spec.id} failed: ${result.feedback}` });
        throw new InteractionRequired(result.feedback);
      }
    }
    scheduler.releaseEvaluations(revision);
  };
  try {
    scheduler.recover();
    if (['completed', 'cancelled', 'failed'].includes(store.state.status)) return store.state;
    if (store.state.backendInput) { store.append({ type: 'run.status', status: 'needs_attention', message: 'Muse requested user input. Use answer for its work ID, or reconcile uncertain host state; live operations require separate compatibility evidence.' }); return store.state; }
    const budget = budgetView(store.state);
    if (Object.values(store.state.works).some(w => w.state === 'unknown') || keys.some(k => budget.unknown[k] > 0)) {
      store.append({ type: 'run.status', status: 'needs_attention', message: 'Unknown work or missing usage requires explicit resolution; no automatic resubmission' }); return store.state;
    }
    if (store.state.pending) throw new InteractionRequired('Pending human assessment');
    if (!store.state.baselineId) {
      const revision: Revision = { id: id(), candidateId: id(), parentIds: [], snapshot: store.state.manifest.initialSnapshot, proposal: store.state.config.task.proposal ?? store.state.config.task.baseline.description, hypotheses: [], depth: 0, createdAt: new Date().toISOString() };
      store.append({ type: 'revision.created', revision, baseline: true });
    }
    const baseline = store.state.revisions.find(r => r.id === store.state.baselineId)!;
    if (!store.state.finalists) {
      store.append({ type: 'run.status', status: 'active', phase: 'baseline', pending: null });
      await evaluate(baseline, 'baseline');
      if (store.state.config.task.type === 'optimization' && !feasible(store.state.config, resultsFor(store.state, baseline.id), { baseline: true })) {
        store.append({ type: 'run.status', status: 'failed', outcome: 'inconclusive', message: 'Optimization baseline is not valid; scores cannot be compared' }); return store.state;
      }
      store.append({ type: 'run.status', status: 'active', phase: 'search' });
      // Reconcile a crash between successful development and its evaluation.
      for (const revision of store.state.revisions.filter(r => r.attemptId)) await evaluate(revision, 'search');
      while (!signal.aborted) {
        if (options.pauseAfter !== undefined && attemptsThisInvocation >= options.pauseAfter) {
          store.append({ type: 'run.status', status: 'paused', message: 'Paused at the requested settled checkpoint' }); return store.state;
        }
        if (store.state.config.task.selection.earlyStop === 'first_feasible' && store.state.revisions.some(revision => feasible(store.state.config, resultsFor(store.state, revision.id)))) {
          recordDecision(store, 'finish', 'Development constraints satisfied; first_feasible stops further attempts at this settled checkpoint');
          break;
        }
        const automatic = autoSwitch(store.state);
        if (automatic) { switchStrategy(store, automatic.strategy, 'auto', automatic.reason); say(automatic.reason); }
        const wave: Work[] = [];
        const capacity = store.state.strategy.name === 'best-of-n' ? store.state.config.budget.maxConcurrency : 1;
        const limit = Math.min(capacity, options.pauseAfter === undefined ? capacity : options.pauseAfter - attemptsThisInvocation);
        try {
          for (let slot = 0; slot < limit; slot++) {
            const plan = nextPlan(store.state);
            if (!plan) break;
            try {
              const work = scheduler.prepare(plan);
              wave.push(work);
              recordDecision(store, 'develop', plan.reason, plan.baseId); say(plan.reason);
            } catch (error) {
              if (!(error instanceof BudgetError)) throw error;
              recordDecision(store, 'finish', error.message); break;
            }
          }
        } catch (error) { scheduler.releasePrepared(wave); throw error; }
        if (!wave.length) break;
        // Every attempt and its complete development-evaluation bundle has a
        // durable reservation before any member of the wave is dispatched.
        const completed = await Promise.allSettled(wave.map(work => scheduler.executePrepared(work)));
        attemptsThisInvocation += wave.length;
        const rejected = completed.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        if (store.state.backendInput) { store.append({ type: 'run.status', status: 'needs_attention', message: 'Muse requested user input; inspect the preserved request before continuing.' }); return store.state; }
        if (store.state.status === 'needs_attention') return store.state;
        if (!signal.aborted) {
          const revisions = completed.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
          // Human checkpoints have a single explicit owner; keep their order.
          if (store.state.config.task.evaluators.some(e => e.split === 'development' && e.kind === 'human_preference')) {
            for (const revision of revisions) await evaluate(revision, 'search');
          } else {
            const evaluated = await Promise.allSettled(revisions.map(revision => evaluate(revision, 'search')));
            const failure = evaluated.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          }
        }
      }
      if (signal.aborted) { store.append({ type: 'run.status', status: 'cancelled', outcome: 'cancelled', message: 'Cancelled after settling active work' }); return store.state; }
      store.append({ type: 'finalists.selected', revisionIds: finalists(store.state) });
      recordDecision(store, 'finalize', 'Finalists frozen from development evidence; held-out results cannot change selection');
    }
    store.append({ type: 'run.status', status: 'finalizing', phase: 'held_out' });
    for (const revisionId of [store.state.baselineId!, ...store.state.finalists!].filter((value, index, array) => array.indexOf(value) === index)) await evaluate(store.state.revisions.find(r => r.id === revisionId)!, 'held_out');
    const selected = store.state.finalists!.map(r => store.state.revisions.find(x => x.id === r)!);
    const held = store.state.config.task.evaluators.filter(e => e.split === 'held_out');
    const finalPass = selected.length > 0 && selected.every(r => feasible(store.state.config, [...resultsFor(store.state, r.id), ...resultsFor(store.state, r.id, 'held_out')], { final: true }) && held.every(spec => store.state.evaluations.some(e => e.revisionId === r.id && e.evaluatorId === spec.id && e.validity === 'pass')));
    const goalMet = finalPass && store.state.config.task.type === 'code' && store.state.config.task.selection.acceptance === 'all_constraints';
    store.append({ type: 'run.status', status: 'completed', phase: 'report', outcome: goalMet ? 'goal_met' : finalPass ? 'best_found' : 'inconclusive', message: store.state.config.task.selection.acceptance === 'human_review' ? 'Findings ready for human review' : 'Search and final assessment finished' });
  } catch (error) {
    if (error instanceof InteractionRequired) say(error.message);
    else if (signal.aborted && !Object.values(store.state.works).some(w => ['reserved', 'running', 'unknown'].includes(w.state)) && !keys.some(k => budgetView(store.state).unknown[k] > 0)) store.append({ type: 'run.status', status: 'cancelled', outcome: 'cancelled', message: 'Cancelled' });
    else if (error instanceof BudgetError) store.append({ type: 'run.status', status: 'completed', phase: 'report', outcome: 'inconclusive', message: `Assessment incomplete: ${error.message}` });
    else {
      const unresolved = Object.values(store.state.works).some(w => ['running', 'unknown'].includes(w.state));
      store.append({ type: 'run.status', status: unresolved ? 'needs_attention' : 'failed', outcome: 'infrastructure_failure', message: String(error) });
    }
  } finally {
    if (['completed', 'cancelled', 'failed'].includes(store.state.status)) {
      for (const work of Object.values(store.state.works)) if (work.state === 'settled' && Object.keys(work.evaluationReservations ?? {}).length) store.append({ type: 'work.updated', work: { ...work, evaluationReservations: {} } });
    }
    writeReport(store);
  }
  return store.state;
}
