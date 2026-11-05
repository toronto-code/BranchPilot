import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { configSchema, loadConfig } from './config.js';
import type { Config, Resources, State } from './types.js';
import { createRun, runController } from './controller.js';
import { budgetView, keys } from './budget.js';
import { feasible, resultsFor } from './evaluation.js';
import { executionEnvironment } from './environment.js';
import { freezeEvaluator } from './scheduler.js';
import { verifyMuseLock } from './muse.js';
import { verifyRun } from './project.js';
import { capture, rejectNestedStorage } from './workspaces.js';
import { atomicWrite, hash, id, RunStore } from './store.js';

export const comparisonSchema = z.object({
  schemaVersion: z.literal(1), armSeconds: z.number().int().min(1).max(86400).default(3600),
  taskSeconds: z.number().int().min(1).max(3600).default(240),
  taskTokens: z.number().int().min(3).max(10_000_000).default(24_000),
  searchAttempts: z.number().int().min(2).max(6).default(3),
  dataset: z.string().min(1), datasetRevision: z.string().min(1),
  cases: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), config: z.string().min(1) }).strict()).min(1).max(200),
}).strict().superRefine((s, ctx) => {
  if (new Set(s.cases.map(c => c.id)).size !== s.cases.length) ctx.addIssue({ code: 'custom', message: 'Comparison case IDs must be unique' });
  if (s.cases.length * s.taskSeconds > s.armSeconds) ctx.addIssue({ code: 'custom', message: 'Planned task limits exceed the per-version wall budget' });
  if (s.taskTokens < s.searchAttempts) ctx.addIssue({ code: 'custom', message: 'Token allowance cannot cover all search reservations' });
});
export type ComparisonSpec = z.infer<typeof comparisonSchema>;
export type ComparisonArm = 'default' | 'new';
interface SourceIdentity { input: string; evaluators: string[]; environment: string }
interface Plan { schemaVersion: 1; id: string; createdAt: string; implementation: string; spec: ComparisonSpec; cases: { id: string; config: Config; identity: SourceIdentity }[] }
interface TrialRecord { caseId: string; runDirectory?: string; seconds?: number; error?: string }
interface ArmRecord { startedAt: string; deadline: string; finishedAt?: string; seconds?: number; trials: TrialRecord[] }

function implementationDigest(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return hash(JSON.stringify(readdirSync(dir).filter(n => n.endsWith('.js')).sort().map(n => [n, hash(readFileSync(join(dir, n)))])));
}
function identity(config: Config, store: RunStore): SourceIdentity {
  return { input: config.task.inputs[0] ? capture(store, config.task.inputs[0].path) : store.putJSON({ files: [] }),
    evaluators: config.task.evaluators.map(e => freezeEvaluator(store, e, config.task.inputs[0]?.path).definitionDigest),
    environment: hash(JSON.stringify(executionEnvironment(config))) };
}
function writeJSON(file: string, value: unknown) { atomicWrite(file, JSON.stringify(value, null, 2)); }
function readPlan(directory: string): Plan {
  const value = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as { plan: Plan; digest: string };
  if (hash(JSON.stringify(value.plan)) !== value.digest) throw Error('Comparison plan integrity check failed');
  comparisonSchema.parse(value.plan.spec);
  return value.plan;
}
export function comparisonConfig(config: Config, spec: ComparisonSpec, arm: ComparisonArm): Config {
  const c = structuredClone(config); const attempts = arm === 'default' ? 1 : spec.searchAttempts;
  const development = c.task.evaluators.filter(e => e.split === 'development');
  const held = c.task.evaluators.filter(e => e.split === 'held_out');
  const heldSeconds = held.reduce((n, e) => n + e.timeoutSeconds, 0) * 2;
  const developmentSeconds = development.reduce((n, e) => n + e.timeoutSeconds, 0);
  const overhead = Math.max(1, Math.min(10, spec.taskSeconds * 0.05));
  const available = spec.taskSeconds - heldSeconds - developmentSeconds * (attempts + 1) - c.budget.cancellationGraceSeconds - overhead;
  if (available < attempts) throw Error(`Task ${c.task.key}: evaluation/setup limits leave insufficient time for ${attempts} attempt(s)`);
  c.agent.promptProfile = arm === 'default' ? 'basic' : 'evidence';
  c.strategy = { name: 'direct' };
  c.policy = { mode: arm === 'default' ? 'fixed' : 'auto', ruleset: 'hackathon-v1', allowedStrategies: ['direct', 'retry', 'best-of-n', 'tree'] };
  c.task.selection = { ...c.task.selection, maxFinalists: 1, earlyStop: 'first_feasible' };
  c.budget = { ...c.budget, maxConcurrency: 1, wallSeconds: spec.taskSeconds,
    total: { tokens: spec.taskTokens, workSeconds: spec.taskSeconds, attempts: spec.searchAttempts, experiments: development.length * (spec.searchAttempts + 1) + held.length * 2 },
    perAttempt: { tokenReservation: Math.floor(spec.taskTokens / attempts), timeoutSeconds: available / attempts },
    finalizationReserve: { tokens: 0, attempts: 0, workSeconds: heldSeconds, experiments: held.length * 2 }, tokenLimitPolicy: 'cancel-at-reservation',
  };
  return configSchema.parse(c);
}

/** Freeze task IDs, configuration, source fingerprints and the tested implementation. No host or evaluator is launched. */
export function prepareComparison(file: string, directory: string): void {
  directory = resolve(directory);
  const spec = comparisonSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const configs = spec.cases.map(entry => loadConfig(resolve(dirname(resolve(file)), entry.config)));
  if (new Set(configs.map(c => c.backend.kind)).size !== 1) throw Error('Do not mix fixture and Muse cases in one comparison');
  for (const c of configs) {
    if (c.task.type !== 'code' || c.task.objectives.length || c.task.selection.acceptance !== 'all_constraints' || c.task.evaluators.some(e => e.kind !== 'executable')) throw Error('Comparison currently supports executable code-correctness tasks only');
    if (c.backend.kind === 'muse' && (c.agent.model.kind !== 'explicit' || c.agent.effort.kind !== 'explicit')) throw Error('Pin the exact same explicit provider/model and effort before preparing a Muse comparison');
    for (const input of c.task.inputs) rejectNestedStorage(input.path, directory);
    for (const e of c.task.evaluators) rejectNestedStorage(dirname(e.definition.path), directory);
    comparisonConfig(c, spec, 'default'); comparisonConfig(c, spec, 'new');
  }
  mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory);
  const assets = new RunStore(join(directory, 'source-records'), true);
  try {
    const plan: Plan = { schemaVersion: 1, id: id(), createdAt: new Date().toISOString(), implementation: implementationDigest(), spec,
      cases: configs.map((config, i) => ({ id: spec.cases[i]!.id, config, identity: identity(config, assets) })) };
    const taskIdentities = plan.cases.map(c => hash(JSON.stringify([c.identity.input, c.identity.evaluators, c.config.task.goal, c.config.task.constraints])));
    if (new Set(taskIdentities).size !== taskIdentities.length) throw Error('Repeated task content cannot be counted as independent comparison cases');
    writeJSON(join(directory, 'plan.json'), { plan, digest: hash(JSON.stringify(plan)) });
  } finally { assets.close(); }
  writeComparisonReport(directory);
}

/** Each version is one non-replayable job, with its own wall deadline and serial tasks. */
export async function runComparisonArm(directory: string, arm: ComparisonArm, options: { signal?: AbortSignal; allowLive?: boolean; allowProviderCost?: boolean } = {}): Promise<void> {
  if (!['default', 'new'].includes(arm)) throw Error('Choose default or new');
  directory = resolve(directory); const plan = readPlan(directory);
  if (plan.implementation !== implementationDigest()) throw Error('Implementation changed after planning; create a fresh comparison');
  const live = plan.cases[0]!.config.backend.kind === 'muse';
  if (live && (!options.allowLive || !options.allowProviderCost)) throw Error('Muse comparison execution requires --allow-live and --allow-provider-cost');
  const lock = new RunStore(join(directory, 'job-lock'), true);
  const armDirectory = join(directory, arm); const file = join(armDirectory, 'job.json');
  let timer: NodeJS.Timeout | undefined; let job: ArmRecord | undefined;
  const started = performance.now(); const startedAt = new Date().toISOString();
  try {
    if (existsSync(file)) throw Error('This comparison version was already started; never replay a partial or uncertain job');
    // Local validation of all sources and locks happens before paid work.
    const assets = new RunStore(join(directory, 'source-records'), true);
    try {
      for (const entry of plan.cases) {
        if (JSON.stringify(identity(entry.config, assets)) !== JSON.stringify(entry.identity)) throw Error(`Source or environment changed: ${entry.id}`);
        if (entry.config.backend.kind === 'muse') verifyMuseLock(entry.config.backend.binary, entry.config.backend.compatibilityLock);
      }
    } finally { assets.close(); }
    options.signal?.throwIfAborted();
    mkdirSync(armDirectory, { recursive: true });
    job = { startedAt, deadline: new Date(Date.parse(startedAt) + plan.spec.armSeconds * 1000).toISOString(), trials: [] };
    writeFileSync(file, JSON.stringify(job, null, 2), { flag: 'wx' });
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(Error('Per-version comparison wall budget reached')), Math.max(1, Date.parse(job.deadline) - Date.now()));
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    for (const entry of plan.cases) {
      if (signal.aborted || (Date.parse(job.deadline) - Date.now()) / 1000 < plan.spec.taskSeconds) break;
      const trial: TrialRecord = { caseId: entry.id }; job.trials.push(trial); writeJSON(file, job);
      const trialStart = performance.now(); let store: RunStore | undefined;
      try {
        store = createRun(comparisonConfig(entry.config, plan.spec, arm), join(armDirectory, 'runs'));
        trial.runDirectory = store.dir; writeJSON(file, job);
        const m = store.state.manifest;
        if (m.initialSnapshot !== entry.identity.input || JSON.stringify(m.evaluators.map(e => e.definitionDigest)) !== JSON.stringify(entry.identity.evaluators) || m.environment !== entry.identity.environment) throw Error('Task source changed between preflight and run creation');
        const state = await runController(store, { signal });
        if (state.status === 'needs_attention' || state.status === 'failed') trial.error = state.message ?? state.status;
        if (signal.aborted) trial.error = 'Comparison job interrupted; this is not a complete timed task result';
      } catch (error) { trial.error = String(error); }
      finally { store?.close(); trial.seconds = (performance.now() - trialStart) / 1000; writeJSON(file, job); }
      if (trial.error) break;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (job) { job.finishedAt = new Date().toISOString(); job.seconds = (performance.now() - started) / 1000; writeJSON(file, job); }
    lock.close();
    if (job) writeComparisonReport(directory);
  }
}

export function pairedOutcomeSummary(pairs: { baseline: boolean; candidate: boolean }[]) {
  const wins = pairs.filter(p => !p.baseline && p.candidate).length;
  const losses = pairs.filter(p => p.baseline && !p.candidate).length;
  const discordant = wins + losses;
  // Exact two-sided binomial/McNemar test on task pairs, not on individual checks.
  let probability = 2 ** -discordant; let tail = probability;
  for (let k = 1; k <= Math.min(wins, losses); k++) { probability *= (discordant - k + 1) / k; tail += probability; }
  return { tasks: pairs.length, baselineSolved: pairs.filter(p => p.baseline).length, candidateSolved: pairs.filter(p => p.candidate).length,
    wins, losses, ties: pairs.length - discordant, deltaPercentagePoints: pairs.length ? 100 * (wins - losses) / pairs.length : 0,
    exactTwoSidedP: Math.min(1, 2 * tail), denominator: 'all planned tasks; missing or ungraded entries are not successes' };
}

function inspectTrial(directory: string, plan: Plan, arm: ComparisonArm, entry: Plan['cases'][number], record?: TrialRecord) {
  const reasons: string[] = []; let state: State | undefined; let spent: Resources | undefined;
  let solved = false; let modelIdentity: string | undefined; let backendIdentity: string | undefined;
  const seconds = record?.seconds;
  try {
    if (!record?.runDirectory || seconds === undefined) throw Error('Task not completed');
    const expectedParent = join(resolve(directory), arm, 'runs');
    if (dirname(resolve(record.runDirectory)) !== expectedParent) throw Error('Run is outside its comparison version');
    const store = new RunStore(record.runDirectory); verifyRun(store); state = store.state;
    if (record.error) reasons.push(record.error);
    if (JSON.stringify(state.config) !== JSON.stringify(comparisonConfig(entry.config, plan.spec, arm))) reasons.push('Run configuration differs from the planned control');
    const m = state.manifest;
    if (m.initialSnapshot !== entry.identity.input || m.environment !== entry.identity.environment || JSON.stringify(m.evaluators.map(e => e.definitionDigest)) !== JSON.stringify(entry.identity.evaluators)) reasons.push('Input/evaluator/environment mismatch');
    if (state.decisions.some(d => d.reason === 'Manual switch at a settled checkpoint')) reasons.push('Manual strategy intervention');
    const budget = budgetView(state, true); spent = budget.spent;
    if (keys.some(k => budget.unknown[k] > 0 || budget.reserved[k] > 0)) reasons.push('Unresolved work or accounting');
    if (!['completed', 'cancelled'].includes(state.status)) reasons.push(`Unsettled run status: ${state.status}`);
    if (state.evaluations.some(e => e.failureType === 'infrastructure')) reasons.push('Evaluation infrastructure failed');
    if (keys.some(k => spent![k] > state!.config.budget.total[k]) || seconds > plan.spec.taskSeconds + state.config.budget.cancellationGraceSeconds) reasons.push('Declared resource or task-time allowance exceeded');
    solved = state.status === 'completed' && Boolean(state.finalists?.length) && state.finalists!.every(r => feasible(state!.config, [...resultsFor(state!, r), ...resultsFor(state!, r, 'held_out')], { final: true }));
    backendIdentity = hash(JSON.stringify(m.backend));
    const attempts = Object.values(state.works).filter(w => w.kind === 'attempt' && w.state !== 'released');
    if (state.config.backend.kind === 'muse') {
      const settings = attempts.map(w => w.agentSettings ? JSON.stringify([w.agentSettings.providerId, w.agentSettings.modelId, w.agentSettings.effort]) : undefined);
      if (!settings.length || settings.some(s => s === undefined) || new Set(settings).size !== 1) reasons.push('Missing or inconsistent confirmed model settings');
      else modelIdentity = settings[0];
      if (attempts.some(w => w.usageSource !== 'host_reported')) reasons.push('Usage is not entirely host-reported');
    } else modelIdentity = 'fixture';
  } catch (error) { reasons.push(String(error)); }
  return { caseId: entry.id, solved, reasons, seconds, spent, modelIdentity, backendIdentity };
}

export function writeComparisonReport(directory: string) {
  const plan = readPlan(directory);
  const jobs = Object.fromEntries((['default', 'new'] as const).map(arm => { const file = join(directory, arm, 'job.json'); return [arm, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as ArmRecord : undefined]; })) as Partial<Record<ComparisonArm, ArmRecord>>;
  const pairs = plan.cases.map(entry => {
    const baseline = inspectTrial(directory, plan, 'default', entry, jobs.default?.trials.find(t => t.caseId === entry.id));
    const candidate = inspectTrial(directory, plan, 'new', entry, jobs.new?.trials.find(t => t.caseId === entry.id));
    const mismatches = baseline.modelIdentity !== candidate.modelIdentity || baseline.backendIdentity !== candidate.backendIdentity ? ['Backend or confirmed model differs between versions'] : [];
    return { caseId: entry.id, baseline, candidate, reasons: [...baseline.reasons, ...candidate.reasons, ...mismatches] };
  });
  const reasons = pairs.flatMap(p => p.reasons.map(reason => `${p.caseId}: ${reason}`));
  for (const arm of ['default', 'new'] as const) {
    const job = jobs[arm];
    if (!job?.finishedAt) reasons.push(`${arm}: version job has not finished`);
    if (job?.seconds !== undefined && job.seconds > plan.spec.armSeconds) reasons.push(`${arm}: per-version time allowance exceeded`);
    if (job && (new Set(job.trials.map(t => t.caseId)).size !== job.trials.length || job.trials.some(t => !plan.cases.some(c => c.id === t.caseId)))) reasons.push(`${arm}: unexpected or repeated task records`);
  }
  const outcomes = pairedOutcomeSummary(pairs.map(p => ({ baseline: p.baseline.solved, candidate: p.candidate.solved })));
  const simulated = plan.cases[0]!.config.backend.kind === 'fixture';
  const heldOut = plan.cases.every(c => c.config.task.evaluators.some(e => e.split === 'held_out'));
  const qualityReasons = [...reasons, ...(simulated ? ['Fixture results cannot establish model quality'] : []), ...(!heldOut ? ['A held-out evaluator is required for every task'] : [])];
  const improved = qualityReasons.length === 0 && outcomes.wins > outcomes.losses && outcomes.exactTwoSidedP <= 0.05;
  const totals = Object.fromEntries((['baseline', 'candidate'] as const).map(side => {
    const rows = pairs.map(p => p[side]);
    return [side, { tokens: rows.every(r => r.spent && !r.reasons.length) ? rows.reduce((n, r) => n + r.spent!.tokens, 0) : null,
      workSeconds: rows.every(r => r.spent) ? rows.reduce((n, r) => n + r.spent!.workSeconds, 0) : null,
      seconds: jobs[side === 'baseline' ? 'default' : 'new']?.seconds ?? null }];
  }));
  const summary = { schemaVersion: 1, planId: plan.id, dataset: plan.spec.dataset, datasetRevision: plan.spec.datasetRevision, simulated,
    armSeconds: plan.spec.armSeconds, taskSeconds: plan.spec.taskSeconds, implementation: plan.implementation,
    outcomes, totals, comparable: reasons.length === 0, modelQualityImproved: improved,
    verdict: improved ? 'evidence_of_improvement_on_this_frozen_subset' : 'improvement_not_established',
    qualityReasons, pairs, note: 'A small selected subset is a pilot, not a full benchmark score. Repeat on a fresh frozen subset; do not tune on final tests. Statistical evidence does not establish universal superiority.' };
  writeJSON(join(directory, 'summary.json'), summary);
  atomicWrite(join(directory, 'summary.md'), ['# Paired benchmark comparison', '', `Dataset: ${plan.spec.dataset} @ ${plan.spec.datasetRevision}`, '',
    `Mode: ${simulated ? 'OFFLINE FIXTURES — not model quality' : 'Muse runs'}. Budget: ${plan.spec.armSeconds}s per version, ${plan.spec.taskSeconds}s per task.`, '',
    `Verdict: **${summary.verdict}**`, '', `Default solved ${outcomes.baselineSolved}/${outcomes.tasks}; new solved ${outcomes.candidateSolved}/${outcomes.tasks}. Wins ${outcomes.wins}, losses ${outcomes.losses}, ties ${outcomes.ties}. Paired two-sided p=${outcomes.exactTwoSidedP.toFixed(4)}.`, '',
    '| Task | Default solved | New solved | Comparison valid |', '|---|---|---|---|',
    ...pairs.map(p => `| ${p.caseId} | ${p.baseline.solved} | ${p.candidate.solved} | ${p.reasons.length ? 'no' : 'yes'} |`), '',
    ...qualityReasons.map(reason => `- ${reason.replaceAll('\n', ' ')}`), '', summary.note, ''].join('\n'));
  return summary;
}
