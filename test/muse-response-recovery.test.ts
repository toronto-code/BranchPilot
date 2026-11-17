import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMuseGateway } from '../src/muse-gateway.js';
import { recoverMuseResponse } from '../src/muse-response-recovery.js';
import { withMuseProviderUsage } from '../src/muse-provider-usage.js';
import { setup } from './support.js';
import type { BackendRequest } from '../src/backend.js';

const catalog = () => Response.json({ data: [{ id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } }] });
const body = JSON.stringify({ model: 'muse-wonder-1.0', input: 'offline recovery test', stream: true, store: false });
const completed = { id: 'resp_recover', model: 'muse-wonder-1.0', status: 'completed', usage: { input_tokens: 1000, output_tokens: 100 } };

for (const loss of ['exception', 'early-eof']) test(`stored response recovery settles ${loss} without another generation POST`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-recover-')); let posts = 0, reads = 0, catalogs = 0, unknown = 0;
  const gateway = await startMuseGateway({ key: 'offline-only', ledgerFile: join(root, 'ledger.json'), recoverResponses: true,
    onUnknown: () => { unknown++; }, fetcher: async (url, init) => {
      if (String(url).endsWith('/models')) { if (++catalogs === 1) throw Error('transient catalog outage'); return catalog(); }
      if (init?.method === 'GET') { reads++; return reads === 1 ? new Response('', { status: 404 }) : Response.json(completed); }
      posts++; assert.equal(JSON.parse(String(init?.body)).store, true);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_recover"}}\n\n'));
        setTimeout(() => { if (loss === 'exception') controller.error(Error('lost network')); else controller.close(); }, 10);
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url+'/muse-code/models', { headers })).text();
  await assert.rejects(async () => (await fetch(gateway.url+'/responses', { method: 'POST', headers, body })).text());
  await gateway.drain();
  assert.equal(posts, 1); assert.equal(reads, 2); assert.equal(catalogs, 2); assert.equal(unknown, 0);
  assert.equal(gateway.ledger.snapshot().entries[0]!.chargedUsd, 0.006);
  assert.equal(gateway.ledger.snapshot().entries[0]!.settlementSource, 'retrieval');
  assert.equal(gateway.events.at(-1)!.billingRecovered, true);
  assert.equal(gateway.events.at(-1)!.terminal, false); // No fabricated stream completion.
});

test('an uncertain POST with no response identity is never replayed or treated as free', async t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-recover-')); let posts = 0, reads = 0;
  const gateway = await startMuseGateway({ key: 'offline-only', ledgerFile: join(root, 'ledger.json'), recoverResponses: true, fetcher: async (url, init) => {
    if (String(url).endsWith('/models')) return catalog();
    if (init?.method === 'GET') { reads++; return Response.json(completed); }
    posts++; throw Error('connection lost before headers');
  } });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url+'/muse-code/models', { headers })).text();
  for (let i = 0; i < 2; i++) await (await fetch(gateway.url+'/responses', { method: 'POST', headers, body })).text();
  assert.equal(posts, 1); assert.equal(reads, 0);
  const entry = gateway.ledger.snapshot().entries[0]!;
  assert.equal(entry.state, 'unknown'); assert.equal(entry.reservedUsd, 7); assert.equal(entry.chargedUsd, undefined);
});

test('retrieval refuses wrong identities, models, missing usage, and expired recovery', async () => {
  for (const data of [{ ...completed, id: 'resp_foreign' }, { ...completed, model: 'other-model' }, { ...completed, usage: undefined },
    { ...completed, usage: { input_tokens: 0, output_tokens: 0 } }]) {
    const recovered = await recoverMuseResponse({ key: 'offline-only', responseId: completed.id, signal: new AbortController().signal, fetcher: async () => Response.json(data) });
    assert.equal(recovered, undefined);
  }
  let calls = 0;
  assert.equal(await recoverMuseResponse({ key: 'offline-only', responseId: completed.id, signal: AbortSignal.abort(), fetcher: async () => { calls++; return Response.json(completed); } }), undefined);
  assert.equal(calls, 0);
});

test('a cancelled host cannot finalize zero usage or start another task before provider settlement', async t => {
  const { store } = setup(t); const providerRoot = mkdtempSync(join(tmpdir(), 'muse-provider-')); let finish!: () => void; let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const gateway = await startMuseGateway({ key: 'offline-only', ledgerFile: join(providerRoot, 'provider-ledger.json'), fetcher: async url => {
    if (String(url).endsWith('/models')) return catalog();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      finish = () => { controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({ type: 'response.completed', response: completed })+'\n\n')); controller.close(); };
      started();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(async () => { await gateway.close(); rmSync(providerRoot, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url+'/muse-code/models', { headers })).text();
  const backend = withMuseProviderUsage({ execute: async () => {
    const response = await fetch(gateway.url+'/responses', { method: 'POST', headers, body }); await response.body!.cancel();
    return { outcome: 'cancelled', tokens: 0, stopped: true, proposal: '', hypotheses: [], receipt: {} };
  } }, gateway);
  const request = { config: store.state.config, record: () => undefined } as unknown as BackendRequest;
  let resolved = false; const pending = backend.execute(request).then(r => { resolved = true; return r; });
  await admitted; assert.equal(resolved, false); assert.equal(gateway.ledger.snapshot().entries[0]!.state, 'reserved');
  finish(); const result = await pending;
  assert.equal(result.tokens, 1100); assert.equal(result.usageSource, 'provider_reported');
  assert.equal(result.stopped, true); assert.equal(result.outcome, 'cancelled');
});
