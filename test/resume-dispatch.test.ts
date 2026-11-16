import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { checkCancellation, combineSignals, wallDeadline } from '../src/time.js';
import type { RunStore } from '../src/store.js';
import type { BackendRequest } from '../src/backend.js';
import { SimulatedMuseHost, protocolExpectation } from './muse-host.js';
import { setup } from './support.js';

function jumpClock(t: Parameters<typeof setup>[0]) {
  const now = Date.now.bind(Date); let offset = 0;
  t.mock.method(Date, 'now', () => now() + offset);
  return () => { offset += 700_000; };
}

test('resume dispatch: a nested cancellation scope checks its parent deadline synchronously', t => {
  const jump = jumpClock(t); const deadline = wallDeadline(Date.now() + 60_000, Error('Outer deadline'));
  t.after(deadline.dispose);
  const signal = combineSignals([new AbortController().signal, combineSignals([deadline.signal, new AbortController().signal])]);
  jump();
  assert.equal(signal.aborted, false); // No watchdog callback has run yet.
  assert.throws(() => checkCancellation(signal), /Outer deadline/);
  assert.equal(signal.aborted, true);
});

test('resume dispatch: expired run cannot start a backend before the watchdog timer fires', async t => {
  const { store } = setup(t); const jump = jumpClock(t);
  const append = store.append.bind(store);
  t.mock.method(store, 'append', (...events: Parameters<RunStore['append']>) => {
    append(...events);
    if (events.some(e => e.type === 'work.updated' && e.work.kind === 'attempt' && e.work.state === 'running')) jump();
  });
  let calls = 0;
  await runController(store, { backend: { execute: async () => {
    calls++;
    return { outcome: 'completed', stopped: true, tokens: 0, proposal: '', hypotheses: [], receipt: {} };
  } } });
  assert.equal(calls, 0);
  assert.equal(store.state.status, 'cancelled');
  assert.equal(budgetView(store.state).spent.attempts, 0);
  assert.equal(budgetView(store.state).unknown.tokens, 0);
});

for (const boundary of ['settings', 'intent']) test(`resume dispatch: expiry during ${boundary} recording cannot submit a model turn`, async t => {
  const { store } = setup(t); await runController(store, { pauseAfter: 0 });
  const jump = jumpClock(t); const deadline = wallDeadline(Date.now() + 60_000, Error('Model dispatch deadline'));
  t.after(deadline.dispose);
  const host = new SimulatedMuseHost(); const base = store.state.revisions[0]!;
  const request: BackendRequest = { config: store.state.config, base, signal: deadline.signal, prompt: 'Offline resume boundary probe',
    work: { id: 'resume-probe', kind: 'attempt', phase: 'search', state: 'running', revisionId: base.id,
      reservation: { tokens: 1000, workSeconds: 60, attempts: 1, experiments: 0 }, intent: '', workspace: join(store.dir, 'probe'), index: 0, epoch: 0 },
    record: (kind, data) => {
      if (boundary === 'settings' ? kind === 'muse.settings_confirmed'
        : kind === 'muse.command_prepared' && (data as { turnSubmission?: boolean }).turnSubmission) jump();
    } };
  const result = await executeMuseProtocol(request, protocolExpectation, host.factory);
  assert.equal(host.frames.some(f => f.method === 'turn/start'), false);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.tokens, 0);
  assert.equal(result.stopped, true);
});
