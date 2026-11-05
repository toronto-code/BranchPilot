import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig, strategySchema } from './config.js';
import { createRun, runController } from './controller.js';
import { budgetView } from './budget.js';
import { dominates, resultsFor } from './evaluation.js';
import { atomicWrite, hash } from './store.js';
import type { Resources, State } from './types.js';
import { rejectNestedStorage } from './workspaces.js';
import { midpoint } from './statistics.js';

export const benchmarkSchema = z.object({
  schemaVersion: z.literal(1), repetitions: z.number().int().min(1).max(10).default(3),
  cases: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), config: z.string().min(1), strategy: strategySchema.optional(), maxConcurrency: z.number().int().min(1).max(16).optional(), earlyStop: z.enum(['never', 'first_feasible']).optional() }).strict()).min(1).max(20),
}).strict().superRefine((suite, ctx) => {
  if (new Set(suite.cases.map(entry => entry.id)).size !== suite.cases.length) ctx.addIssue({ code: 'custom', message: 'Benchmark case IDs must be unique' });
});
interface Trial { caseId: string; repetition: number; runDirectory: string; status: State['status']; outcome?: string; seconds: number; spent: Resources; unknown: Resources; reserved: Resources; inputSnapshot: string; evaluators: string[]; environment: string; improvedFinalists: number }
function range(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return { median: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : midpoint(sorted[sorted.length / 2 - 1]!, sorted[sorted.length / 2]!), min: sorted[0]!, max: sorted.at(-1)! }; }

/** Offline fixture outcome/cost measurement. It cannot be used to attest model quality. */
export async function runBenchmark(file: string, directory: string, signal?: AbortSignal): Promise<Trial[]> {
  const suite = benchmarkSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const configs = suite.cases.map(entry => {
    const config = loadConfig(resolve(dirname(resolve(file)), entry.config));
    if (config.backend.kind !== 'fixture') throw Error('The offline benchmark accepts fixture backends only; it never launches Muse');
    if (config.task.evaluators.some(evaluator => evaluator.kind !== 'executable')) throw Error('Benchmark cases require executable evaluators without human checkpoints');
    if (entry.strategy) config.strategy = entry.strategy;
    if (entry.earlyStop) config.task.selection.earlyStop = entry.earlyStop;
    if (entry.maxConcurrency) config.budget.maxConcurrency = entry.maxConcurrency;
    return configSchema.parse(config);
  });
  for (const config of configs) for (const input of config.task.inputs) rejectNestedStorage(input.path, directory);
  mkdirSync(dirname(resolve(directory)), { recursive: true }); mkdirSync(directory);
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const implementationDigest = hash(JSON.stringify(readdirSync(sourceDirectory).filter(name => name.endsWith('.js')).sort().map(name => [name, hash(readFileSync(join(sourceDirectory, name)))])));
  atomicWrite(join(directory, 'suite.json'), JSON.stringify({ suite, configs, implementationDigest, digest: hash(JSON.stringify({ suite, configs, implementationDigest })) }, null, 2));
  const trials: Trial[] = [];
  const save = () => {
    const cases = suite.cases.map(entry => {
      const samples = trials.filter(trial => trial.caseId === entry.id);
      return { id: entry.id, completed: samples.length, ...(samples.length ? { outcomes: samples.map(trial => trial.outcome ?? trial.status), tokens: samples.some(trial => trial.unknown.tokens || trial.reserved.tokens) ? null : range(samples.map(trial => trial.spent.tokens)), heldTokens: range(samples.map(trial => trial.unknown.tokens + trial.reserved.tokens)), attempts: range(samples.map(trial => trial.spent.attempts)), experiments: range(samples.map(trial => trial.spent.experiments)), elapsedSeconds: range(samples.map(trial => trial.seconds)), comparableWithinCase: new Set(samples.map(trial => JSON.stringify([trial.inputSnapshot, trial.evaluators, trial.environment]))).size === 1 } : {}) };
    });
    atomicWrite(join(directory, 'summary.json'), JSON.stringify({ schemaVersion: 1, implementationDigest, simulatedBackend: true, cases, trials }, null, 2));
    atomicWrite(join(directory, 'summary.md'), ['# Offline result measurements', '', 'Candidate edits and token counts are deterministic fixtures. Evaluator results and elapsed times are measured. These results do not estimate model quality or real provider cost.', '', '| Case | Outcomes | Median tokens | Max held tokens | Median attempts | Median experiments | Median elapsed seconds |', '|---|---|---:|---:|---:|---:|---:|', ...cases.map(entry => `| ${entry.id} | ${entry.outcomes?.join(', ') ?? 'pending'} | ${entry.tokens?.median ?? (entry.completed ? 'unresolved' : '')} | ${entry.heldTokens?.max ?? ''} | ${entry.attempts?.median ?? ''} | ${entry.experiments?.median ?? ''} | ${entry.elapsedSeconds?.median.toFixed(3) ?? ''} |`), '', 'Missing token usage remains unresolved with its liability shown; it is never averaged as zero. See summary.json and each immutable run for exact inputs, evaluator/environment identities, objective improvements, accounting, and timing ranges. No confidence intervals or live-model claims are inferred.', ''].join('\n'));
  };
  save();
  try {
    // Interleave cases by repetition to reduce systematic ordering effects.
    for (let repetition = 0; repetition < suite.repetitions; repetition++) for (let index = 0; index < suite.cases.length; index++) {
      signal?.throwIfAborted();
      const store = createRun(configs[index]!, join(directory, 'runs'));
      try {
        const started = performance.now(); const state = await runController(store, { signal }); const budget = budgetView(state, true);
        trials.push({ caseId: suite.cases[index]!.id, repetition, runDirectory: store.dir, status: state.status, outcome: state.outcome, seconds: (performance.now() - started) / 1000, spent: budget.spent, unknown: budget.unknown, reserved: budget.reserved, inputSnapshot: state.manifest.initialSnapshot, evaluators: state.manifest.evaluators.map(evaluator => evaluator.definitionDigest), environment: state.manifest.environment, improvedFinalists: (state.finalists ?? []).filter(finalist => dominates(state.config, resultsFor(state, finalist), resultsFor(state, state.baselineId!))).length });
      } finally { store.close(); }
      save();
    }
  } finally { save(); }
  return trials;
}
