import type { Backend } from './backend.js';

interface ProviderAccounting {
  drain(): Promise<void>;
  ledger: { snapshot(): { entries: { id: number; state: string; inputTokens?: number; outputTokens?: number }[] } };
}

/** The benchmark runs hosts sequentially. Drain each owned host's admitted
 * requests before its usage is final or another task is allowed to start.
 * A cancelled host's session totals can omit its last in-flight response. */
export function withMuseProviderUsage(backend: Backend, accounting: ProviderAccounting): Backend {
  return { execute: async request => {
    if (request.config.budget.maxConcurrency !== 1) throw Error('Provider usage reconciliation requires sequential hosts');
    const first = accounting.ledger.snapshot().entries.length;
    const result = await backend.execute(request);
    await accounting.drain();
    const entries = accounting.ledger.snapshot().entries.slice(first);
    const complete = entries.every(e => e.state === 'settled' && e.inputTokens !== undefined && e.outputTokens !== undefined);
    const tokens = entries.reduce((n, e) => n + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);
    const consistent = complete && tokens >= Math.max(result.tokens ?? 0, result.observedTokens ?? 0);
    request.record('muse.provider_usage', { entries, requestIds: entries.map(e => e.id), providerTokens: tokens,
      hostTokens: result.tokens, complete, consistent });
    return { ...result, tokens: consistent ? tokens : null, usageSource: consistent ? 'provider_reported' : 'missing',
      observedTokens: Math.max(tokens, result.observedTokens ?? 0, result.tokens ?? 0),
      ...(!complete ? { stopped: false, outcome: 'unknown' as const } : {}),
      receipt: { hostReceipt: result.receipt, providerUsage: { requestIds: entries.map(e => e.id), tokens, complete, consistent } },
    };
  } };
}
