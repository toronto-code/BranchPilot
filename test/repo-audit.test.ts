import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { aggregate, outputSchema } from '../src/evaluation.js';
import { runController, switchStrategy } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { runBenchmark } from '../src/benchmark.js';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { recoverMuseProtocol } from '../src/muse-recovery.js';
import { Scheduler } from '../src/scheduler.js';
import type { Backend, BackendRequest } from '../src/backend.js';
import { protocolExpectation, simulatedSourceRange, SimulatedMuseHost } from './muse-host.js';
import { setup } from './support.js';
import { prepareSmoke, runSmokeCase } from '../src/muse-smoke.js';
import { configSchema } from '../src/config.js';
import { runProcess } from '../src/process.js';
import { executionEnvironment } from '../src/environment.js';

test('explicit pauses precede early stopping and cannot expose held-out work', async t => {
  const { store } = setup(t, 'efficient-repair', config => { config.task.selection.earlyStop = 'first_feasible'; });
  await runController(store, { pauseAfter: 1 });
  assert.equal(store.state.status, 'paused'); assert.equal(store.state.finalists, undefined);
  assert.equal(budgetView(store.state, true).spent.attempts, 1);
  await runController(store); assert.equal(store.state.outcome, 'goal_met');
  assert.equal(budgetView(store.state, true).spent.attempts, 1);
});

test('finite repeated measurements retain a finite median at extreme magnitudes', () => {
  for (const [values, expected] of [
    [[Number.MAX_VALUE, Number.MAX_VALUE], Number.MAX_VALUE],
    [[Number.MIN_VALUE, Number.MIN_VALUE], Number.MIN_VALUE],
    [[-Number.MAX_VALUE, Number.MAX_VALUE], 0],
  ] as const) {
    const result = aggregate(values.map(value => outputSchema.parse({ validity: 'pass', metrics: [{ name: 'extreme', unit: 'units', value }] })));
    assert.equal(result.metrics[0]!.estimate, expected);
    assert.equal(JSON.parse(JSON.stringify(result)).metrics[0].estimate, expected);
  }
});

test('retry develops its failed candidate even when a different archived candidate already passed', async t => {
  const { store } = setup(t, 'efficient-repair', config => {
    config.strategy = { name: 'best-of-n', n: 2 };
    if (config.backend.kind === 'fixture') config.backend.plans[1]!.outcome = 'failed';
  });
  await runController(store, { pauseAfter: 2 });
  const failed = Object.values(store.state.works).filter(work => work.kind === 'attempt').at(-1)!;
  assert.equal(failed.outcome, 'failed');
  switchStrategy(store, { name: 'retry', maxAttemptsPerCandidate: 2 });
  await runController(store);
  assert.equal(budgetView(store.state, true).spent.attempts, 3);
  assert.ok(store.state.revisions.some(revision => revision.candidateId === failed.candidateId));
});

test('benchmark refuses nested output before changing any candidate input', async t => {
  const { root, config } = setup(t);
  const file = join(root, 'config.json'); writeFileSync(file, JSON.stringify(config));
  const suite = join(root, 'suite.json'); writeFileSync(suite, JSON.stringify({ schemaVersion: 1, repetitions: 1, cases: [{ id: 'repair', config: file }] }));
  const output = join(config.task.inputs[0]!.path, 'benchmark-output');
  await assert.rejects(runBenchmark(suite, output), /outside the input/);
  assert.equal(existsSync(output), false);
});

test('an unfamiliar SDK terminal is preserved as uncertainty rather than a proven stop', async t => {
  const { store } = setup(t);
  const host = new SimulatedMuseHost({ onTurn: h => { h.usage(); h.complete('future_terminal'); } });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  const work = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
  assert.equal(work.state, 'unknown'); assert.equal(store.state.status, 'needs_attention');
  assert.equal(store.state.revisions.length, 1);
});

function readOnlyHost(request: BackendRequest, terminal: string, answered = false, freshUsage = false, options: { invalidUsage?: boolean; oversizedPage?: boolean; noSourceRange?: boolean } = {}) {
  const work = request.work;
  return new SimulatedMuseHost({ onRequest: (frame, host) => {
    if (frame.method === 'session/read') {
      host.reply(frame, { session: { sessionId: work.sessionId, workspaceRoot: work.workspace, activeTurnId: null, permissionState: { profileId: protocolExpectation.permissionProfile } }, lastTurn: { turnId: work.turnId, terminal }, pendingRequests: [], history: { mode: 'none', items: null, snapshot: null }, viewCursor: '000009' }); return true;
    }
    if (frame.method === 'view/page') {
      const params = { sessionId: work.sessionId, turnId: work.turnId };
      const events = [
        { method: 'turn/started', params: { ...params, commandId: work.commandId, viewCursor: '000001' } },
        { method: 'session/tokenUsage', params: { ...params, cumulative: { totalTokens: 80 }, viewCursor: '000002' } },
        ...(answered ? [{ method: 'userInput/settled', params: { ...params, userInputId: work.pendingAnswer!.userInputId, decidedByCommandId: work.pendingAnswer!.commandId, outcome: 'answered', viewCursor: '000003' } }] : []),
        ...(freshUsage ? [{ method: 'session/tokenUsage', params: { ...params, cumulative: { totalTokens: 100 }, viewCursor: '000004' } }] : []),
        ...(options.invalidUsage ? [{ method: 'session/tokenUsage', params: { ...params, cumulative: { totalTokens: -1 }, viewCursor: '000004' } }] : []),
        { method: 'turn/completed', params: { ...params, terminal, viewCursor: '000005' } },
      ];
      if (options.oversizedPage) while (events.length <= 1000) events.push(events[0]!);
      host.reply(frame, { events: events.map((event, index) => ({ ...event, params: { ...event.params, ...(!options.noSourceRange ? { sourceRange: simulatedSourceRange(index + 1, work.sessionId!) } : {}) } })), nextCursor: null }); return true;
    }
  } });
}
const uncertainBackend: Backend = { execute: async request => {
  request.record('test.identity', {}, { sessionId: 'original-session', commandId: 'original-command', turnId: 'original-turn' });
  return { outcome: 'unknown', tokens: 80, stopped: false, proposal: '', hypotheses: [], receipt: {} };
} };

test('read-only recovery also refuses an unfamiliar terminal state', async t => {
  const { store } = setup(t); await runController(store, { backend: uncertainBackend });
  const work = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
  const backend: Backend = { ...uncertainBackend, reconcile: request => recoverMuseProtocol(request, protocolExpectation, readOnlyHost(request, 'future_terminal').factory) };
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.state, 'unknown');
});

test('reconciliation rejects missing durable ranges, oversized history pages and invalid latest usage', async t => {
  for (const options of [{ noSourceRange: true }, { oversizedPage: true }, { invalidUsage: true }]) {
    const { store } = setup(t); await runController(store, { backend: uncertainBackend });
    const work = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
    const backend: Backend = { ...uncertainBackend, reconcile: request => recoverMuseProtocol(request, protocolExpectation, readOnlyHost(request, 'completed', false, false, options).factory) };
    await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
    assert.equal(store.state.status, 'needs_attention');
    if (options.invalidUsage) { assert.equal(store.state.works[work.id]!.actual?.tokens, null); assert.equal(store.state.works[work.id]!.observedTokens, 80); }
    else assert.equal(store.state.works[work.id]!.state, 'unknown');
  }
});

test('reconciliation cannot promote pre-answer usage to a completed continuation total', async t => {
  const { store } = setup(t); await runController(store, { backend: uncertainBackend });
  let work = Object.values(store.state.works).find(work => work.kind === 'attempt')!;
  work = { ...work, pendingAnswer: { userInputId: 'answered-input', commandId: 'answer-command' } };
  store.append({ type: 'work.updated', work });
  const backend: Backend = { ...uncertainBackend, reconcile: request => recoverMuseProtocol(request, protocolExpectation, readOnlyHost(request, 'completed', true).factory) };
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.actual?.tokens, null);
  assert.equal(store.state.works[work.id]!.observedTokens, 80);
  assert.equal(store.state.status, 'needs_attention');
  assert.deepEqual(store.state.works[work.id]!.usageAfterAnswer, work.pendingAnswer);
  const stale: Backend = { ...uncertainBackend, reconcile: request => recoverMuseProtocol(request, protocolExpectation, readOnlyHost({ ...request, work: { ...request.work, pendingAnswer: work.pendingAnswer } }, 'completed', true).factory) };
  await new Scheduler(store, new AbortController().signal, stale).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.actual?.tokens, null);
  const fresh: Backend = { ...uncertainBackend, reconcile: request => recoverMuseProtocol(request, protocolExpectation, readOnlyHost({ ...request, work: { ...request.work, pendingAnswer: work.pendingAnswer } }, 'completed', true, true).factory) };
  await new Scheduler(store, new AbortController().signal, fresh).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.actual?.tokens, 100);
  assert.equal(store.state.works[work.id]!.usageAfterAnswer, undefined);
  assert.equal(store.state.status, 'paused');
  assert.ok(readFileSync(join(store.dir, 'events.jsonl'), 'utf8').includes('answer-command'));
});

test('executable dispatch refuses a changed environment without invalidating prior work', async t => {
  const { store } = setup(t, 'retry');
  await runController(store, { pauseAfter: 1 });
  const spent = budgetView(store.state, true).spent;
  const original = store.state.manifest.environment;
  store.state.manifest.environment = store.putJSON({ ...executionEnvironment(store.state.config), node: 'different-node-version' });
  await runController(store);
  assert.equal(store.state.status, 'needs_attention'); assert.match(store.state.message!, /environment differs/);
  assert.deepEqual(budgetView(store.state, true).spent, spent);
  store.state.manifest.environment = original;
  await runController(store); assert.equal(store.state.outcome, 'goal_met');
});

test('oversized timers and unrepresentable wall deadlines fail validation before starting work', t => {
  const { config, root } = setup(t);
  const oversized = structuredClone(config); oversized.budget.perAttempt.timeoutSeconds = 3_000_000;
  assert.throws(() => configSchema.parse(oversized));
  const impossibleDate = structuredClone(config); impossibleDate.budget.wallSeconds = 1e20;
  assert.throws(() => configSchema.parse(impossibleDate), /date range/);
  const marker = join(root, 'must-not-start');
  assert.throws(() => runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], { cwd: root, timeoutMs: 3_000_000_000, graceMs: 10 }), /timer range/);
  assert.equal(existsSync(marker), false);
});

test('bounded workspace text reads reject FIFOs without waiting for a writer', async t => {
  const { root } = setup(t); const fifo = join(root, 'fifo'); execFileSync('mkfifo', [fifo]);
  const script = `import {readRegularText} from ${JSON.stringify(new URL('../src/workspaces.js', import.meta.url).href)};try { readRegularText(${JSON.stringify(fifo)}, 4096); process.exitCode=1; } catch(e) { console.log(e.message); }`;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeoutMs: 1000, graceMs: 20 });
  assert.equal(result.code, 0); assert.equal(result.timedOut, false); assert.match(result.stdout, /regular file/);
});

test('smoke simulations retain usage when output is missing, oversized, or a symlink and do not inspect uncertain files', async t => {
  for (const shape of ['missing', 'oversized', 'symlink', 'uncertain'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'branchpilot-smoke-audit-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home'); mkdirSync(home);
    const binary = join(root, 'never-executed'); writeFileSync(binary, 'never execute');
    const spec = join(root, 'spec.json');
    writeFileSync(spec, JSON.stringify({ schemaVersion: 1, binary, runtimeHome: home, binaryVersion: protocolExpectation.binaryVersion, schemaFingerprint: protocolExpectation.schemaFingerprint, permissionProfile: protocolExpectation.permissionProfile, model: { providerId: 'sim-provider', modelId: 'sim-model' }, effort: 'high', timeoutSeconds: 2, cancellationGraceSeconds: 0.02 }));
    const directory = join(root, 'plan'); prepareSmoke(spec, directory);
    const host = new SimulatedMuseHost({ onTurn: host => {
      const workspace = String(host.frames.find(frame => frame.method === 'session/start')!.params!.workspaceRoot);
      const file = join(workspace, 'smoke.txt'); unlinkSync(file);
      if (shape === 'oversized') writeFileSync(file, 'x'.repeat(8192));
      if (shape === 'symlink') symlinkSync(join(directory, 'private-canary.txt'), file);
      host.usage(123);
      if (shape === 'uncertain') host.disconnect(); else host.complete();
    } });
    await runSmokeCase(directory, 'completion', { allowLive: true, allowProviderCost: true, openHost: host.factory });
    const result = JSON.parse(readFileSync(join(directory, 'completion/result.json'), 'utf8'));
    assert.equal(result.facts.reportedTokens, 123);
    assert.equal(result.facts.expectedEditObserved, shape === 'uncertain' ? null : false);
    assert.equal(result.result.outcome, shape === 'uncertain' ? 'unknown' : 'completed');
  }
});
