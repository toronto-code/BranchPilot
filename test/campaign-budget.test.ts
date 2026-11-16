import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMuseCadAdmission, campaignHistoryDigest, inspectMuseCadBudget, loadMuseCadBudget, type MuseCadBudget } from '../src/campaign-budget.js';
import { MuseSpendLedger } from '../src/muse-gateway.js';

const policy = (ledgerFile = '/unused'): MuseCadBudget => ({ schemaVersion: 1, currency: 'CAD', limitCad: 50,
  cadPerUsd: '1.75', validUntil: '9999-01-01T00:00:00Z', ledgerFile,
  priorEntries: 0, priorEntriesSha256: campaignHistoryDigest([]) });

test('CAD accounting rounds up cents and retains the entire unknown liability', () => {
  const entries = [{ state: 'settled' as const, reservedUsd: 7, chargedUsd: 21.143480 },
    { state: 'unknown' as const, reservedUsd: 7, chargedUsd: 0.01 }];
  const report = inspectMuseCadBudget(policy(), entries);
  assert.equal(report.committedUsd, 28.143480);
  assert.equal(report.committedCad, 49.26);
  assert.equal(report.remainingCad, 0.74);
  assert.equal(report.projectedCad, 61.51);
  assert.equal(report.canDispatch, false);
  assert.throws(() => assertMuseCadAdmission(policy(), entries), /Unsettled/);
  assert.equal(inspectMuseCadBudget(policy(), [{ state: 'settled', reservedUsd: 7, chargedUsd: 0.000001 }], 0).committedCad, 0.01);
});

test('a frozen history cannot be truncated or have old charges rewritten', () => {
  const entries = [{ state: 'settled' as const, reservedUsd: 7, chargedUsd: 1 }];
  const frozen = { ...policy(), priorEntries: 1, priorEntriesSha256: campaignHistoryDigest(entries) };
  assert.throws(() => inspectMuseCadBudget(frozen, []), /history differs/);
  assert.throws(() => inspectMuseCadBudget(frozen, [{ ...entries[0]!, chargedUsd: 0 }]), /history differs/);
  assert.equal(inspectMuseCadBudget(frozen, [...entries, { state: 'settled', reservedUsd: 7, chargedUsd: 0.5 }]).committedUsd, 1.5);
});

test('budget policy binds the existing ledger and rejects stale or invalid conversion ceilings', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-cad-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'budget.json'), ledger = join(root, 'ledger.json'), other = join(root, 'other.json');
  writeFileSync(ledger, '{}'); writeFileSync(other, '{}');
  writeFileSync(file, JSON.stringify({ ...policy('ledger.json') }));
  assert.equal(loadMuseCadBudget(file, ledger).ledgerFile, realpathSync(ledger));
  assert.throws(() => loadMuseCadBudget(file, other), /different campaign/);
  assert.throws(() => assertMuseCadAdmission({ ...policy(), validUntil: '2000-01-01T00:00:00Z' }, []), /expired/);
  assert.equal(inspectMuseCadBudget({ ...policy(), validUntil: '2026-11-13T12:00:00Z' }, [], 7, Date.parse('2026-11-13T12:00:00Z')).canDispatch, false);
  for (const cadPerUsd of ['0', '-1', 'NaN', '1.0000001']) assert.throws(() => inspectMuseCadBudget({ ...policy(), cadPerUsd }, []));
  assert.throws(() => inspectMuseCadBudget({ ...policy(), limitCad: 51 } as unknown as MuseCadBudget, []));
});

test('CAD admission blocks a request allowed by the older USD limit, including after reopening', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-cad-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(realpathSync(root), 'ledger.json'); const cad = policy(file);
  const ledger = new MuseSpendLedger(file, 40, cad);
  for (let i = 0; i < 4; i++) ledger.settle(ledger.reserve(), { input_tokens: 1_000_000, output_tokens: 100_000 });
  assert.equal(ledger.snapshot().entries.reduce((n, e) => n + e.chargedUsd!, 0), 24);
  assert.throws(() => ledger.reserve(), /CAD \$50/);
  ledger.close();
  const before = readFileSync(file);
  assert.throws(() => new MuseSpendLedger(file, 40, cad), /CAD \$50/);
  assert.deepEqual(readFileSync(file), before);
  // Rejected construction must release its lock.
  const legacy = new MuseSpendLedger(file); legacy.close();
});

test('an expired conversion ceiling blocks the next dispatch in an already open ledger', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-cad-'));
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const file = join(realpathSync(root), 'ledger.json');
  const ledger = new MuseSpendLedger(file, 40, { ...policy(file), validUntil: new Date(now + 1000).toISOString() });
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  ledger.settle(ledger.reserve(), { input_tokens: 1000, output_tokens: 100 });
  t.mock.method(Date, 'now', () => now + 1000);
  assert.throws(() => ledger.reserve(), /expired/);
  assert.equal(ledger.snapshot().entries.length, 1);
});

test('credits offset cash only while frozen historical uncertainty retains its full reserve', () => {
  const entries = [{ state: 'settled' as const, reservedUsd: 7, chargedUsd: 4 }, { state: 'unknown' as const, reservedUsd: 7 }];
  const funded = { ...policy(), priorEntries: 2, priorEntriesSha256: campaignHistoryDigest(entries),
    credits: { allowanceCad: 100, observedAt: '2026-11-13T00:00:00Z', evidenceFile: '/unused', evidenceSha256: 'a'.repeat(64), retainedUnknownIds: [2] } };
  const report = inspectMuseCadBudget(funded, entries);
  assert.equal(report.committedUsd, 11); assert.equal(report.committedCad, 19.25);
  assert.equal(report.cashCommittedCad, 0); assert.equal(report.projectedCashCad, 0);
  assert.equal(report.unsettled, 1); assert.equal(report.blockingUnsettled, 0); assert.equal(report.canDispatch, true);
  assert.throws(() => assertMuseCadAdmission(funded, [...entries, { state: 'unknown', reservedUsd: 7 }]), /Unsettled/);
  assert.throws(() => assertMuseCadAdmission(funded, [...entries, { state: 'reserved', reservedUsd: 7 }]), /Unsettled/);
  assert.throws(() => inspectMuseCadBudget({ ...funded, credits: { ...funded.credits, retainedUnknownIds: [3] } }, entries));
  const expensive = [...entries, ...Array.from({ length: 12 }, () => ({ state: 'settled' as const, reservedUsd: 7, chargedUsd: 6 }))];
  assert.throws(() => assertMuseCadAdmission(funded, expensive), /CAD \$50/);
});

test('credit evidence cannot silently change after a policy is prepared', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-credit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = join(root, 'ledger.json'), evidence = join(root, 'credits.txt'), budget = join(root, 'budget.json');
  writeFileSync(ledger, '{}'); writeFileSync(evidence, 'offline credit-balance fixture');
  writeFileSync(budget, JSON.stringify({ ...policy('ledger.json'), credits: { allowanceCad: 100, observedAt: '2026-11-13T00:00:00Z', evidenceFile: 'credits.txt',
    evidenceSha256: createHash('sha256').update(readFileSync(evidence)).digest('hex'), retainedUnknownIds: [] } }));
  assert.equal(loadMuseCadBudget(budget, ledger).credits!.allowanceCad, 100);
  writeFileSync(evidence, 'changed balance');
  assert.throws(() => loadMuseCadBudget(budget, ledger), /Credit balance evidence changed/);
});

test('migrated credit campaigns preserve all old liabilities and stop on any new uncertainty', t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-credit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(realpathSync(root), 'ledger.json');
  const entries = [{ id: 1, state: 'unknown' as const, reservedUsd: 7 }];
  const origin = { ledgerSha256: 'b'.repeat(64), entryCount: 1, entriesSha256: campaignHistoryDigest(entries) };
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, model: 'muse-wonder-1.0', limitUsd: 80, origin, entries }));
  const funded = { ...policy(file), priorEntries: 1, priorEntriesSha256: origin.entriesSha256,
    credits: { allowanceCad: 100, observedAt: '2026-11-13T00:00:00Z', evidenceFile: '/unused', evidenceSha256: 'a'.repeat(64), retainedUnknownIds: [1] } };
  assert.throws(() => new MuseSpendLedger(file, 80), /requires its CAD cash policy/);
  const ledger = new MuseSpendLedger(file, 80, funded);
  try {
    assert.equal(ledger.snapshot().entries[0]!.reservedUsd, 7);
    const id = ledger.reserve(); assert.equal(id, 2);
    ledger.settle(id, { input_tokens: 1000, output_tokens: 100 });
    assert.equal(ledger.blockingUnsettled().length, 0);
    ledger.unknown(ledger.reserve());
    assert.throws(() => ledger.reserve(), /Unsettled/);
  } finally { ledger.close(); }
});
