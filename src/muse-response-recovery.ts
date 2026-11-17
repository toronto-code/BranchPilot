import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { checkCancellation, combineSignals } from './time.js';

const responseSchema = z.object({ id: z.string(), model: z.literal('muse-wonder-1.0'),
  status: z.enum(['completed', 'incomplete', 'failed', 'cancelled']),
  usage: z.object({ input_tokens: z.number().int().nonnegative().max(1_048_576),
    output_tokens: z.number().int().nonnegative().max(131_072) }).passthrough(),
}).passthrough().refine(r => r.usage.input_tokens + r.usage.output_tokens > 0);

async function boundedJSON(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (response.body) for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 32 * 1024 * 1024) throw Error('Response recovery evidence limit reached');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Retrieves an already-created response only. No generation POST is retried.
 * Poll briefly for persistence lag or a transient outage, within the original
 * response deadline. A 404, missing usage or wrong identity never clears cost. */
export async function recoverMuseResponse(options: { key: string; responseId: string; signal: AbortSignal; fetcher: typeof fetch }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      checkCancellation(options.signal);
      if (attempt) await delay(250 * 2 ** (attempt - 1), undefined, { signal: options.signal });
      const response = await options.fetcher(`https://api.meta.ai/v1/responses/${encodeURIComponent(options.responseId)}`, {
        method: 'GET', headers: { authorization: `Bearer ${options.key}`, accept: 'application/json' }, redirect: 'error',
        signal: combineSignals([options.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) { await response.body?.cancel(); if (![404, 408, 429, 500, 502, 503, 504].includes(response.status)) return; continue; }
      const data = await boundedJSON(response);
      if (data && typeof data === 'object' && ('id' in data && data.id !== options.responseId || 'model' in data && data.model !== 'muse-wonder-1.0')) return;
      const parsed = responseSchema.safeParse(data);
      if (parsed.success && parsed.data.id === options.responseId) return parsed.data;
      if (data && typeof data === 'object' && 'status' in data && ['completed', 'incomplete', 'failed', 'cancelled'].includes(String(data.status))) return;
    } catch { if (options.signal.aborted) return; }
  }
}

export async function fetchMuseCatalog(options: { key: string; signal: AbortSignal; fetcher: typeof fetch; accept: string }) {
  for (let attempt = 0; ; attempt++) {
    try {
      checkCancellation(options.signal);
      const response = await options.fetcher('https://api.meta.ai/muse-code/models', { method: 'GET',
        headers: { authorization: `Bearer ${options.key}`, accept: options.accept, 'content-type': 'application/json' },
        redirect: 'error', signal: options.signal });
      if (attempt === 2 || ![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel();
    } catch (error) { if (attempt === 2 || options.signal.aborted) throw error; }
    await delay(100 * 2 ** attempt, undefined, { signal: options.signal });
  }
}
