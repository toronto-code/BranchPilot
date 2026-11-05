import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend, BackendRequest } from '../src/backend.js';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { recoverMuseProtocol } from '../src/muse-recovery.js';
import { runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { Scheduler } from '../src/scheduler.js';
import { RunStore } from '../src/store.js';
import { runCli } from '../src/cli.js';
import { MuseBackend } from '../src/muse.js';
import { backendAnswerSchema } from '../src/backend-input.js';
import { setup } from './support.js';
import { protocolExpectation, simulatedSourceRange, SimulatedMuseHost } from './muse-host.js';

const answer = { userInputId: 'simulated-question', answers: [{ questionId: 'q1', selectedLabel: 'A' }] };
async function pausedQuestion(t: TestContext, modify: (config: import('../src/types.js').Config) => void = () => undefined) {
  const result = setup(t, 'repair', modify);
  const host = new SimulatedMuseHost({ onTurn: h => { h.usage(80); h.question(); } });
  await runController(result.store, { backend: { execute: request => executeMuseProtocol(request, { ...protocolExpectation, questionContinuationVerified: true }, host.factory) } });
  const work = Object.values(result.store.state.works).find(w => w.kind === 'attempt')!;
  assert.equal(work.state, 'unknown'); assert.ok(result.store.state.backendInput);
  return { ...result, work, initialHost: host };
}
interface RecoveryOptions { terminal?: boolean; tokens?: number | null; noFreshUsage?: boolean; conflictingTerminals?: boolean; disconnectAnswer?: boolean; ackOnly?: boolean; wrongSession?: boolean; wrongWorkspace?: boolean; noQuestion?: boolean; noTurnIdentity?: boolean; foreignTurn?: boolean; durability?: string; model?: string; effort?: string; nextQuestion?: boolean; userInputId?: string; onAnswer?: (request: BackendRequest) => void }
function recoveryBackend(options: RecoveryOptions = {}) {
  const hosts: SimulatedMuseHost[] = [];
  const backend: Backend = {
    execute: async () => { assert.fail('Recovery must never create a fresh attempt'); },
    answer: async (request, answer) => recoverMuseProtocol(request, protocolExpectation, makeHost(request).factory, answer),
    reconcile: async request => recoverMuseProtocol(request, protocolExpectation, makeHost(request).factory),
  };
  function makeHost(request: BackendRequest): SimulatedMuseHost {
    const work = request.work; const inputId = options.userInputId ?? answer.userInputId;
    const question = { sessionId: work.sessionId, turnId: work.turnId, userInputId: inputId, itemId: 'question-item', toolCallId: 'question-tool', toolName: 'ask', questions: [{ id: 'q1', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }], selection: { mode: 'single' } }], viewCursor: '000002' };
    const record = () => ({ session: { sessionId: options.wrongSession ? 'foreign-session' : work.sessionId, workspaceRoot: options.wrongWorkspace ? '/another/workspace' : work.workspace, activeTurnId: options.terminal ? null : work.turnId, permissionState: { profileId: protocolExpectation.permissionProfile }, approvalMode: { mode: 'denyUnmatched' }, providerId: 'sim-provider', modelId: options.model ?? 'sim-model' }, pendingRequests: options.terminal || options.noQuestion ? [] : [{ kind: 'userInput', userInputId: inputId, viewCursor: '000002' }], history: { mode: 'none', items: null, snapshot: null }, ...(options.terminal ? { lastTurn: { turnId: work.turnId, terminal: 'completed' } } : {}), viewCursor: '000010' });
    const host = new SimulatedMuseHost({ durability: options.durability, onRequest: (frame, h) => {
      if (frame.method === 'session/read') { h.reply(frame, record()); return true; }
      if (frame.method === 'view/page') {
        const params = { sessionId: work.sessionId, turnId: work.turnId, viewCursor: '000001' };
        const events = [
          { method: 'session/reasoningEffortChanged', params: { ...params, reasoningEffort: options.effort ?? 'high' } },
          ...(!options.noTurnIdentity ? [{ method: 'turn/started', params: { ...params, commandId: work.commandId } }] : []),
          { method: 'userInput/requested', params: question },
          ...(options.foreignTurn ? [{ method: 'turn/started', params: { ...params, turnId: 'foreign-turn', commandId: 'foreign-command' } }] : []),
          ...(options.tokens !== null ? [{ method: 'session/tokenUsage', params: { ...params, cumulative: { totalTokens: options.tokens ?? 250 } } }] : []),
          ...(options.terminal ? [ ...(options.conflictingTerminals ? [{ method: 'turn/completed', params: { ...params, terminal: 'failed' } }] : []), { method: 'turn/completed', params: { ...params, terminal: 'completed' } }] : []),
        ];
        h.reply(frame, { events: events.map((event, index) => ({ ...event, params: { ...event.params, sourceRange: simulatedSourceRange(index + 1, work.sessionId!) } })), nextCursor: null }); return true;
      }
      if (frame.method === 'session/resume') { h.reply(frame, record()); h.notify('userInput/requested', question); return true; }
      if (frame.method === 'userInput/answer') {
        assert.equal(frame.params!.sessionId, work.sessionId); assert.equal(frame.params!.userInputId, inputId);
        const persisted = request.work.operation;
        assert.ok(persisted);
        options.onAnswer?.(request);
        if (options.disconnectAnswer) { h.disconnect(); return true; }
        h.reply(frame, { commandId: frame.params!.commandId, userInputId: inputId, status: 'accepted' });
        if (!options.ackOnly) {
          h.notify('userInput/settled', { userInputId: inputId, outcome: 'answered', answers: frame.params!.answers, clarification: null, reason: null, decidedAt: new Date().toISOString(), decidedByCommandId: frame.params!.commandId });
          writeFileSync(join(work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }');
          if (!options.noFreshUsage) h.usage(options.tokens ?? 250);
          if (options.nextQuestion) h.notify('userInput/requested', { ...question, userInputId: 'next-question', viewCursor: '000020' }); else h.complete();
        }
        return true;
      }
    } });
    host.sessionId = work.sessionId!; host.turnId = work.turnId; hosts.push(host); return host;
  }
  return { backend, hosts };
}

for (const change of ['unchanged', 'model', 'effort'] as const) test(`preference recovery preserves the original selection: ${change}`, async t => {
  const { store, work } = await pausedQuestion(t, config => {
    config.agent = { model: { kind: 'preference', choices: [{ modelId: 'sim-model' }] }, effort: { kind: 'highest', minimum: 'high' } };
  });
  assert.equal(work.agentSettings!.effort, 'high');
  const { backend, hosts } = recoveryBackend(change === 'model' ? { model: 'different-model' } : change === 'effort' ? { effort: 'low' } : {});
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer);
  const answered = hosts.some(host => host.frames.some(frame => frame.method === 'userInput/answer'));
  assert.equal(answered, change === 'unchanged');
  assert.equal(store.state.works[work.id]!.state, change === 'unchanged' ? 'settled' : 'unknown');
  assert.equal(hosts.some(host => host.frames.some(frame => ['model/list', 'session/setModel', 'session/setReasoningEffort'].includes(frame.method ?? ''))), false);
});

test('answer reattaches to the original session, durably identifies the answer, settles cumulative usage and resumes evaluation', async t => {
  const { store, work } = await pausedQuestion(t);
  const { backend, hosts } = recoveryBackend({ onAnswer: request => {
    const persisted = store.state.works[work.id]!;
    assert.ok(persisted.operation!.commandId); assert.equal(persisted.commandId, work.commandId);
    assert.equal(persisted.state, 'unknown'); assert.ok(budgetView(store.state).unknown.tokens >= 1080);
    assert.equal(request.work.id, work.id);
  } });
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer);
  assert.equal(store.state.status, 'paused'); assert.equal(store.state.backendInput, undefined);
  assert.equal(store.state.works[work.id]!.state, 'settled'); assert.equal(store.state.works[work.id]!.operation!.state, 'completed');
  assert.equal(budgetView(store.state).spent.tokens, 250); assert.equal(budgetView(store.state).spent.attempts, 1);
  const frames = hosts.flatMap(h => h.frames);
  assert.equal(frames.filter(f => f.method === 'session/resume').length, 1); assert.equal(frames.filter(f => f.method === 'userInput/answer').length, 1);
  assert.equal(frames.some(f => f.method === 'turn/start' || f.method === 'session/start'), false);
  await runController(store); assert.equal(store.state.outcome, 'goal_met');
  assert.equal(budgetView(store.state).spent.attempts, 1); assert.equal(budgetView(store.state).reserved.experiments, 0);
});

test('invalid question identity and answer shape fail before opening a recovery host', async t => {
  const { store, work } = await pausedQuestion(t); const { backend, hosts } = recoveryBackend();
  const scheduler = new Scheduler(store, new AbortController().signal, backend);
  for (const bad of [ { ...answer, userInputId: 'wrong-question' }, { ...answer, answers: [{ questionId: 'q1', selectedLabel: 'unoffered' }] }, { ...answer, answers: [{ questionId: 'q1', selectedLabel: 'A', freeText: 'both' }] } ]) await assert.rejects(scheduler.recoverBackend(work.id, 'answer', bad));
  assert.equal(hosts.length, 0); assert.equal(store.state.works[work.id]!.operation, undefined);
  assert.equal(backendAnswerSchema.safeParse({ ...answer, answers: [{ questionId: 'q1', freeText: 'a'.repeat(501) }] }).success, false);
});

for (const option of ['wrongSession', 'wrongWorkspace', 'noQuestion', 'foreignTurn'] as const) {
  test(`recovery rejects ${option} without answering or submitting any turn`, async t => {
    const { store, work } = await pausedQuestion(t); const { backend, hosts } = recoveryBackend({ [option]: true });
    await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer);
    assert.equal(store.state.status, 'needs_attention');
    assert.equal(hosts.flatMap(h => h.frames).some(f => f.method === 'userInput/answer' || f.method === 'turn/start'), false);
  });
}

test('an answer acknowledgement without durable question settlement or a turn terminal remains uncertain', async t => {
  const { store, work } = await pausedQuestion(t); const { backend, hosts } = recoveryBackend({ ackOnly: true });
  const abort = new AbortController();
  const job = new Scheduler(store, abort.signal, backend).recoverBackend(work.id, 'answer', answer);
  const timer = setTimeout(() => abort.abort(), 100); await job; clearTimeout(timer);
  assert.equal(store.state.works[work.id]!.state, 'unknown'); assert.ok(store.state.backendInput);
  await assert.rejects(new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer), /earlier answer is uncertain/);
  assert.equal(hosts.flatMap(h => h.frames).filter(f => f.method === 'userInput/answer').length, 1);
});

test('disconnect after answer submission preserves the answer command and blocks blind resubmission across reopen', async t => {
  const { store, work } = await pausedQuestion(t); const { backend, hosts } = recoveryBackend({ disconnectAnswer: true });
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer);
  const commandId = store.state.works[work.id]!.operation!.commandId; assert.ok(commandId);
  const dir = store.dir; store.close(); const recovered = new RunStore(dir, true); t.after(() => recovered.close());
  await assert.rejects(new Scheduler(recovered, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer), /earlier answer is uncertain/);
  assert.equal(recovered.state.works[work.id]!.operation!.commandId, commandId);
  assert.equal(hosts.flatMap(h => h.frames).filter(f => f.method === 'userInput/answer').length, 1);
});

test('read-only reconciliation imports the original terminal and usage without submitting or resuming', async t => {
  const { store, work } = await pausedQuestion(t);
  writeFileSync(join(work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }');
  const { backend, hosts } = recoveryBackend({ terminal: true, tokens: 450 });
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.status, 'paused'); assert.equal(budgetView(store.state).spent.tokens, 450);
  assert.equal(store.state.backendInput, undefined); assert.equal(store.state.revisions.filter(r => r.attemptId === work.id).length, 1);
  assert.ok(hosts.flatMap(h => h.frames).every(f => !['turn/start', 'session/start', 'session/resume', 'userInput/answer'].includes(f.method ?? '')));
  await runController(store); assert.equal(store.state.outcome, 'goal_met');
});

test('reconciliation cannot invent termination, usage, or durability', async t => {
  for (const options of [{}, { terminal: true, tokens: null }, { terminal: true, durability: 'ephemeral' }]) {
    const { store, work } = await pausedQuestion(t); const { backend } = recoveryBackend(options);
    await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
    assert.equal(store.state.status, 'needs_attention');
    if (options.tokens === null) assert.equal(budgetView(store.state).unknown.tokens >= 1000, true);
    else assert.equal(store.state.works[work.id]!.state, 'unknown');
  }
});

test('recovery completion receipts import exactly once after a crash before the completion transaction', async t => {
  const { store, work } = await pausedQuestion(t); const { backend } = recoveryBackend({ terminal: true });
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
  const rows = readFileSync(join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n');
  const index = rows.findIndex(row => JSON.parse(row).events.some((event: { type: string; revision?: { attemptId?: string } }) => event.type === 'revision.created' && event.revision?.attemptId === work.id));
  assert.ok(index > 0); const dir = store.dir; store.close(); writeFileSync(join(dir, 'events.jsonl'), rows.slice(0, index).join('\n') + '\n');
  const recovered = new RunStore(dir, true); t.after(() => recovered.close());
  const scheduler = new Scheduler(recovered, new AbortController().signal); scheduler.recover(); scheduler.recover();
  assert.equal(recovered.state.backendInput, undefined); assert.equal(recovered.state.revisions.filter(r => r.attemptId === work.id).length, 1);
  assert.equal(budgetView(recovered.state).spent.tokens, 250); assert.equal(budgetView(recovered.state).spent.attempts, 1);
});

test('CLI answer dispatches validated state machinery and resume continues the same attempt', async t => {
  const { store, root, work } = await pausedQuestion(t); const dir = store.dir; store.close();
  const file = join(root, 'answer.json'); writeFileSync(file, JSON.stringify(answer));
  const { backend } = recoveryBackend();
  await runCli(['answer', dir, work.id, file], { backend });
  const answered = new RunStore(dir); assert.equal(answered.state.status, 'paused'); assert.equal(budgetView(answered.state).spent.attempts, 1);
  await runCli(['resume', dir]);
  const done = new RunStore(dir); assert.equal(done.state.outcome, 'goal_met'); assert.equal(budgetView(done.state).spent.attempts, 1);
});

test('live continuation and reconciliation require a valid, separately attested runtime gate', t => {
  const { config } = setup(t);
  config.backend = { kind: 'muse', binary: '/never-launched', compatibilityLock: join(process.cwd(), 'examples/muse-lock.template.json') };
  const backend = new MuseBackend();
  assert.throws(() => backend.checkOperation('answer', config)); assert.throws(() => backend.checkOperation('reconcile', config));
});

test('read-only reconciliation stays available after the wall deadline, while answering cannot spend past it', async t => {
  const { store, work } = await pausedQuestion(t); const { backend, hosts } = recoveryBackend({ terminal: true });
  store.state.deadline = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer), /wall time/);
  assert.equal(hosts.length, 0);
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.state, 'settled'); assert.equal(budgetView(store.state).spent.attempts, 1);
});

test('an inconclusive read cannot erase an uncertain answer or authorize a duplicate', async t => {
  const { store, work } = await pausedQuestion(t); const lost = recoveryBackend({ disconnectAnswer: true });
  await new Scheduler(store, new AbortController().signal, lost.backend).recoverBackend(work.id, 'answer', answer);
  const commandId = store.state.works[work.id]!.pendingAnswer!.commandId;
  const inspector = recoveryBackend();
  await new Scheduler(store, new AbortController().signal, inspector.backend).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.pendingAnswer!.commandId, commandId);
  await assert.rejects(new Scheduler(store, new AbortController().signal, inspector.backend).recoverBackend(work.id, 'answer', answer), /earlier answer is uncertain/);
});

test('concurrent pending questions remain separate and can be reconciled one work at a time', async t => {
  const { store } = setup(t, 'repair', c => { c.strategy = { name: 'best-of-n', n: 2 }; c.budget.maxConcurrency = 2; });
  await runController(store, { backend: { execute: request => {
    const host = new SimulatedMuseHost({ onTurn: h => { h.usage(80); h.question(); } });
    host.sessionId = `simulated-session-${request.work.index}`;
    return executeMuseProtocol(request, { ...protocolExpectation, questionContinuationVerified: true }, host.factory);
  } } });
  assert.equal(Object.keys(store.state.backendInputs!).length, 2);
  const works = Object.values(store.state.works).filter(w => w.kind === 'attempt');
  const { backend } = recoveryBackend({ terminal: true });
  for (const [index, work] of works.entries()) {
    writeFileSync(join(work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }');
    await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
    assert.equal(Object.keys(store.state.backendInputs!).length, 1 - index);
  }
  assert.equal(store.state.backendInput, undefined); assert.equal(budgetView(store.state).spent.tokens, 500);
  await runController(store); assert.equal(store.state.outcome, 'goal_met'); assert.equal(budgetView(store.state).spent.attempts, 2);
});

test('CLI reconcile performs observation and permits a later ordinary resume', async t => {
  const { store, work } = await pausedQuestion(t); const dir = store.dir;
  writeFileSync(join(work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }'); store.close();
  const { backend } = recoveryBackend({ terminal: true, tokens: 600 });
  await runCli(['reconcile', dir, work.id], { backend });
  const reconciled = new RunStore(dir); assert.equal(reconciled.state.status, 'paused'); assert.equal(budgetView(reconciled.state).spent.tokens, 600);
  await runCli(['resume', dir]); assert.equal(new RunStore(dir).state.outcome, 'goal_met');
});

test('continuation preserves a subsequent question and can answer it without restarting the turn', async t => {
  const { store, work } = await pausedQuestion(t);
  const first = recoveryBackend({ nextQuestion: true, tokens: 300 });
  await new Scheduler(store, new AbortController().signal, first.backend).recoverBackend(work.id, 'answer', answer);
  assert.equal(store.state.works[work.id]!.state, 'unknown');
  assert.equal(store.state.works[work.id]!.operation!.state, 'completed'); assert.equal(store.state.works[work.id]!.pendingAnswer, undefined);
  assert.match(store.get(store.state.backendInput!.artifact).toString(), /next-question/);
  const second = recoveryBackend({ userInputId: 'next-question', tokens: 500 });
  await new Scheduler(store, new AbortController().signal, second.backend).recoverBackend(work.id, 'answer', { ...answer, userInputId: 'next-question' });
  assert.equal(store.state.status, 'paused'); assert.equal(budgetView(store.state).spent.tokens, 500);
  assert.equal(budgetView(store.state).spent.attempts, 1);
  assert.equal([...first.hosts, ...second.hosts].flatMap(host => host.frames).some(frame => frame.method === 'turn/start'), false);
});

test('continuation confirms explicit settings and refuses a changed model or effort', async t => {
  for (const options of [{}, { model: 'wrong-model' }, { effort: 'low' }]) {
    const { store, work } = await pausedQuestion(t, c => { c.agent = { model: { kind: 'explicit', providerId: 'sim-provider', modelId: 'sim-model' }, effort: { kind: 'explicit', value: 'high' } }; });
    const { backend, hosts } = recoveryBackend(options);
    await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer);
    const changed = 'model' in options || 'effort' in options;
    assert.equal(hosts.flatMap(host => host.frames).some(frame => frame.method === 'userInput/answer'), !changed);
    assert.equal(store.state.status, changed ? 'needs_attention' : 'paused');
  }
});

test('continuation without fresh usage keeps historical totals as a liability, never final spend', async t => {
  const { store, work } = await pausedQuestion(t);
  const { backend } = recoveryBackend({ noFreshUsage: true, tokens: 2600 });
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'answer', answer);
  assert.equal(store.state.status, 'needs_attention');
  assert.equal(store.state.works[work.id]!.actual!.tokens, null);
  assert.equal(store.state.works[work.id]!.observedTokens, 2600);
  assert.equal(budgetView(store.state).unknown.tokens, 2600);
  const calls = Object.values(store.state.works).filter(w => w.kind === 'attempt').length;
  await runController(store); assert.equal(Object.values(store.state.works).filter(w => w.kind === 'attempt').length, calls);
});

test('reconciliation refuses conflicting terminal evidence instead of promoting the last frame', async t => {
  const { store, work } = await pausedQuestion(t);
  const { backend } = recoveryBackend({ terminal: true, conflictingTerminals: true });
  await new Scheduler(store, new AbortController().signal, backend).recoverBackend(work.id, 'reconcile');
  assert.equal(store.state.works[work.id]!.state, 'unknown');
  assert.equal(store.state.revisions.some(r => r.attemptId === work.id), false);
});
