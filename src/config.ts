import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MAX_TIMEOUT_MS } from './time.js';

const positive = z.number().finite().positive();
const count = z.number().int().safe().nonnegative();
const modelChoice = z.union([
  z.object({ providerId: z.string().min(1).optional(), modelId: z.string().min(1) }).strict(),
  z.object({ providerId: z.string().min(1).optional(), displayLabel: z.string().min(1) }).strict(),
]);
export const resourcesSchema = z.object({ tokens: count, workSeconds: z.number().finite().nonnegative(), attempts: count, experiments: count }).strict();
export const strategySchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('direct') }).strict(),
  z.object({ name: z.literal('retry'), maxAttemptsPerCandidate: count.min(1) }).strict(),
  z.object({ name: z.literal('best-of-n'), n: count.min(1) }).strict(),
  z.object({ name: z.literal('tree'), width: count.min(1), maxDepth: count.min(1), maxChildren: count.min(1) }).strict(),
]);
export const hypothesisSchema = z.object({ id: z.string().min(1).max(200), assumption: z.string().min(1).max(8000), expectedBenefit: z.string().min(1).max(8000), uncertainty: z.string().min(1).max(8000), prediction: z.string().min(1).max(8000), falsificationTest: z.string().min(1).max(8000) }).strict();
export const hypothesesSchema = z.array(hypothesisSchema).max(64).superRefine((items, ctx) => {
  if (new Set(items.map(item => item.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: 'Hypothesis IDs must be unique' });
});
export const fixturePlanSchema = z.object({
  files: z.record(z.string().nullable()).default({}), proposal: z.string().optional(), hypotheses: hypothesesSchema.default([]),
  tokens: count.nullable().default(100), delayMs: count.max(60_000).default(0),
  outcome: z.enum(['completed', 'failed']).default('completed'),
}).strict();
export const configSchema = z.object({
  schemaVersion: z.literal(1),
  task: z.object({
    key: z.string().min(1), type: z.enum(['code', 'optimization', 'idea']), goal: z.string().min(1),
    inputs: z.array(z.object({ path: z.string().min(1) }).strict()).max(1).default([]),
    proposal: z.string().optional(),
    constraints: z.array(z.discriminatedUnion('kind', [
      z.object({ id: z.string(), kind: z.literal('check'), evaluatorId: z.string(), check: z.string() }).strict(),
      z.object({ id: z.string(), kind: z.literal('metric'), metric: z.string(), op: z.enum(['lte', 'gte']), value: z.number().finite(), unit: z.string() }).strict(),
      z.object({ id: z.string(), kind: z.literal('human'), instruction: z.string() }).strict(),
    ])).default([]),
    objectives: z.array(z.object({ metric: z.string(), direction: z.enum(['minimize', 'maximize']), unit: z.string(), minMeaningfulChange: z.number().finite().nonnegative(), evidenceKind: z.enum(['executable', 'model_judgment', 'human_preference']) }).strict()).default([]),
    evaluators: z.array(z.object({
      id: z.string().min(1), kind: z.enum(['executable', 'human_preference']), split: z.enum(['development', 'held_out']).default('development'),
      role: z.enum(['correctness', 'objective', 'rubric']), definition: z.object({ path: z.string() }).strict(),
      dependsOn: z.array(z.string()).default([]), repetitions: count.min(1).max(100).default(1), warmups: count.max(100).default(0),
      timeoutSeconds: positive.max(86400), resourceGroup: z.string().min(1).optional(), datasetId: z.string().min(1).max(500).optional(),
      reuseIdentical: z.boolean().optional(),
    }).strict()).min(1),
    baseline: z.object({ mode: z.enum(['initial_artifacts', 'status_quo_proposal']), description: z.string() }).strict(),
    selection: z.object({ mode: z.enum(['pareto', 'feasible_first']).default('feasible_first'), maxFinalists: count.min(1).default(1), acceptance: z.enum(['all_constraints', 'human_review']).default('all_constraints'), earlyStop: z.enum(['never', 'first_feasible']).default('never') }).strict(),
  }).strict(),
  backend: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fixture'), plans: z.array(fixturePlanSchema).min(1) }).strict(),
    z.object({ kind: z.literal('muse'), binary: z.string(), compatibilityLock: z.string(), apiKeyEnv: z.literal('META_API_KEY').optional() }).strict(),
  ]),
  agent: z.object({
    promptProfile: z.enum(['basic', 'evidence']).optional(),
    model: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('host-default') }).strict(),
      z.object({ kind: z.literal('explicit'), providerId: z.string().min(1), modelId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('preference'), choices: z.array(modelChoice).min(1).max(16) }).strict(),
    ]),
    effort: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('host-default') }).strict(),
      z.object({ kind: z.literal('explicit'), value: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('highest'), minimum: z.enum(['high', 'xhigh', 'max']).default('high') }).strict(),
    ]),
  }).strict().default({ model: { kind: 'host-default' }, effort: { kind: 'host-default' } }),
  strategy: strategySchema.default({ name: 'direct' }),
  policy: z.object({ mode: z.enum(['fixed', 'auto']), ruleset: z.literal('hackathon-v1').default('hackathon-v1'), allowedStrategies: z.array(z.enum(['direct', 'retry', 'best-of-n', 'tree'])).min(1) }).strict().default({ mode: 'fixed', ruleset: 'hackathon-v1', allowedStrategies: ['direct', 'retry', 'best-of-n', 'tree'] }),
  budget: z.object({
    total: resourcesSchema, wallSeconds: positive.refine(seconds => Number.isFinite(new Date(Date.now() + seconds * 1000).getTime()), 'Wall deadline exceeds the supported date range'), maxConcurrency: count.min(1).max(16).default(1),
    perAttempt: z.object({ tokenReservation: count.min(1), timeoutSeconds: positive.max(MAX_TIMEOUT_MS / 1000) }).strict(),
    finalizationReserve: resourcesSchema.default({ tokens: 0, workSeconds: 0, attempts: 0, experiments: 0 }),
    cancellationGraceSeconds: positive.max(60).default(2), missingUsage: z.literal('hold-reservation-and-pause').default('hold-reservation-and-pause'),
    tokenLimitPolicy: z.enum(['cancel-at-reservation', 'observe']).default('cancel-at-reservation'),
  }).strict(),
  evaluationHistory: z.object({ directory: z.string().min(1).optional(), reuse: z.enum(['record', 'reject']).default('record') }).strict().optional(),
  execution: z.object({
    isolationProfile: z.enum(['trusted-fixture', 'sandbox-exec']),
    approvals: z.literal('deny-unless-allowlisted').default('deny-unless-allowlisted'),
    userInput: z.literal('pause').default('pause'), nativeFork: z.literal('disabled').default('disabled'),
  }).strict(),
}).strict().superRefine((c, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = new Set(c.task.evaluators.map(e => e.id));
  if (ids.size !== c.task.evaluators.length) problem('Evaluator IDs must be unique');
  for (const evaluator of c.task.evaluators) if (evaluator.reuseIdentical && (evaluator.kind !== 'executable' || evaluator.role !== 'correctness' || evaluator.split !== 'development')) problem('Identical-result reuse is only supported for deterministic executable development correctness checks');
  if (new Set(c.task.constraints.map(constraint => constraint.id)).size !== c.task.constraints.length) problem('Constraint IDs must be unique');
  if (new Set(c.task.objectives.map(objective => JSON.stringify([objective.metric, objective.unit]))).size !== c.task.objectives.length) problem('Objectives must have unique metric/unit pairs');
  for (const e of c.task.evaluators) for (const dep of e.dependsOn) {
    const required = c.task.evaluators.find(x => x.id === dep);
    if (!required || required.split !== e.split) problem(`Evaluator ${e.id}: missing dependency or dependency across data splits: ${dep}`);
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) { problem(`Cyclic evaluator dependency: ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of c.task.evaluators.find(e => e.id === id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
  for (const constraint of c.task.constraints) if (constraint.kind === 'check' && !ids.has(constraint.evaluatorId)) problem(`Unknown constraint evaluator ${constraint.evaluatorId}`);
  for (const objective of c.task.objectives) if (!c.task.evaluators.some(e => e.split === 'development' && e.kind === objective.evidenceKind)) problem(`No supported development evaluator for objective evidence kind ${objective.evidenceKind}`);
  if (!c.task.evaluators.some(e => e.split === 'development')) problem('A development evaluator is required');
  if (c.backend.kind === 'muse' && c.execution.isolationProfile !== 'sandbox-exec') problem('Muse requires the sandbox-exec isolation profile');
  if (c.policy.mode === 'auto' && c.strategy.name !== 'direct') problem('Auto policy must start with direct');
  if (c.task.selection.earlyStop === 'first_feasible' && (c.task.type !== 'code' || c.task.objectives.length || c.task.selection.acceptance !== 'all_constraints')) problem('first_feasible early stopping requires a code task with no optimization objectives and all_constraints acceptance');
  if (!c.policy.allowedStrategies.includes(c.strategy.name)) problem('Initial strategy is not in allowedStrategies');
  for (const key of Object.keys(c.budget.total) as (keyof Resources)[]) if (c.budget.finalizationReserve[key] > c.budget.total[key]) problem(`Finalization reserve exceeds total ${key}`);
  const held = c.task.evaluators.filter(e => e.split === 'held_out');
  const copies = c.task.selection.maxFinalists + 1;
  if (c.budget.finalizationReserve.experiments < held.length * copies || c.budget.finalizationReserve.workSeconds < held.reduce((n, e) => n + e.timeoutSeconds, 0) * copies) problem('Finalization reserve must cover baseline plus all finalists');
});

export type Config = z.infer<typeof configSchema>;
export type Resources = z.infer<typeof resourcesSchema>;
export type Strategy = z.infer<typeof strategySchema>;
export type EvaluatorSpec = Config['task']['evaluators'][number];
export type FixturePlan = z.infer<typeof fixturePlanSchema>;

export function loadConfig(file: string): Config {
  const config = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const base = dirname(resolve(file));
  if (config.evaluationHistory?.directory) config.evaluationHistory.directory = resolve(base, config.evaluationHistory.directory);
  for (const input of config.task.inputs) input.path = resolve(base, input.path);
  for (const evaluator of config.task.evaluators) evaluator.definition.path = resolve(base, evaluator.definition.path);
  if (config.backend.kind === 'muse') {
    config.backend.compatibilityLock = resolve(base, config.backend.compatibilityLock);
    config.backend.binary = resolve(base, config.backend.binary);
  }
  return config;
}
