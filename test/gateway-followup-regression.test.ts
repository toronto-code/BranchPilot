// Additional offline cases; no existing regression or public task is rerun.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MuseSpendLedger, startMuseGateway } from '../src/muse-gateway.js';
import { prepareComparison, runComparisonArm } from '../src/comparison.js';
import { setup } from './support.js';

const catalog = () => Response.json({ data: [{ id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } }] });
const terminal = 'data: '+JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 100 } } })+'\n\n';
const body = JSON.stringify({ model: 'muse-wonder-1.0', input: 'offline synthetic case', stream: true });
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); }
  assert.fail('offline condition failed to settle within one second');
}
async function makeGateway(t: Parameters<typeof setup>[0], fetcher: typeof fetch, onUnknown?: (id: number) => void) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-followup-'));
  const gateway = await startMuseGateway({ key: 'offline-private-key', ledgerFile: join(root, 'ledger.json'), fetcher, onUnknown });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url+'/muse-code/models', { headers })).text();
  return { root, gateway, headers, post: () => fetch(gateway.url+'/responses', { method: 'POST', headers, body }) };
}

test('follow-up: terminal billing survives upstream failure after its final usage frame', async t => {
  let unknown = 0; let paid = 0;
  const { gateway, post } = await makeGateway(t, async url => {
    if (String(url).endsWith('/models')) return catalog();
    paid++;
    if (paid > 1) return Response.json({ status: 'completed', usage: { input_tokens: 1000, output_tokens: 100 } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(terminal));
      setTimeout(() => controller.error(Error('lost EOF')), 30);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }, () => { unknown++; });
  const received = await (await post()).text();
  assert.equal(received, terminal); assert.equal(unknown, 0);
  assert.equal(gateway.ledger.snapshot().entries[0]!.chargedUsd, 0.006);
  assert.equal(gateway.events.at(-1)!.terminal, true); assert.match(gateway.events.at(-1)!.error!, /lost EOF/);
  await (await post()).text();
  assert.deepEqual(gateway.ledger.snapshot().entries.map(e => e.state), ['settled', 'settled']);
});

test('follow-up: gateway shutdown drops an unfinished local upload without upstream dispatch', async t => {
  let calls = 0;
  const { gateway, headers } = await makeGateway(t, async () => { calls++; return catalog(); });
  const upload = httpRequest(gateway.url+'/responses', { method: 'POST', headers: { ...headers, 'content-length': 9999 } });
  upload.on('error', () => undefined); upload.write('{');
  t.after(() => upload.destroy());
  await until(() => gateway.events.length === 2);
  const closed = gateway.close();
  const result = await Promise.race([closed.then(() => 'closed'), delay(1000).then(() => 'stuck')]);
  assert.equal(result, 'closed'); assert.equal(calls, 1);
  assert.equal(gateway.ledger.snapshot().entries.length, 0);
  await gateway.close();
});

test('follow-up: shutdown drains admitted billing while refusing an already queued successor', async t => {
  let finish: (() => void) | undefined; let paid = 0;
  t.after(() => finish?.());
  const { gateway, post } = await makeGateway(t, async url => {
    if (String(url).endsWith('/models')) return catalog();
    paid++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(terminal)); finish = () => { controller.close(); finish = undefined; };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const first = post().then(response => response.text()).catch(() => undefined);
  await until(() => gateway.ledger.snapshot().entries[0]?.state === 'settled');
  const queued = post().then(response => response.text()).catch(() => undefined);
  await until(() => gateway.events.length === 3);
  let closed = false;
  const close = gateway.close().then(() => { closed = true; });
  await delay(30); assert.equal(closed, false); assert.equal(paid, 1);
  finish!(); await close; await Promise.all([first, queued]);
  assert.equal(paid, 1); assert.equal(gateway.ledger.snapshot().entries.length, 1);
  assert.equal(gateway.ledger.snapshot().entries[0]!.state, 'settled');
});

test('follow-up: nonterminal SSE failure retains liability and ends the transport without injecting JSON', async t => {
  let notified = 0;
  const { gateway, post } = await makeGateway(t, async url => {
    if (String(url).endsWith('/models')) return catalog();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      setTimeout(() => controller.error(Error('offline stream lost')), 30);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }, () => { notified++; throw Error('offline-private-key notification failed'); });
  await assert.rejects(async () => (await post()).text());
  await until(() => Boolean(gateway.events.at(-1)?.finishedAt));
  assert.equal(notified, 1); assert.equal(gateway.events.at(-1)!.terminal, false);
  assert.ok(!gateway.events.at(-1)!.error!.includes('offline-private-key'));
  const { reservedAt, ...entry } = gateway.ledger.snapshot().entries[0]!;
  assert.ok(Number.isFinite(Date.parse(reservedAt!)));
  assert.deepEqual(entry, { id: 1, state: 'unknown', reservedUsd: 7 });
});

test('follow-up: provider identities are durable before stream failure and survive reopening', async t => {
  let breakStream: (() => void) | undefined;
  t.after(() => breakStream?.());
  const { root, gateway, post } = await makeGateway(t, async url => {
    if (String(url).endsWith('/models')) return catalog();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_offline_recovery"}}\n\n'));
      breakStream = () => { controller.error(Error('lost usage frame')); breakStream = undefined; };
    } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'offline-http-request' } });
  });
  const received = post().then(response => response.text());
  // Observe the rejection before deliberately breaking the stream.
  const rejected = assert.rejects(received);
  await until(() => gateway.ledger.snapshot().entries[0]?.providerResponseId === 'resp_offline_recovery');
  const file = join(root, 'ledger.json');
  const persisted = JSON.parse(readFileSync(file, 'utf8')).entries[0];
  assert.equal(persisted.state, 'reserved');
  assert.equal(persisted.providerRequestId, 'offline-http-request');
  assert.equal(persisted.providerResponseId, 'resp_offline_recovery');
  assert.ok(Number.isFinite(Date.parse(persisted.reservedAt)));
  breakStream!(); await rejected; await gateway.close();
  const reopened = new MuseSpendLedger(file);
  try {
    const entry = reopened.snapshot().entries[0]!;
    assert.equal(entry.providerResponseId, persisted.providerResponseId);
    assert.equal(entry.providerRequestId, persisted.providerRequestId);
    assert.equal(entry.state, 'unknown'); assert.equal(entry.reservedUsd, 7);
    assert.throws(() => reopened.reserve(), /Unsettled/);
  } finally { reopened.close(); }
});

test('follow-up: task setup time counts against its deadline before model dispatch', async t => {
  const { root, config } = setup(t);
  const configFile = join(root, 'config.json'); writeFileSync(configFile, JSON.stringify(config));
  const file = join(root, 'suite.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 1, dataset: 'offline-setup-time', datasetRevision: '1', armSeconds: 180, taskSeconds: 60, taskTokens: 3000, searchAttempts: 3, cases: [{ id: 'one', config: configFile }] }));
  const output = join(root, 'comparison'); prepareComparison(file, output);
  const jobFile = join(output, 'new/job.json'); const now = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => {
    const initialized = existsSync(jobFile) && JSON.parse(readFileSync(jobFile, 'utf8')).trials[0]?.runDirectory;
    return now() + (initialized ? 61_000 : 0);
  });
  await runComparisonArm(output, 'new');
  const job = JSON.parse(readFileSync(jobFile, 'utf8'));
  assert.match(job.trials[0].error, /Comparison task wall budget reached/);
  const state = JSON.parse(readFileSync(join(job.trials[0].runDirectory, 'state.json'), 'utf8')).state;
  assert.equal(Object.values(state.works).length, 0);
});
