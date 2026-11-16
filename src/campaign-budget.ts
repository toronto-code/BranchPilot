import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// The conversion ceiling includes exchange, taxes and payment fees. It is a
// conservative admission assumption, not a claim about a provider invoice.
const policySchema = z.object({
  schemaVersion: z.literal(1), currency: z.literal('CAD'), limitCad: z.literal(50),
  cadPerUsd: z.string().regex(/^[1-9]\d{0,2}(?:\.\d{1,6})?$/),
  validUntil: z.string().datetime({ offset: true }), ledgerFile: z.string().min(1),
  priorEntries: z.number().int().nonnegative(), priorEntriesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  credits: z.object({ allowanceCad: z.number().finite().positive(), observedAt: z.string().datetime(),
    evidenceFile: z.string().min(1), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    retainedUnknownIds: z.array(z.number().int().positive()).default([]),
  }).strict().optional(),
}).strict().superRefine((p, ctx) => {
  const ids = p.credits?.retainedUnknownIds ?? [];
  if (new Set(ids).size !== ids.length || ids.some(id => id > p.priorEntries)) ctx.addIssue({ code: 'custom', message: 'Only frozen historical unknown requests can retain a reserve without blocking a fresh run' });
  if (p.credits && Date.parse(p.credits.observedAt) >= Date.parse(p.validUntil)) ctx.addIssue({ code: 'custom', message: 'Credit evidence must precede the budget expiry' });
});
export type MuseCadBudget = z.infer<typeof policySchema>;
type Entry = { state: 'reserved' | 'settled' | 'unknown'; reservedUsd: number; chargedUsd?: number };

export function campaignHistoryDigest(entries: readonly Entry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function loadMuseCadBudget(file: string, ledgerFile: string): MuseCadBudget {
  const policy = policySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  policy.ledgerFile = realpathSync(resolve(dirname(file), policy.ledgerFile));
  if (policy.ledgerFile !== realpathSync(ledgerFile)) throw Error('CAD budget belongs to a different campaign ledger');
  if (policy.credits) {
    policy.credits.evidenceFile = realpathSync(resolve(dirname(file), policy.credits.evidenceFile));
    if (createHash('sha256').update(readFileSync(policy.credits.evidenceFile)).digest('hex') !== policy.credits.evidenceSha256) throw Error('Credit balance evidence changed');
  }
  return policy;
}

export function retainedHistoricalUnknown(policy: MuseCadBudget | undefined, index: number, entry: Entry): boolean {
  return entry.state === 'unknown' && index < (policy?.priorEntries ?? 0) && !!policy?.credits?.retainedUnknownIds.includes(index + 1);
}

function usdMicros(value: number): bigint {
  const micros = Math.round(value * 1_000_000);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(micros) || Math.abs(micros / 1_000_000 - value) > 1e-12) throw Error('Invalid campaign charge');
  return BigInt(micros);
}

/** Read-only accounting. Unknown/reserved work retains its entire reservation,
 * even if an incomplete record happens to contain a partial charge. */
export function inspectMuseCadBudget(raw: MuseCadBudget, entries: readonly Entry[], nextReservationUsd = 7, now = Date.now()) {
  const policy = policySchema.parse(raw);
  if (entries.length < policy.priorEntries || campaignHistoryDigest(entries.slice(0, policy.priorEntries)) !== policy.priorEntriesSha256) throw Error('Campaign history differs from the CAD budget; reconcile evidence before replacing it');
  const committed = entries.reduce((n, entry) => {
    if (entry.state === 'settled' && entry.chargedUsd === undefined) throw Error('Settled campaign entry is missing its charge');
    return n + usdMicros(entry.state === 'settled' ? entry.chargedUsd! : entry.reservedUsd);
  }, 0n);
  const [whole, fraction = ''] = policy.cadPerUsd.split('.');
  const rate = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const cents = (usd: bigint) => Number((usd * rate + 9_999_999_999n) / 10_000_000_000n);
  const committedCadCents = cents(committed);
  const projectedCadCents = cents(committed + usdMicros(nextReservationUsd));
  const creditCents = policy.credits ? Math.floor(policy.credits.allowanceCad * 100) : 0;
  if (!Number.isSafeInteger(creditCents)) throw Error('Invalid credit allowance');
  const cashCommittedCents = Math.max(0, committedCadCents - creditCents);
  const projectedCashCents = Math.max(0, projectedCadCents - creditCents);
  const expired = !Number.isFinite(now) || now >= Date.parse(policy.validUntil) || !!policy.credits && now < Date.parse(policy.credits.observedAt);
  const unsettled = entries.filter(e => e.state !== 'settled').length;
  const blockingUnsettled = entries.filter((e, i) => e.state !== 'settled' && !retainedHistoricalUnknown(policy, i, e)).length;
  return { currency: 'CAD' as const, limitCad: policy.limitCad, cadPerUsd: policy.cadPerUsd, validUntil: policy.validUntil,
    committedUsd: Number(committed) / 1_000_000, committedCad: committedCadCents / 100,
    creditAllowanceCad: creditCents / 100, cashCommittedCad: cashCommittedCents / 100,
    remainingCad: Math.max(0, 5000 - cashCommittedCents) / 100, nextReservationUsd,
    projectedCad: projectedCadCents / 100, projectedCashCad: projectedCashCents / 100, expired, unsettled, blockingUnsettled,
    canDispatch: !expired && blockingUnsettled === 0 && projectedCashCents <= 5000 };
}

export function assertMuseCadAdmission(policy: MuseCadBudget, entries: readonly Entry[], nextReservationUsd = 7): void {
  const budget = inspectMuseCadBudget(policy, entries, nextReservationUsd);
  if (budget.expired) throw Error('CAD conversion ceiling expired; verify current exchange, taxes and fees');
  if (budget.blockingUnsettled) throw Error('Unsettled provider work blocks further paid requests');
  if (!budget.canDispatch) throw Error(`CAD $50 campaign allowance cannot cover another request (projected cash CAD $${budget.projectedCashCad.toFixed(2)})`);
}
