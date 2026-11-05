import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './store.js';

// This deliberately supports only the observed Wonder text Responses endpoint.
// Prices are conservative: all input is charged at the uncached rate. No credit
// is reclaimed for failed, interrupted, or unpriced requests.
const MODEL = 'muse-wonder-1.0';
const RESERVATION_USD = 7;
const INPUT_LIMIT = 1_048_576;
const OUTPUT_LIMIT = 131_072;
const entrySchema = z.object({ id: z.number().int().positive(), state: z.enum(['reserved', 'settled', 'unknown']),
  reservedUsd: z.literal(RESERVATION_USD), chargedUsd: z.number().finite().nonnegative().max(RESERVATION_USD).optional(),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }).strict();
const ledgerSchema = z.object({ schemaVersion: z.literal(1), model: z.literal(MODEL), limitUsd: z.number().finite().positive().max(40),
  entries: z.array(entrySchema) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;

export class MuseSpendLedger {
  private ledger: Ledger;
  private readonly lock: string;
  constructor(private readonly file: string, limitUsd = 40) {
    mkdirSync(dirname(file), { recursive: true });
    this.lock = `${file}.lock`;
    writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      this.ledger = existsSync(file) ? ledgerSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : ledgerSchema.parse({ schemaVersion: 1, model: MODEL, limitUsd, entries: [] });
      if (this.ledger.limitUsd !== limitUsd) throw Error('A campaign limit cannot change when reopening its ledger');
      if (this.ledger.entries.some((e, i) => e.id !== i + 1 || (e.state === 'settled' && (e.chargedUsd === undefined || e.inputTokens === undefined || e.outputTokens === undefined)))) throw Error('Invalid campaign ledger');
      this.save();
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  private save() { atomicWrite(this.file, JSON.stringify(this.ledger, null, 2)); }
  snapshot() { return structuredClone(this.ledger); }
  reserve(): number {
    if (this.ledger.entries.some(e => e.state !== 'settled')) throw Error('Unsettled provider work blocks further paid requests');
    const committed = this.ledger.entries.reduce((n, e) => n + (e.chargedUsd ?? e.reservedUsd), 0);
    if (committed + RESERVATION_USD > this.ledger.limitUsd) throw Error('Campaign spending allowance cannot cover another request');
    const id = this.ledger.entries.length + 1;
    this.ledger.entries.push({ id, state: 'reserved', reservedUsd: RESERVATION_USD }); this.save(); return id;
  }
  settle(id: number, usage: unknown): void {
    const entry = this.ledger.entries.find(e => e.id === id);
    if (!entry || entry.state !== 'reserved') throw Error('Request is not awaiting settlement');
    const parsed = z.object({ input_tokens: z.number().int().nonnegative().max(INPUT_LIMIT), output_tokens: z.number().int().nonnegative().max(OUTPUT_LIMIT) }).safeParse(usage);
    if (!parsed.success || parsed.data.input_tokens + parsed.data.output_tokens === 0) { this.unknown(id); return; }
    const { input_tokens: input, output_tokens: output } = parsed.data;
    Object.assign(entry, { state: 'settled', chargedUsd: Math.ceil((input * 4 + output * 20)) / 1_000_000, inputTokens: input, outputTokens: output });
    this.save();
  }
  unknown(id: number) {
    const entry = this.ledger.entries.find(e => e.id === id);
    if (entry?.state === 'reserved') { entry.state = 'unknown'; this.save(); }
  }
  close() { unlinkSync(this.lock); }
}

export function validateMusePaidRequest(raw: unknown): Record<string, unknown> {
  const functionTool = z.object({ type: z.literal('function') }).passthrough();
  const tool = z.union([functionTool, z.object({ type: z.literal('namespace'), name: z.string(), tools: z.array(functionTool) }).passthrough()]);
  const body = z.object({ model: z.literal(MODEL), input: z.union([z.string(), z.array(z.unknown())]),
    tools: z.array(tool).optional(),
    max_output_tokens: z.number().int().positive().max(OUTPUT_LIMIT).optional(),
    background: z.literal(false).optional(), stream: z.boolean().optional(), service_tier: z.enum(['auto', 'default']).optional(),
  }).passthrough().parse(raw);
  // Images, audio, files, remote containers and hosted tools have separate
  // accounting. Refuse them instead of pretending they are ordinary text.
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const v = value as Record<string, unknown>;
    if (typeof v.type === 'string' && /image|audio|video|file|web_search|computer|container/i.test(v.type)) throw Error('Unsupported billable input or hosted tool');
    Object.values(v).forEach(inspect);
  };
  inspect(body.input);
  if ('previous_response_id' in body || 'conversation' in body || 'container' in body) throw Error('Server-side continuation is not supported by this spending guard');
  return { ...body, max_output_tokens: body.max_output_tokens ?? OUTPUT_LIMIT };
}

export function verifyMusePricing(data: unknown): boolean {
  const catalog = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).safeParse(data);
  if (!catalog.success) return false;
  const rows = catalog.data.data.filter(r => r.id === MODEL);
  if (rows.length !== 1) return false;
  const parsed = z.object({ metadata: z.object({ 'muse-code': z.object({
    limit: z.object({ context: z.number().positive().max(INPUT_LIMIT), output: z.number().positive().max(OUTPUT_LIMIT) }),
    cost: z.object({ currency: z.literal('USD'), input: z.string(), output: z.string() }),
  }).passthrough() }).passthrough() }).safeParse(rows[0]);
  if (!parsed.success) return false;
  const cost = parsed.data.metadata['muse-code'].cost;
  return /^\d+(\.\d+)?$/.test(cost.input) && /^\d+(\.\d+)?$/.test(cost.output) && Number(cost.input) <= 4 && Number(cost.output) <= 20;
}

/** Loopback proxy: only this controller holds the real provider credential.
 * The host receives a random local token; every paid retry/child request must
 * independently pass admission. Unknown outcomes block the whole campaign.
 */
export async function startMuseGateway(options: { key: string; ledgerFile: string; limitUsd?: number; fetcher?: typeof fetch }) {
  const ledger = new MuseSpendLedger(options.ledgerFile, options.limitUsd);
  const token = `LLM_0_${randomBytes(32).toString('hex')}`;
  const inflight = new Set<Promise<void>>();
  const events: { method?: string; path?: string; status?: number; error?: string }[] = [];
  let catalogVerified = false;
  const server = createServer((req, res) => {
    // A cancelled host can disconnect before the provider's final usage frame.
    // Wait for already admitted work to settle before considering a new call.
    const predecessors = [...inflight];
    const work = (async () => {
      let reservation: number | undefined;
      const observation: typeof events[number] = { method: req.method, path: req.url }; events.push(observation);
      try {
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
        const catalog = req.method === 'GET' && req.url === '/muse-code/models';
        const paid = req.method === 'POST' && ['/v1/responses', '/responses'].includes(req.url ?? '');
        if (!catalog && !paid) { res.writeHead(403).end('Endpoint is outside the benchmark allowance'); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw Error('Request exceeds the benchmark input limit'); chunks.push(chunk); }
        const body = paid ? validateMusePaidRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : undefined;
        if (paid) {
          if (!catalogVerified) throw Error('Current model prices and limits have not been verified');
          await Promise.allSettled(predecessors);
          if (res.destroyed) return;
          reservation = ledger.reserve();
        }
        const response = await (options.fetcher ?? fetch)(`https://api.meta.ai${paid ? '/v1/responses' : '/muse-code/models'}`, { method: req.method,
          headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json', accept: req.headers.accept ?? 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(180_000) });
        observation.status = response.status;
        if (catalog) {
          const text = await response.text();
          if (response.ok) {
            catalogVerified = verifyMusePricing(JSON.parse(text));
          }
          res.writeHead(response.status, { 'content-type': 'application/json' }).end(text); return;
        }
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        let buffer = ''; let responseBytes = 0; let usage: unknown; let terminal = false;
        const event = (line: string) => {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
          const value = JSON.parse(data) as { type?: string; response?: { usage?: unknown } };
          if (['response.completed', 'response.incomplete'].includes(value.type ?? '')) { terminal = true; usage = value.response?.usage; }
        };
        const decoder = new TextDecoder(); const sse = response.headers.get('content-type')?.includes('text/event-stream');
        if (response.body) for await (const chunk of response.body) {
          responseBytes += chunk.byteLength; if (responseBytes > 32 * 1024 * 1024) throw Error('Response evidence limit reached');
          buffer += decoder.decode(chunk, { stream: true });
          if (sse) { let newline: number; while ((newline = buffer.indexOf('\n')) !== -1) { event(buffer.slice(0, newline).trimEnd()); buffer = buffer.slice(newline + 1); } }
          if (!res.destroyed) res.write(chunk);
        }
        buffer += decoder.decode();
        if (sse) { if (buffer.trim()) event(buffer.trimEnd()); }
        else if (response.ok) { const data = JSON.parse(buffer) as { usage?: unknown; status?: string }; usage = data.usage; terminal = ['completed', 'incomplete'].includes(data.status ?? ''); }
        if (response.ok && terminal) ledger.settle(reservation!, usage); else ledger.unknown(reservation!);
        res.end();
      } catch (error) {
        observation.error = error instanceof z.ZodError ? `Unpriced request fields: ${error.issues.map(issue => `${issue.path.join('.')}:${issue.code}${issue.code === 'invalid_literal' && issue.path.at(-1) === 'type' ? `(${String(issue.received).slice(0, 64)})` : ''}`).join(', ')}` : String(error).replaceAll(options.key, '[redacted]');
        if (reservation !== undefined) ledger.unknown(reservation);
        // A local policy refusal is permanent. 429 makes the host repeatedly
        // retry a request that cannot become admissible, wasting its deadline.
        if (!res.headersSent) res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'BranchPilot spending guard refused or could not settle this request; inspect the local ledger.', type: 'budget_guard' } }));
      }
    })();
    inflight.add(work); void work.finally(() => inflight.delete(work));
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { ledger.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Gateway has no local address');
  return { url: `http://127.0.0.1:${address.port}`, token, ledger, events, catalogReady: () => catalogVerified,
    close: async () => { server.close(); server.closeIdleConnections(); await Promise.allSettled([...inflight]); server.closeAllConnections(); ledger.close(); } };
}
