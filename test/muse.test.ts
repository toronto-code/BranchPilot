import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend, BackendRequest, BackendResult } from '../src/backend.js';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { id, RunStore } from '../src/store.js';
import type { Work } from '../src/types.js';
import { protocolExpectation, SimulatedMuseHost } from './muse-host.js';
import { setup } from './support.js';

async function simulate(t: TestContext, host: SimulatedMuseHost, options: { explicit?: boolean; abort?: AbortController; onRecord?: BackendRequest['record'] } = {}) {
  const { store } = setup(t);
  await runController(store, { pauseAfter: 0 });
  const config = structuredClone(store.state.config); config.budget.cancellationGraceSeconds = 0.02;
  config.budget.perAttempt.timeoutSeconds = 0.5;
  if (options.explicit) config.agent = { model: { kind: 'explicit', providerId: 'sim-provider', modelId: 'sim-model' }, effort: { kind: 'explicit', value: 'high' } };
  const base = store.state.revisions[0]!;
  const work: Work = { id: id(), kind: 'attempt', phase: 'search', revisionId: base.id, reservation: { tokens: 1000, workSeconds: 5, attempts: 1, experiments: 0 }, state: 'running', intent: '', workspace: join(store.dir, 'simulated'), index: 0, epoch: 0 };
  const records: { kind: string; data: unknown; identity?: unknown }[] = [];
  const result = await executeMuseProtocol({ config, work, base, prompt: 'Offline protocol test', signal: options.abort?.signal ?? new AbortController().signal, record: (kind, data, identity) => { records.push({ kind, data, identity }); options.onRecord?.(kind, data, identity); } }, protocolExpectation, host.factory);
  return { result, records, config, store };
}

function simulatedBackend(host: SimulatedMuseHost): Backend {
  return { execute: request => {
    request.record('muse.protocol_simulation', { simulated: true, liveCompatibility: 'unverified' });
    return executeMuseProtocol(request, protocolExpectation, host.factory);
  } };
}

test('SDK protocol simulation initializes, confirms explicit settings and captures stream and durable IDs', async t => {
  const host = new SimulatedMuseHost();
  const { result, records } = await simulate(t, host, { explicit: true });
  assert.equal(result.outcome, 'completed'); assert.equal(result.stopped, true); assert.equal(result.tokens, 123);
  assert.equal(host.closeCount, 1); assert.equal(host.initializeCount, 1);
  assert.ok(records.some(r => r.kind === 'muse.item'));
  assert.ok(records.some(r => r.kind === 'muse.session' && (r.identity as Work).sessionId === host.sessionId));
  assert.ok(records.some(r => r.kind === 'muse.turn' && (r.identity as Work).turnId === host.turnId));
  const prepared = records.find(r => r.kind === 'muse.command_prepared' && (r.data as { turnSubmission: boolean }).turnSubmission)!;
  const submitted = host.frames.find(f => f.method === 'turn/start')!;
  assert.deepEqual((prepared.data as { params: unknown }).params, submitted.params);
  assert.equal((prepared.identity as Work).commandId, submitted.params!.commandId);
  assert.deepEqual(host.frames.filter(f => f.method?.startsWith('session/set')).map(f => f.method), ['session/setModel', 'session/setReasoningEffort']);
  const start = host.frames.find(f => f.method === 'session/start')!;
  assert.equal(start.params!.permissionProfile, protocolExpectation.permissionProfile);
  assert.equal(start.params!.approvalMode, 'denyUnmatched');
});

for (const [name, options] of [
  ['fingerprint', { fingerprint: 'wrong' }], ['binary version', { version: 'wrong' }],
  ['permission profile', { permissionProfile: 'wrong' }], ['model readback', { readbackModel: 'wrong' }],
  ['effort readback', { effortReadback: false }], ['absent model', { models: [] }],
  ['unknown effort catalog', { models: [{ providerId: 'sim-provider', modelId: 'sim-model', isDefault: true, isActive: true, variants: 'unknown' }] }],
] as const) {
  test(`SDK protocol simulation rejects unconfirmed ${name} before turn submission`, async t => {
    const host = new SimulatedMuseHost(options);
    const { result } = await simulate(t, host, { explicit: true });
    assert.equal(result.outcome, 'failed'); assert.equal(result.tokens, 0); assert.equal(result.stopped, true);
    assert.equal(host.frames.some(f => f.method === 'turn/start'), false); assert.equal(host.closeCount, 1);
  });
}

test('SDK protocol simulation preserves host defaults with an empty catalog', async t => {
  const host = new SimulatedMuseHost({ models: [] });
  const { result } = await simulate(t, host);
  assert.equal(result.outcome, 'completed');
  assert.equal(host.frames.some(f => f.method?.startsWith('session/set')), false);
});

test('SDK protocol simulation denies an approval using only the offered denial', async t => {
  const host = new SimulatedMuseHost({ onTurn: h => h.approval() });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'completed');
  const decisions = host.frames.filter(f => f.method === 'approval/decide');
  assert.equal(decisions.length, 1); assert.equal(decisions[0]!.params!.choiceId, 'deny');
  assert.deepEqual(decisions[0]!.params!.requirementId, { approvalId: 'simulated-approval', sourceIndex: 0 });
  assert.ok(records.some(r => r.kind === 'muse.approval'));
});

test('SDK protocol simulation cancels after the host refuses the denial command', async t => {
  const host = new SimulatedMuseHost({
    onTurn: h => h.approval(),
    onRequest: (frame, h) => { if (frame.method === 'approval/decide') { h.reject(frame, -32052, 'invalidParams'); return true; } },
  });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'cancelled');
  assert.ok(records.some(r => r.kind === 'muse.approval_error'));
  assert.equal(host.frames.filter(f => f.method === 'turn/cancel').length, 1);
});

test('SDK protocol simulation records initialization refusal and closes without a turn', async t => {
  const host = new SimulatedMuseHost({ onRequest: (frame, h) => { if (frame.method === 'initialize') { h.reject(frame, -32000, 'unauthorized'); return true; } } });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'failed'); assert.equal(result.tokens, 0); assert.equal(result.stopped, true);
  assert.ok(records.some(r => r.kind === 'muse.error'));
  assert.equal(host.frames.some(f => f.method === 'session/start'), false);
  assert.equal(host.closeCount, 1);
});

test('SDK protocol simulation captures successive item revisions from the real SDK iterator', async t => {
  const host = new SimulatedMuseHost({ onTurn: h => {
    const item = { itemId: 'streamed', turnId: h.turnId, kind: 'assistantMessage', status: 'inProgress' };
    h.notify('item/started', { item: { ...item, revision: 1, text: '' } });
    setImmediate(() => {
      h.notify('item/updated', { item: { ...item, revision: 2, text: 'Partial' } });
      setImmediate(() => {
        h.notify('item/completed', { item: { ...item, revision: 3, status: 'completed', text: 'Finished' } });
        h.usage(); h.complete();
      });
    });
  } });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'completed');
  const items = records.filter(r => r.kind === 'muse.item').map(r => JSON.stringify(r.data));
  assert.ok(items.some(item => item.includes('Partial')));
  assert.ok(items.some(item => item.includes('Finished')));
});

test('SDK protocol simulation cancels when approval denial is unavailable', async t => {
  const host = new SimulatedMuseHost({ onTurn: h => h.approval(false) });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.stopped, true);
  assert.equal(host.frames.some(f => f.method === 'approval/decide'), false);
  assert.equal(host.frames.filter(f => f.method === 'turn/cancel').length, 1);
  assert.ok(records.some(r => r.kind === 'muse.approval_error'));
});

test('SDK protocol simulation preserves a pending question and cancels without answering', async t => {
  const host = new SimulatedMuseHost({ onTurn: h => h.question() });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.stopped, true);
  const question = records.find(r => r.kind === 'muse.input_required')!;
  assert.match(JSON.stringify(question.data), /simulated-question/);
  assert.equal(host.frames.some(f => f.method === 'userInput/answer'), false);
});

test('SDK protocol simulation captures a question even when a terminal beats the polling timer', async t => {
  const host = new SimulatedMuseHost({ onTurn: h => { h.question(); h.usage(); h.complete('cancelled'); } });
  const { records } = await simulate(t, host);
  assert.equal(records.filter(r => r.kind === 'muse.input_required').length, 1);
});

for (const value of [undefined, -1, '123', null, 1.5]) {
  test(`SDK protocol simulation keeps missing or invalid usage unknown (${String(value)})`, async t => {
    const host = new SimulatedMuseHost({ onTurn: h => { if (value !== undefined) h.usage(value); h.complete(); } });
    const { result } = await simulate(t, host);
    assert.equal(result.outcome, 'completed'); assert.equal(result.tokens, null);
  });
}

test('SDK protocol simulation cancellation requires a terminal beyond its acknowledgement', async t => {
  const abort = new AbortController();
  const host = new SimulatedMuseHost({ onTurn: () => undefined, onCancel: () => undefined });
  const { result, records } = await simulate(t, host, { abort, onRecord: kind => { if (kind === 'muse.turn') queueMicrotask(() => abort.abort()); } });
  assert.equal(host.frames.filter(f => f.method === 'turn/cancel').length, 1);
  assert.ok(records.some(r => r.kind === 'muse.cancel_ack'));
  assert.equal(result.outcome, 'unknown'); assert.equal(result.stopped, false); assert.equal(result.tokens, null);
  assert.equal(host.closeCount, 1);
});

test('SDK protocol simulation cancellation settles actual usage when terminal cancellation arrives', async t => {
  const abort = new AbortController();
  const host = new SimulatedMuseHost({ onTurn: () => undefined });
  const { result } = await simulate(t, host, { abort, onRecord: kind => { if (kind === 'muse.turn') queueMicrotask(() => abort.abort()); } });
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.stopped, true); assert.equal(result.tokens, 123);
});

test('SDK protocol simulation preserves completion that wins a cancellation race', async t => {
  const abort = new AbortController();
  const host = new SimulatedMuseHost({ onTurn: () => undefined, onCancel: h => { h.usage(); h.complete(); } });
  const { result, records } = await simulate(t, host, { abort, onRecord: kind => { if (kind === 'muse.turn') queueMicrotask(() => abort.abort()); } });
  assert.equal(result.outcome, 'completed'); assert.equal(result.tokens, 123);
  assert.ok(records.some(r => r.kind === 'muse.cancel_ack'));
});

test('SDK protocol simulation failed shutdown cannot prove terminal work stopped', async t => {
  const { result } = await simulate(t, new SimulatedMuseHost({ closeError: true }));
  assert.equal(result.stopped, false); assert.equal(result.tokens, 123);
});

test('SDK protocol simulation abort during submission retains uncertainty without a cancel acknowledgement', async t => {
  const abort = new AbortController();
  const host = new SimulatedMuseHost({ onRequest: (frame) => { if (frame.method === 'turn/start') { abort.abort(); return true; } } });
  const { result, records } = await simulate(t, host, { abort });
  assert.equal(result.outcome, 'unknown'); assert.equal(result.stopped, false);
  assert.equal(host.frames.filter(f => f.method === 'turn/start').length, 1);
  assert.ok(records.some(r => r.kind === 'muse.command_prepared' && (r.data as { turnSubmission: boolean }).turnSubmission));
  assert.equal(host.closeCount, 1);
});

test('SDK protocol simulation preserves turn identity learned before a lost acknowledgement', async t => {
  const host = new SimulatedMuseHost({ onRequest: (frame, h) => {
    if (frame.method !== 'turn/start') return;
    h.notify('turn/started', { turnId: 'host-assigned-turn', commandId: frame.params!.commandId });
    h.usage(1800); h.disconnect(); return true;
  } });
  const { result, records } = await simulate(t, host);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.tokens, 1800);
  assert.ok(records.some(r => r.kind === 'muse.turn_state' && (r.identity as Work).turnId === 'host-assigned-turn'));
});

for (const position of ['before-ack', 'after-ack'] as const) {
  test(`SDK protocol simulation disconnect ${position} preserves identities and never resubmits on recovery`, async t => {
    const { store } = setup(t); let persistedBeforeWrite = false;
    const host = new SimulatedMuseHost({
      onRequest: (frame, h) => {
        if (frame.method !== 'turn/start') return;
        const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
        persistedBeforeWrite = work.commandId === frame.params!.commandId;
        assert.equal(work.sessionId, h.sessionId);
        if (position === 'before-ack') { h.disconnect(); return true; }
      },
      onTurn: h => { h.usage(2300); h.disconnect(); },
    });
    await runController(store, { backend: simulatedBackend(host) });
    assert.equal(persistedBeforeWrite, true);
    assert.equal(store.state.status, 'needs_attention');
    const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
    assert.ok(work.commandId); assert.equal(work.sessionId, host.sessionId); assert.equal(work.state, 'unknown');
    if (position === 'after-ack') {
      assert.equal(work.turnId, host.turnId); assert.equal(work.actual?.tokens, 2300);
      assert.equal(budgetView(store.state).unknown.tokens, 2300);
    }
    const dir = store.dir; store.close();
    const recovered = new RunStore(dir, true); t.after(() => recovered.close());
    await runController(recovered, { backend: { execute: async () => { throw Error('Uncertain turn must not be repeated'); } } });
    assert.equal(recovered.state.status, 'needs_attention');
    assert.equal(host.frames.filter(f => f.method === 'turn/start').length, 1);
    assert.equal(Object.values(recovered.state.works).filter(w => w.kind === 'attempt').length, 1);
  });
}

test('SDK protocol simulation integrates real fixture edits, usage and an immutable evaluated revision', async t => {
  const { store, root } = setup(t);
  let host: SimulatedMuseHost | undefined;
  let result: BackendResult | undefined;
  await runController(store, { backend: { execute: async request => {
    const preparedHost = new SimulatedMuseHost({ onTurn: h => { writeFileSync(join(request.work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }'); h.item(); h.usage(321); h.complete(); } });
    host = preparedHost;
    result = await simulatedBackend(preparedHost).execute(request); return result;
  } } });
  assert.equal(result!.tokens, 321); assert.equal(store.state.outcome, 'goal_met');
  assert.equal(budgetView(store.state).spent.tokens, 321);
  assert.deepEqual(store.state.evaluations.map(e => e.validity), ['fail', 'pass']);
  assert.notEqual(store.state.revisions[0]!.snapshot, store.state.revisions[1]!.snapshot);
  assert.match(readFileSync(join(root, 'input/calculator.mjs'), 'utf8'), /a - b/);
  assert.equal(host!.initializeCount, 1); assert.equal(host!.closeCount, 1);
});

test('SDK protocol simulation leaves a durable backend question for the correct work and blocks resume', async t => {
  const { store } = setup(t);
  const host = new SimulatedMuseHost({ onTurn: h => h.question() });
  await runController(store, { backend: simulatedBackend(host) });
  assert.equal(store.state.status, 'needs_attention');
  const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  assert.equal(store.state.backendInput!.workId, work.id);
  assert.match(store.get(store.state.backendInput!.artifact).toString(), /simulated-question/);
  assert.equal(work.sessionId, host.sessionId); assert.equal(work.turnId, host.turnId);
  assert.equal(budgetView(store.state).spent.tokens, 123);
  await runController(store, { backend: { execute: async () => { assert.fail('Pending input must block new turns'); } } });
  assert.equal(host.frames.filter(f => f.method === 'turn/start').length, 1);
});

test('SDK protocol simulation missing usage prevents controller resume and candidate evaluation', async t => {
  const { store } = setup(t);
  const host = new SimulatedMuseHost({ onTurn: h => h.complete() });
  await runController(store, { backend: simulatedBackend(host) });
  assert.equal(store.state.status, 'needs_attention'); assert.equal(budgetView(store.state).unknown.tokens, 1000);
  assert.equal(store.state.evaluations.length, 1);
  await runController(store, { backend: { execute: async () => { assert.fail('Missing usage must block new turns'); } } });
  assert.equal(host.frames.filter(f => f.method === 'turn/start').length, 1);
});

for (const durability of ['ephemeral', 'unknown-future-profile']) {
  test(`SDK protocol simulation rejects ${durability} hosts before any model work`, async t => {
    const host = new SimulatedMuseHost({ durability, onTurn: h => { h.usage(1400); h.disconnect(); } });
    const { result } = await simulate(t, host);
    assert.equal(result.outcome, 'failed'); assert.equal(result.stopped, true); assert.equal(result.tokens, 0);
    assert.equal(host.frames.some(f => f.method === 'turn/start'), false);
  });
}
