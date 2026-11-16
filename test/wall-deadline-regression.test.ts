// New offline regressions only. No public benchmark tasks or provider access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { wallDeadline } from '../src/time.js';
import { runProcess } from '../src/process.js';
import { runController } from '../src/controller.js';
import { prepareComparison, runComparisonArm } from '../src/comparison.js';
import { startMuseGateway } from '../src/muse-gateway.js';
import { setup } from './support.js';

function jumpClock(t: Parameters<typeof setup>[0]) {
  const now = Date.now.bind(Date); let offset = 0;
  t.mock.method(Date, 'now', () => now() + offset);
  return (milliseconds: number) => { offset += milliseconds; };
}

test('wall regression: watchdog expires after wall clock jump without spending the remaining timer delay', async t => {
  const jump = jumpClock(t);
  const deadline = wallDeadline(Date.now() + 60_000, Error('wall expired'));
  t.after(deadline.dispose);
  jump(61_000);
  await delay(150);
  assert.equal(deadline.signal.aborted, true);
  assert.match(String(deadline.signal.reason), /wall expired/);
  const expired = wallDeadline(Date.now() - 1, Error('already expired'));
  assert.equal(expired.signal.aborted, true); expired.dispose();
});

test('wall regression: a local worker stops promptly after simulated sleep and retains timeout evidence', async t => {
  const jump = jumpClock(t);
  const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), timeoutMs: 60_000, graceMs: 10 });
  jump(61_000);
  const result = await pending;
  assert.equal(result.timedOut, true); assert.equal(result.stopped, true);
  assert.ok(result.seconds >= 61);
});

test('wall regression: run deadline cancels an active attempt after simulated sleep and prevents another attempt', async t => {
  const jump = jumpClock(t); const { store } = setup(t);
  let attempts = 0;
  const state = await runController(store, { backend: { execute: async request => {
    attempts++; jump(700_000);
    await new Promise<void>(resolve => {
      request.signal.addEventListener('abort', () => resolve(), { once: true });
      if (request.signal.aborted) resolve();
    });
    return { outcome: 'cancelled', stopped: true, tokens: 0, proposal: '', hypotheses: [], receipt: {} };
  } } });
  assert.equal(attempts, 1); assert.equal(state.status, 'cancelled');
  assert.ok(Object.values(state.works).every(w => w.state === 'settled'));
});

test('wall regression: a timed-out evaluator stops the comparison before the next case', async t => {
  const { config, root } = setup(t, 'repair', (config, root) => {
    const trusted = join(root, 'trusted-new'); mkdirSync(trusted);
    const script = join(trusted, 'slow.mjs'); writeFileSync(script, 'setInterval(() => {}, 1000);');
    const definition = join(trusted, 'slow.json'); writeFileSync(definition, JSON.stringify({ schemaVersion: 1, script: 'slow.mjs', files: [], seed: 0 }));
    config.task.evaluators[0]!.definition.path = definition;
    config.task.evaluators[0]!.timeoutSeconds = 0.05;
  });
  const file = join(root, 'config.json'); writeFileSync(file, JSON.stringify(config));
  const second = structuredClone(config); second.task.goal += ' Separate independent fixture.';
  const secondFile = join(root, 'second.json'); writeFileSync(secondFile, JSON.stringify(second));
  const suite = join(root, 'suite.json'); writeFileSync(suite, JSON.stringify({ schemaVersion: 1, dataset: 'new-offline-regression', datasetRevision: '1', armSeconds: 120, taskSeconds: 60, taskTokens: 3000, searchAttempts: 3,
    cases: [{ id: 'first', config: file }, { id: 'second', config: secondFile }] }));
  const output = join(root, 'comparison'); prepareComparison(suite, output); await runComparisonArm(output, 'new');
  const job = JSON.parse(readFileSync(join(output, 'new/job.json'), 'utf8'));
  assert.equal(job.trials.length, 1); assert.match(job.trials[0].error, /Evaluator timed out/);
});

test('wall regression: unknown billing notifies the campaign and stops further upstream dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-wall-regression-'));
  let calls = 0; const abort = new AbortController();
  const gateway = await startMuseGateway({ key: 'offline-test-key', ledgerFile: join(root, 'ledger.json'), signal: abort.signal,
    onUnknown: id => abort.abort(Error(`Unknown request ${id}`)), fetcher: async url => {
      calls++;
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } }] });
      return Response.json({ status: 'completed' }); // No billable usage evidence.
    } });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url + '/muse-code/models', { headers })).text();
  const request = () => fetch(gateway.url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'muse-wonder-1.0', input: 'offline fixture' }) });
  await (await request()).text();
  assert.equal(abort.signal.aborted, true);
  assert.equal(gateway.ledger.snapshot().entries[0]!.state, 'unknown');
  const blocked = await request(); await blocked.text(); assert.equal(blocked.status, 403); assert.equal(calls, 2);
  const event = gateway.events.find(e => e.requestId === 1)!;
  assert.ok(event.startedAt); assert.ok(event.finishedAt); assert.ok(event.upstreamAt);
});

test('wall regression: a stalled upstream stream expires after simulated sleep and keeps its full reserve', async t => {
  const jump = jumpClock(t);
  const root = mkdtempSync(join(tmpdir(), 'gateway-timeout-regression-'));
  let unknownId: number | undefined;
  const gateway = await startMuseGateway({ key: 'offline-only-key', ledgerFile: join(root, 'ledger.json'), onUnknown: id => { unknownId = id; }, fetcher: async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } }] });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
      jump(181_000);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url + '/muse-code/models', { headers })).text();
  await assert.rejects(async () => (await fetch(gateway.url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'muse-wonder-1.0', input: 'offline' }) })).text());
  assert.equal(unknownId, 1);
  const entry = gateway.ledger.snapshot().entries[0]!;
  assert.equal(entry.state, 'unknown'); assert.equal(entry.reservedUsd, 7); assert.equal(entry.chargedUsd, undefined);
  assert.match(gateway.events.at(-1)!.error!, /response wall timeout/);
  assert.throws(() => gateway.ledger.reserve(), /Unsettled/);
});
