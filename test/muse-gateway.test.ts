import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MuseSpendLedger, validateMusePaidRequest, verifyMusePricing, startMuseGateway } from '../src/muse-gateway.js';

test('spending admission reserves before dispatch and refuses concurrent requests', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-spend-'));
  const ledger = new MuseSpendLedger(join(root, 'ledger.json'), 10); t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const id = ledger.reserve(); assert.equal(ledger.snapshot().entries[0]!.state, 'reserved');
  assert.throws(() => ledger.reserve(), /Unsettled/);
  ledger.settle(id, { input_tokens: 1_000_000, output_tokens: 100_000 });
  assert.equal(ledger.snapshot().entries[0]!.chargedUsd, 6);
  assert.throws(() => ledger.reserve(), /allowance/);
});

test('missing or impossible usage keeps liability and blocks paid retries after restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-spend-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, usage] of [undefined, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 5, output_tokens: 200_000 }, { input_tokens: 0, output_tokens: 0 }].entries()) {
    const file = join(root, `${index}.json`); const ledger = new MuseSpendLedger(file);
    ledger.settle(ledger.reserve(), usage); assert.equal(ledger.snapshot().entries[0]!.state, 'unknown'); ledger.close();
    const reopened = new MuseSpendLedger(file); assert.throws(() => reopened.reserve(), /Unsettled/); reopened.close();
  }
});

test('crashed reservations and simultaneous ledger owners cannot reset the campaign', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-spend-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'ledger.json'); const ledger = new MuseSpendLedger(file, 20);
  assert.throws(() => new MuseSpendLedger(file, 20)); ledger.reserve(); ledger.close();
  assert.throws(() => new MuseSpendLedger(file, 40), /cannot change/);
  const reopened = new MuseSpendLedger(file, 20); assert.throws(() => reopened.reserve(), /Unsettled/); reopened.close();
});

test('valid usage releases only the unused reservation, not the whole charge', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-spend-'));
  const ledger = new MuseSpendLedger(join(root, 'ledger.json')); t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const first = ledger.reserve(); ledger.settle(first, { input_tokens: 1000, output_tokens: 100 });
  assert.equal(ledger.snapshot().entries[0]!.chargedUsd, 0.006);
  assert.throws(() => ledger.settle(first, { input_tokens: 0, output_tokens: 0 }), /not awaiting/);
  assert.equal(ledger.reserve(), 2);
});

test('gateway permits frontier text/function requests and bounds output explicitly', () => {
  const body = validateMusePaidRequest({ model: 'muse-wonder-1.0', input: [{ role: 'user', content: 'Fix the bug' }], tools: [{ type: 'function', name: 'edit', parameters: {} }], stream: true });
  assert.equal(body.max_output_tokens, 131072);
  assert.doesNotThrow(() => validateMusePaidRequest({ model: 'muse-wonder-1.0', input: 'Fix', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'edit_file' }] }] }));
});

test('gateway refuses unpriced models, premium tiers, remote work, and separately billed tools', () => {
  const base = { model: 'muse-wonder-1.0', input: 'Fix the bug' };
  for (const extra of [
    { model: 'muse-spark-1.3' }, { service_tier: 'priority' }, { background: true },
    { max_output_tokens: 200_000 }, { tools: [{ type: 'web_search' }] },
    { tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'web_search' }] }] },
    { previous_response_id: 'previous' }, { conversation: 'remote' },
    { input: [{ type: 'input_image', image_url: 'https://example.com/image' }] },
  ]) assert.throws(() => validateMusePaidRequest({ ...base, ...extra }));
});

test('live catalog must confirm the selected model prices and maximum sizes', () => {
  const row = { id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } };
  assert.equal(verifyMusePricing({ data: [row, { id: 'image' }] }), true);
  assert.equal(verifyMusePricing({ data: [row, row] }), false);
  const changed = structuredClone(row); changed.metadata['muse-code'].cost.output = '30';
  assert.equal(verifyMusePricing({ data: [changed] }), false);
  assert.equal(verifyMusePricing({ data: [{ id: 'muse-wonder-1.0' }] }), false);
});

test('HTTP gateway authenticates locally, normalizes Muse paths, settles SSE usage, and blocks unpriced retries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-gateway-'));
  const calls: string[] = []; let missingUsage = false;
  const gateway = await startMuseGateway({ key: 'test-provider-secret', ledgerFile: join(root, 'ledger.json'), fetcher: async (url, init) => {
    calls.push(String(url)); assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-provider-secret');
    if (String(url).endsWith('/muse-code/models')) return Response.json({ data: [{ id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } }] });
    assert.equal(String(url), 'https://api.meta.ai/v1/responses');
    const frame = { type: 'response.completed', response: { usage: missingUsage ? undefined : { input_tokens: 1000, output_tokens: 100 } } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(frame)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await fetch(gateway.url + '/muse-code/models')).status, 401); assert.equal(calls.length, 0);
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url + '/muse-code/models', { headers })).text(); assert.equal(gateway.catalogReady(), true);
  const body = JSON.stringify({ model: 'muse-wonder-1.0', input: 'A local test', stream: true });
  const first = await fetch(gateway.url + '/responses', { method: 'POST', headers, body }); await first.text();
  assert.equal(first.status, 200); assert.equal(gateway.ledger.snapshot().entries[0]!.chargedUsd, 0.006);
  missingUsage = true;
  await (await fetch(gateway.url + '/v1/responses', { method: 'POST', headers, body })).text();
  assert.equal(gateway.ledger.snapshot().entries[1]!.state, 'unknown');
  const before = calls.length;
  const refused = await fetch(gateway.url + '/responses', { method: 'POST', headers, body }); await refused.text();
  assert.equal(refused.status, 403); assert.equal(calls.length, before);
  const other = await fetch(gateway.url + '/v1/images/generations', { method: 'POST', headers, body }); await other.text();
  assert.equal(other.status, 403); assert.equal(calls.length, before);
});

test('a following request waits for a disconnected predecessor to settle before admission', async t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-gateway-wait-'));
  let finish!: () => void; let started!: () => void; let paid = 0;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const gateway = await startMuseGateway({ key: 'test-key', ledgerFile: join(root, 'ledger.json'), fetcher: async url => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'muse-wonder-1.0', metadata: { 'muse-code': { cost: { currency: 'USD', input: '4', output: '20' }, limit: { context: 1007997, output: 128000 } } } }] });
    paid++;
    if (paid === 1) { started(); await new Promise<void>(resolve => { finish = resolve; }); }
    return Response.json({ status: 'completed', usage: { input_tokens: 1000, output_tokens: 100 } });
  } });
  t.after(async () => { finish?.(); await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  await (await fetch(gateway.url + '/muse-code/models', { headers })).text();
  const body = JSON.stringify({ model: 'muse-wonder-1.0', input: 'A test' });
  const abort = new AbortController();
  const first = fetch(gateway.url + '/responses', { method: 'POST', headers, body, signal: abort.signal }).catch(() => undefined);
  await admitted; abort.abort(); await first;
  const second = fetch(gateway.url + '/responses', { method: 'POST', headers, body });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(paid, 1);
  finish(); const result = await second; await result.text(); assert.equal(result.status, 200);
  assert.equal(paid, 2); assert.deepEqual(gateway.ledger.snapshot().entries.map(e => e.state), ['settled', 'settled']);
});
