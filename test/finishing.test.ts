import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runController } from '../src/controller.js';
import { configSchema, loadConfig } from '../src/config.js';
import { budgetView } from '../src/budget.js';
import { Scheduler } from '../src/scheduler.js';
import { prepareSmoke, runSmokeCase, writeSmokeReport } from '../src/muse-smoke.js';
import { verifyMuseLock } from '../src/muse.js';
import { runBenchmark } from '../src/benchmark.js';
import { runCli } from '../src/cli.js';
import type { Backend, BackendResult } from '../src/backend.js';
import type { Snapshot } from '../src/types.js';
import { protocolExpectation, SimulatedMuseHost } from './muse-host.js';
import { setup } from './support.js';

const hypothesis = { id: 'h1', assumption: 'Integers are representative', expectedBenefit: 'Fewer errors', uncertainty: 'Fractional values', prediction: 'All declared cases pass', falsificationTest: 'Try a fractional pair' };
const completed: BackendResult = { outcome: 'completed', tokens: 25, proposal: 'A proposal', hypotheses: [], receipt: {}, stopped: true };

test('structured candidate claims are frozen with the revision and remain separate from executable evidence', async t => {
  const { store } = setup(t, 'repair', config => {
    if (config.backend.kind === 'fixture') config.backend.plans[0]!.files['branchpilot-result.json'] = JSON.stringify({ schemaVersion: 1, hypotheses: [hypothesis], proposal: 'Updated explanation' });
  });
  await runController(store);
  const revision = store.state.revisions.at(-1)!;
  assert.deepEqual(revision.hypotheses, [hypothesis]); assert.equal(revision.proposal, 'Updated explanation');
  assert.ok(store.getJSON<Snapshot>(revision.snapshot).files.some(file => file.path === 'branchpilot-result.json'));
  assert.equal(store.state.outcome, 'goal_met');
  assert.ok(store.state.evaluations.every(evaluation => evaluation.kind === 'executable'));
});

test('malformed structured output preserves paid usage and cannot be promoted or blindly repeated', async t => {
  const { store } = setup(t, 'repair', config => {
    if (config.backend.kind === 'fixture') config.backend.plans[0]!.files['branchpilot-result.json'] = JSON.stringify({ schemaVersion: 1, hypotheses: [hypothesis, hypothesis] });
  });
  await runController(store);
  const attempt = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
  assert.equal(store.state.status, 'needs_attention'); assert.equal(attempt.state, 'settled'); assert.equal(attempt.outcome, 'failed'); assert.equal(attempt.actual?.tokens, 120);
  assert.equal(store.state.revisions.length, 1); assert.deepEqual(attempt.evaluationReservations, {});
  await runController(store);
  assert.equal(Object.values(store.state.works).filter(work => work.kind === 'attempt').length, 1);
});

test('reconciled malformed output retains a proven stop and cumulative paid usage', async t => {
  const { store } = setup(t);
  const backend: Backend = {
    execute: async request => { request.record('test.identity', {}, { sessionId: 'original', commandId: 'original-command', turnId: 'original-turn' }); return { ...completed, outcome: 'unknown', stopped: false, tokens: 14 }; },
    reconcile: async request => { writeFileSync(join(request.work.workspace, 'branchpilot-result.json'), '{broken'); return completed; },
  };
  await runController(store, { backend });
  const attempt = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(attempt.id, 'reconcile');
  const settled = store.state.works[attempt.id]!;
  assert.equal(settled.state, 'settled'); assert.equal(settled.outcome, 'failed'); assert.equal(settled.actual?.tokens, 25);
  assert.equal(settled.operation?.state, 'completed'); assert.equal(store.state.revisions.length, 1);
  assert.equal(budgetView(store.state).unknown.tokens, 0);
});

test('initial execution retains a reported token lower bound when the final total is absent or contradictory', async t => {
  for (const tokens of [null, 10]) {
    const { store } = setup(t);
    await runController(store, { backend: { execute: async () => ({ ...completed, tokens, observedTokens: 2000 }) } });
    const attempt = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
    assert.equal(store.state.status, 'needs_attention'); assert.equal(attempt.state, 'settled');
    assert.equal(attempt.actual?.tokens, null); assert.equal(attempt.observedTokens, 2000);
    assert.equal(budgetView(store.state).unknown.tokens, 2000);
    await runController(store); assert.equal(Object.values(store.state.works).filter(work => work.kind === 'attempt').length, 1);
  }
});

test('repository evaluation installs local dependencies offline, suppresses lifecycle scripts and builds only a disposable copy', async t => {
  const { store, config } = setup(t, 'repository');
  const original = readFileSync(join(config.task.inputs[0]!.path, 'src/calculator.mjs'), 'utf8');
  await runController(store);
  assert.equal(store.state.outcome, 'goal_met', store.state.message);
  assert.equal(readFileSync(join(config.task.inputs[0]!.path, 'src/calculator.mjs'), 'utf8'), original);
  for (const path of ['node_modules', 'dist', 'UNEXPECTED_INSTALL_SCRIPT']) assert.equal(existsSync(join(config.task.inputs[0]!.path, path)), false);
  assert.ok(store.state.revisions.every(revision => store.getJSON<Snapshot>(revision.snapshot).files.every(file => !file.path.startsWith('node_modules/') && !file.path.startsWith('dist/'))));
  for (const evaluation of store.state.evaluations) {
    const evidence = evaluation.evidence.map(digest => store.getJSON<{ stage?: string; args?: string[] }>(digest));
    assert.deepEqual(evidence.filter(item => item.stage).map(item => item.stage), ['install', 'build']);
    assert.ok(evidence[0]!.args!.includes('--offline')); assert.ok(evidence[0]!.args!.includes('--ignore-scripts'));
  }
  assert.equal(budgetView(store.state, true).spent.experiments, 2);
});

test('a candidate build failure becomes actionable development feedback and a retry can repair it', async t => {
  const { store } = setup(t, 'repository', (config, root) => {
    writeFileSync(join(config.task.inputs[0]!.path, 'build.mjs'), 'throw Error("Build failed deliberately");');
    const evaluator = join(root, 'evaluators', 'repository.json');
    writeFileSync(evaluator, JSON.stringify({ schemaVersion: 1, script: 'repository.mjs', workflow: { build: [{ script: 'build.mjs' }] } }));
    // No install in this procedure: the build checks a self-contained module.
    writeFileSync(join(config.task.inputs[0]!.path, 'src/calculator.mjs'), 'export const add = (a,b) => a-b;');
    config.strategy = { name: 'retry', maxAttemptsPerCandidate: 2 };
    if (config.backend.kind === 'fixture') {
      config.backend.plans[0]!.files = { 'src/calculator.mjs': 'export const add = (a,b) => a+b;' };
      config.backend.plans.push({ ...config.backend.plans[0]!, files: { 'build.mjs': "import {mkdirSync,copyFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});copyFileSync('src/calculator.mjs','dist/calculator.mjs');" } });
    }
  });
  await runController(store);
  assert.equal(store.state.outcome, 'goal_met', store.state.message); assert.equal(store.state.evaluations[0]!.failureType, 'correctness');
  assert.equal(store.state.evaluations[1]!.validity, 'fail');
  assert.equal(budgetView(store.state, true).spent.experiments, 3); assert.equal(budgetView(store.state, true).spent.attempts, 2);
  const retry = Object.values(store.state.works).filter(work => work.kind === 'attempt')[1]!;
  assert.match(store.getJSON<{ prompt: string }>(retry.intent).prompt, /Build failed deliberately/);
});

test('repository setup/build shares the evaluator timeout and confirms process termination', async t => {
  const { store } = setup(t, 'repository', (config, root) => {
    config.task.evaluators[0]!.timeoutSeconds = 0.15;
    writeFileSync(join(config.task.inputs[0]!.path, 'build.mjs'), 'setTimeout(() => {}, 10000);');
    writeFileSync(join(root, 'evaluators', 'repository.json'), JSON.stringify({ schemaVersion: 1, script: 'repository.mjs', workflow: { build: [{ script: 'build.mjs' }] } }));
  });
  await runController(store);
  const evaluation = store.state.evaluations[0]!;
  assert.equal(evaluation.failureType, 'timeout');
  const process = store.getJSON<{ timedOut: boolean; stopped: boolean }>(evaluation.evidence[0]!);
  assert.equal(process.timedOut, true); assert.equal(process.stopped, true);
  assert.ok(budgetView(store.state, true).spent.workSeconds >= 0.15);
});

test('first_feasible stops only after a settled wave and saves remaining attempt/evaluator budgets', async t => {
  const { store } = setup(t, 'efficient-repair', config => { config.task.selection.earlyStop = 'first_feasible'; config.budget.maxConcurrency = 2; });
  await runController(store);
  assert.equal(store.state.outcome, 'goal_met'); assert.equal(budgetView(store.state, true).spent.attempts, 2);
  assert.equal(budgetView(store.state, true).spent.tokens, 240); assert.equal(budgetView(store.state).reserved.attempts, 0);
  assert.ok(store.state.decisions.some(decision => decision.reason.includes('first_feasible')));
});

test('early stopping never uses held-out failures to restart search', async t => {
  const { store } = setup(t, 'efficient-repair', (config, root) => {
    config.task.selection.earlyStop = 'first_feasible';
    config.task.evaluators.push({ ...config.task.evaluators[0]!, id: 'held', split: 'held_out', definition: { path: join(root, 'evaluators', 'always-fail.json') } });
    writeFileSync(join(root, 'evaluators', 'always-fail.json'), JSON.stringify({ schemaVersion: 1, script: 'always-fail.mjs' }));
    writeFileSync(join(root, 'evaluators', 'always-fail.mjs'), 'console.log(JSON.stringify({validity:"fail"}));');
    config.budget.finalizationReserve = { tokens: 0, attempts: 0, experiments: 2, workSeconds: 10 };
  });
  await runController(store); const chosen = store.state.finalists;
  assert.equal(store.state.outcome, 'inconclusive'); assert.equal(budgetView(store.state, true).spent.attempts, 1);
  await runController(store); assert.deepEqual(store.state.finalists, chosen); assert.equal(budgetView(store.state, true).spent.attempts, 1);
  const optimization = loadConfig(resolve('examples/optimization.json')); optimization.task.selection.earlyStop = 'first_feasible';
  assert.throws(() => configSchema.parse(optimization), /no optimization objectives/);
});

function temporary(t: import('node:test').TestContext) { const root = mkdtempSync(join(tmpdir(), 'branchpilot-smoke-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function smokePlan(root: string): string {
  const home = join(root, 'runtime-home'); mkdirSync(home);
  const binary = join(root, 'do-not-execute'); writeFileSync(binary, 'THIS FILE MUST NEVER BE EXECUTED');
  const spec = join(root, 'spec.json');
  writeFileSync(spec, JSON.stringify({ schemaVersion: 1, binary, runtimeHome: home, ...protocolExpectation, approvalMode: undefined, model: { providerId: 'sim-provider', modelId: 'sim-model' }, effort: 'high', timeoutSeconds: 2, cancellationGraceSeconds: 0.02 }));
  const directory = join(root, 'plan'); prepareSmoke(spec, directory); return directory;
}

test('smoke preparation/reporting is local, explicitly unverified and refuses missing live opt-ins', async t => {
  const directory = smokePlan(temporary(t));
  const host = new SimulatedMuseHost();
  for (const flags of [{ allowLive: false, allowProviderCost: true }, { allowLive: true, allowProviderCost: false }]) await assert.rejects(runSmokeCase(directory, 'completion', { ...flags, openHost: host.factory }), /requires explicit/);
  await assert.rejects(runCli(['smoke-run', directory, 'completion']), /--allow-live/);
  writeSmokeReport(directory);
  assert.equal(host.initializeCount, 0); assert.equal(existsSync(join(directory, 'completion')), false);
  const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
  assert.equal(summary.compatibilityVerified, false); assert.ok(summary.cases.every((entry: { status: string }) => entry.status === 'unverified'));
  assert.throws(() => verifyMuseLock(join(dirnameOf(directory), 'do-not-execute'), join(directory, 'summary.json')));
});
const dirnameOf = (path: string) => resolve(path, '..');

test('smoke simulations capture edits/settings/usage, cancellation and host loss without authorizing compatibility or replay', async t => {
  const directory = smokePlan(temporary(t));
  const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')).plan;
  const host = new SimulatedMuseHost({ onTurn: h => {
    const frame = h.frames.find(frame => frame.method === 'session/start')!;
    writeFileSync(join(String(frame.params!.workspaceRoot), 'smoke.txt'), plan.expectedEdit);
    h.item(); h.usage(); h.complete();
  } });
  await runSmokeCase(directory, 'completion', { allowLive: true, allowProviderCost: true, openHost: host.factory });
  const completion = JSON.parse(readFileSync(join(directory, 'completion/result.json'), 'utf8'));
  assert.equal(completion.mode, 'protocol_simulation'); assert.equal(completion.facts.expectedEditObserved, true);
  assert.equal(completion.facts.settingsReadbackAccepted, true); assert.equal(completion.facts.reportedTokens, 123);
  const idle = () => new SimulatedMuseHost({ onTurn: () => undefined });
  await runSmokeCase(directory, 'cancellation', { allowLive: true, allowProviderCost: true, openHost: idle().factory });
  assert.equal(JSON.parse(readFileSync(join(directory, 'cancellation/result.json'), 'utf8')).facts.cancellationTerminalObserved, true);
  const failure = idle(); await runSmokeCase(directory, 'host-failure', { allowLive: true, allowProviderCost: true, openHost: failure.factory });
  assert.equal(JSON.parse(readFileSync(join(directory, 'host-failure/result.json'), 'utf8')).facts.hostFailureRetainedUncertainty, true);
  await assert.rejects(runSmokeCase(directory, 'host-failure', { allowLive: true, allowProviderCost: true, openHost: failure.factory }), /EEXIST/);
  assert.equal(failure.frames.filter(frame => frame.method === 'turn/start').length, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')).compatibilityVerified, false);
});

test('a smoke plan refuses a changed binary before host initialization', async t => {
  const root = temporary(t); const directory = smokePlan(root); const host = new SimulatedMuseHost();
  writeFileSync(join(root, 'do-not-execute'), 'changed');
  await assert.rejects(runSmokeCase(directory, 'completion', { allowLive: true, allowProviderCost: true, openHost: host.factory }), /changed after/);
  assert.equal(host.initializeCount, 0); assert.equal(existsSync(join(directory, 'completion')), false);
});

test('offline paired measurements retain exact inputs and show equal fixture outcomes for less spending', async t => {
  const root = temporary(t); const suite = join(root, 'suite.json'); const output = join(root, 'measurements');
  writeFileSync(suite, JSON.stringify({ schemaVersion: 1, repetitions: 1, cases: [{ id: 'full', config: resolve('examples/efficient-repair.json') }, { id: 'stop', config: resolve('examples/efficient-repair.json'), earlyStop: 'first_feasible' }] }));
  const trials = await runBenchmark(suite, output);
  assert.deepEqual(trials.map(trial => trial.outcome), ['goal_met', 'goal_met']);
  assert.deepEqual(trials.map(trial => trial.spent.tokens), [480, 120]); assert.deepEqual(trials.map(trial => trial.spent.attempts), [4, 1]);
  assert.equal(trials[0]!.inputSnapshot, trials[1]!.inputSnapshot); assert.deepEqual(trials[0]!.evaluators, trials[1]!.evaluators);
  assert.equal(JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')).simulatedBackend, true);
  await assert.rejects(runBenchmark(suite, output), /EEXIST/);
});

test('benchmark summaries cannot average missing usage into zero-cost success', async t => {
  const root = temporary(t); const config = loadConfig(resolve('examples/repair.json'));
  if (config.backend.kind === 'fixture') config.backend.plans[0]!.tokens = null;
  writeFileSync(join(root, 'config.json'), JSON.stringify(config));
  const suite = join(root, 'suite.json');
  writeFileSync(suite, JSON.stringify({ schemaVersion: 1, repetitions: 1, cases: [{ id: 'missing', config: 'config.json' }] }));
  const output = join(root, 'results'); await runBenchmark(suite, output);
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.cases[0].outcomes, ['needs_attention']); assert.equal(summary.cases[0].tokens, null);
  assert.equal(summary.cases[0].heldTokens.max, 1000); assert.match(readFileSync(join(output, 'summary.md'), 'utf8'), /unresolved/);
});
