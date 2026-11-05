#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import type { Backend } from './backend.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig, strategySchema } from './config.js';
import { createRun, runController, switchStrategy } from './controller.js';
import { budgetView } from './budget.js';
import { RunStore } from './store.js';
import { renderReport, writeReport } from './report.js';
import { outputSchema } from './evaluation.js';
import { Scheduler } from './scheduler.js';
import { materialize } from './workspaces.js';
import { verifyMuseLock } from './muse.js';
import { prepareSmoke, runSmokeCase, smokeCases, writeSmokeReport } from './muse-smoke.js';
import type { SmokeCase } from './muse-smoke.js';
import { runBenchmark } from './benchmark.js';
import { id } from './store.js';
import { initializeProject, listRuns, templates, verifyRun } from './project.js';
import type { Template } from './project.js';
import { prepareComparison, runComparisonArm, writeComparisonReport } from './comparison.js';
import type { ComparisonArm } from './comparison.js';

const help = `BranchPilot — local budgeted search

  init <new-directory> [--template code|optimization|idea]  Offline starter project
  runs <runs-directory> [--limit <1..1000>]
  verify <run-directory>  Read-only event and artifact integrity check
  run <config.json> [--out <runs-directory>] [--pause-after <attempts>]
  resume <run-directory> [--pause-after <attempts>]
  inspect <run-directory>
  report <run-directory>
  switch <run-directory> '<strategy JSON>'
  assess <run-directory> <result.json> --rater <name>
  answer <run-directory> <work-id> <answer.json>
  reconcile <run-directory> <work-id>
  resolve <run-directory> <work-id> --tokens <n> --seconds <n> --evidence <file> --stopped
  export <run-directory> <revision-id> <empty-directory>
  validate <config.json>
  doctor <config.json>     Check local files and compatibility lock; never launch Muse
  smoke-plan <spec.json> --out <new-directory>  Prepare evidence plan; never launch Muse
  smoke-run <plan-directory> <case> --allow-live --allow-provider-cost
  smoke-report <plan-directory>               Never launch Muse
  benchmark <suite.json> [--out <new-directory>]  Offline fixture results/costs
  compare-plan <suite.json> --out <new-directory>  Freeze a paired comparison; no execution
  compare-run <plan-directory> <default|new> [--allow-live --allow-provider-cost]
  compare-report <plan-directory>  Check fairness and report paired outcomes; no execution

Example: npm run demo
Strategy JSON: '{"name":"retry","maxAttemptsPerCandidate":3}'
`;

function positiveOption(args: string[], key: string): number | undefined {
  const i = args.indexOf(key); if (i < 0) return;
  const n = Number(args[i + 1]); if (!Number.isFinite(n) || n < 0) throw Error(`Invalid ${key}`); return n;
}
function option(args: string[], key: string): string | undefined {
  const i = args.indexOf(key); if (i < 0) return;
  const value = args[i + 1]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`); return value;
}
function validateArguments(command: string, args: string[]): string[] {
  const specs: Record<string, { positionals: number; values?: string[]; flags?: string[] }> = {
    init: { positionals: 0, values: ['--template'] }, runs: { positionals: 0, values: ['--limit'] }, verify: { positionals: 0 },
    run: { positionals: 0, values: ['--out', '--pause-after'] }, resume: { positionals: 0, values: ['--pause-after'] },
    inspect: { positionals: 0 }, report: { positionals: 0 }, switch: { positionals: 1 },
    assess: { positionals: 1, values: ['--rater'] }, answer: { positionals: 2 }, reconcile: { positionals: 1 },
    resolve: { positionals: 1, values: ['--tokens', '--seconds', '--evidence'], flags: ['--stopped'] },
    export: { positionals: 2 }, validate: { positionals: 0 }, doctor: { positionals: 0 },
    'smoke-plan': { positionals: 0, values: ['--out'] }, 'smoke-run': { positionals: 1, flags: ['--allow-live', '--allow-provider-cost'] }, 'smoke-report': { positionals: 0 }, benchmark: { positionals: 0, values: ['--out'] },
    'compare-plan': { positionals: 0, values: ['--out'] }, 'compare-run': { positionals: 1, flags: ['--allow-live', '--allow-provider-cost'] }, 'compare-report': { positionals: 0 },
  };
  const spec = specs[command]!; const positionals: string[] = []; const options: string[] = []; const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    if (seen.has(arg)) throw Error(`Repeated option: ${arg}`); seen.add(arg);
    if (spec.flags?.includes(arg)) options.push(arg);
    else if (spec.values?.includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${arg}`);
      options.push(arg, value);
    } else throw Error(`Unknown option for ${command}: ${arg}`);
  }
  if (positionals.length !== spec.positionals) throw Error(`${command} requires ${spec.positionals} additional positional argument(s)`);
  const normalized = [...positionals, ...options];
  const pause = positiveOption(normalized, '--pause-after');
  if (pause !== undefined && !Number.isSafeInteger(pause)) throw Error('--pause-after must be a safe integer');
  const limit = positiveOption(normalized, '--limit');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw Error('--limit must be between 1 and 1000');
  if (command === 'init' && !templates.includes((option(normalized, '--template') ?? 'code') as Template)) throw Error(`Choose a template: ${templates.join(', ')}`);
  if (command === 'resolve') {
    const tokens = positiveOption(normalized, '--tokens'); const seconds = positiveOption(normalized, '--seconds');
    if (tokens === undefined || !Number.isSafeInteger(tokens) || seconds === undefined || !option(normalized, '--evidence') || !seen.has('--stopped')) throw Error('Resolution requires measured --tokens, --seconds, --evidence, and explicit --stopped confirmation');
  }
  if (command === 'assess' && !option(normalized, '--rater')) throw Error('Provide --rater');
  if (command === 'smoke-plan' && !option(normalized, '--out')) throw Error('Provide --out with a new smoke-plan directory');
  if (command === 'compare-plan' && !option(normalized, '--out')) throw Error('Provide --out with a new comparison directory');
  if (command === 'compare-run' && !['default', 'new'].includes(positionals[0]!)) throw Error('Choose default or new');
  if (command === 'smoke-run' && (!seen.has('--allow-live') || !seen.has('--allow-provider-cost') || !smokeCases.includes(positionals[0] as SmokeCase))) throw Error(`Smoke execution requires a case (${smokeCases.join(', ')}), --allow-live and --allow-provider-cost`);
  return normalized;
}

export async function runCli(argv: string[], options: { backend?: Backend; signal?: AbortSignal } = {}): Promise<void> {
  const [command, target, ...rawArgs] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (!['init', 'runs', 'verify', 'run', 'resume', 'inspect', 'report', 'switch', 'assess', 'resolve', 'answer', 'reconcile', 'export', 'validate', 'doctor', 'smoke-plan', 'smoke-run', 'smoke-report', 'benchmark', 'compare-plan', 'compare-run', 'compare-report'].includes(command)) throw Error(`Unknown command: ${command}\n${help}`);
  if (!target) throw Error('Missing configuration or run-directory argument');
  const args = validateArguments(command, rawArgs);
  if (command === 'init') { initializeProject(resolve(target), (option(args, '--template') ?? 'code') as Template); console.log(`Offline project created: ${resolve(target)}\nRun its config.json with the run command.`); return; }
  if (command === 'runs') { console.log(JSON.stringify(listRuns(resolve(target), positiveOption(args, '--limit') ?? 20), null, 2)); return; }
  if (command === 'validate' || command === 'doctor') {
    const config = loadConfig(resolve(target));
    if (command === 'doctor' && config.backend.kind === 'muse') console.log(JSON.stringify(verifyMuseLock(config.backend.binary, config.backend.compatibilityLock), null, 2));
    else console.log(`Valid ${config.task.type} configuration; backend=${config.backend.kind}. Muse was not launched.`);
    return;
  }
  const controller = new AbortController();
  const stop = () => { console.error('Stopping active work and persisting results…'); controller.abort(new Error('User cancellation')); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const writable = !['inspect', 'report', 'export', 'verify'].includes(command);
  let opened: RunStore | undefined;
  try {
    if (command === 'compare-plan') { prepareComparison(resolve(target), resolve(option(args, '--out')!)); console.log('Comparison plan frozen. No model or evaluator was launched.'); return; }
    if (command === 'compare-run') { await runComparisonArm(resolve(target), args[0] as ComparisonArm, { signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal, allowLive: args.includes('--allow-live'), allowProviderCost: args.includes('--allow-provider-cost') }); console.log(`Comparison records: ${join(resolve(target), 'summary.md')}`); return; }
    if (command === 'compare-report') { writeComparisonReport(resolve(target)); console.log(readFileSync(join(resolve(target), 'summary.md'), 'utf8')); return; }
    if (command === 'smoke-plan') { prepareSmoke(resolve(target), resolve(option(args, '--out')!)); console.log('Unverified smoke plan prepared. No Muse was launched.'); return; }
    if (command === 'smoke-report') { writeSmokeReport(resolve(target)); console.log(readFileSync(join(resolve(target), 'summary.md'), 'utf8')); return; }
    if (command === 'smoke-run') { await runSmokeCase(resolve(target), args[0] as SmokeCase, { allowLive: args.includes('--allow-live'), allowProviderCost: args.includes('--allow-provider-cost'), signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }); console.log('Smoke observations recorded; compatibility remains unverified.'); return; }
    if (command === 'benchmark') {
      const parent = resolve('.branchpilot/benchmarks');
      const directory = resolve(option(args, '--out') ?? join(parent, id()));
      const trials = await runBenchmark(resolve(target), directory, options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal);
      console.log(`Offline measurements: ${join(directory, 'summary.md')}`);
      if (trials.some(trial => trial.status !== 'completed')) process.exitCode = 2;
      return;
    }
    if (command !== 'run' && !existsSync(join(resolve(target), 'events.jsonl'))) throw Error('No committed run found');
    const store = command === 'run' ? createRun(loadConfig(resolve(target)), resolve(option(args, '--out') ?? '.branchpilot/runs')) : new RunStore(resolve(target), writable);
    opened = store;
    if (!store.state) throw Error('No committed run found');
    if (command === 'run' || command === 'resume') {
      const pauseAfter = positiveOption(args, '--pause-after');
      if (pauseAfter !== undefined && !Number.isInteger(pauseAfter)) throw Error('--pause-after must be an integer');
      console.log(`Run directory: ${store.dir}`);
      const state = await runController(store, { signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal, backend: options.backend, pauseAfter, onProgress: message => console.log(message) });
      console.log(`${state.status}: ${state.outcome ?? state.message ?? ''}\nReport: ${join(store.dir, 'report.md')}`);
      if (state.status === 'failed' || state.status === 'needs_attention') process.exitCode = 2;
    } else if (command === 'inspect') {
      const s = store.state; console.log(JSON.stringify({ runId: s.id, status: s.status, phase: s.phase, outcome: s.outcome, message: s.message, strategy: s.strategy, revisions: s.revisions.map(r => ({ id: r.id, parentIds: r.parentIds, snapshot: r.snapshot })), finalists: s.finalists, pending: s.pending, backendQuestions: Object.entries(s.backendInputs ?? (s.backendInput ? { [s.backendInput.workId]: s.backendInput.artifact } : {})).map(([workId, artifact]) => ({ workId, questions: store.getJSON(artifact) })), works: Object.values(s.works).map(w => ({ id: w.id, state: w.state, sessionId: w.sessionId, commandId: w.commandId, turnId: w.turnId, operation: w.operation, pendingAnswer: w.pendingAnswer, usageAfterAnswer: w.usageAfterAnswer })), budget: budgetView(s, true) }, null, 2));
    } else if (command === 'report') console.log(renderReport(store));
    else if (command === 'verify') console.log(JSON.stringify(verifyRun(store), null, 2));
    else if (command === 'switch') {
      if (!args[0]) throw Error('Provide strategy JSON');
      switchStrategy(store, strategySchema.parse(JSON.parse(args[0]))); writeReport(store); console.log('Strategy changed; run ID, evidence and budget preserved. Use resume to continue.');
    } else if (command === 'assess') {
      const rater = option(args, '--rater'); if (!args[0] || !rater) throw Error('Provide result.json and --rater');
      new Scheduler(store, controller.signal).assess(outputSchema.parse(JSON.parse(readFileSync(args[0], 'utf8'))), rater); writeReport(store); console.log('Assessment recorded. Use resume to continue.');
    } else if (command === 'answer' || command === 'reconcile') {
      if (!args[0] || (command === 'answer' && !args[1])) throw Error('Provide a work ID and, for answer, an answer.json file');
      const scheduler = new Scheduler(store, options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal, options.backend);
      await scheduler.recoverBackend(args[0], command, command === 'answer' ? JSON.parse(readFileSync(args[1]!, 'utf8')) : undefined);
      writeReport(store); console.log(`${store.state.status}: ${store.state.message}`);
      if (store.state.status === 'needs_attention') process.exitCode = 2;
    } else if (command === 'resolve') {
      const work = store.state.works[args[0] ?? '']; const tokens = positiveOption(args, '--tokens'); const seconds = positiveOption(args, '--seconds'); const file = option(args, '--evidence');
      if (!work || (work.state !== 'unknown' && !(work.state === 'settled' && work.actual?.tokens === null))) throw Error('Work does not require resolution');
      if (tokens === undefined || !Number.isSafeInteger(tokens) || seconds === undefined || !file || !args.includes('--stopped')) throw Error('Resolution requires measured --tokens, --seconds, --evidence, and explicit --stopped confirmation');
      if (tokens < Math.max(work.actual?.tokens ?? 0, work.observedTokens ?? 0) || seconds < (work.actual?.workSeconds ?? 0)) throw Error('Resolution cannot reduce already observed usage');
      const evidence = store.put(readFileSync(file));
      store.append({ type: 'backend.event', workId: work.id, kind: 'operator_resolution', artifact: evidence }, { type: 'work.updated', work: { ...work, state: 'settled', ...(work.state === 'unknown' ? { evaluationReservations: {} } : {}), pendingAnswer: undefined, usageAfterAnswer: undefined, ...(work.operation ? { operation: { ...work.operation, state: 'completed' } } : {}), outcome: work.state === 'unknown' ? 'failed' : work.outcome, actual: { tokens, workSeconds: seconds, attempts: work.kind === 'attempt' ? 1 : 0, experiments: work.kind === 'experiment' ? 1 : 0 }, usageSource: 'runner_measured', receipt: evidence } }, { type: 'backend.input_cleared', workId: work.id }, { type: 'run.status', status: 'paused', message: 'Operator resolved execution/accounting; resume to continue' });
      writeReport(store); console.log('Resolution recorded without repeating work.');
    } else if (command === 'export') {
      const revision = store.state.revisions.find(r => r.id === args[0]); if (!revision || !args[1]) throw Error('Provide an existing revision ID and empty output directory');
      materialize(store, revision.snapshot, resolve(args[1])); console.log(`Exported ${revision.id} to ${resolve(args[1])}`);
    } else throw Error(`Unknown command: ${command}\n${help}`);
  } finally { try { opened?.close(); } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
