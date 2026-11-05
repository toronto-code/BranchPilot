import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { reduce } from './types.js';
import type { Envelope, Event, State } from './types.js';

export const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const id = (): string => randomUUID();
export function atomicWrite(path: string, data: string | Uint8Array): void {
  const temp = `${path}.${id()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

/** Single local writer. Each line is one checksummed, fsynced transaction. */
export class RunStore {
  readonly dir: string;
  state!: State;
  sequence = 0;
  projectionWarning?: string;
  private previousHash = '';
  private lockToken?: string;
  private tailBytes = 0;
  private validBytes = 0;
  private projectionSequence = 0;
  private projectionChanges = 0;
  private projectionAt = 0;

  constructor(dir: string, writable = false) {
    this.dir = resolve(dir);
    try {
      if (writable) {
        mkdirSync(this.dir, { recursive: true });
        this.acquire();
        mkdirSync(join(this.dir, 'artifacts'), { recursive: true });
      }
      this.load();
    } catch (error) { this.close(); throw error; }
  }
  private acquire(): void {
    const path = join(this.dir, 'writer.lock');
    const token = id();
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token })); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const reclaimPath = join(this.dir, 'writer-reclaim.lock');
      let reclaim: number;
      try { reclaim = openSync(reclaimPath, 'wx', 0o600); }
      catch { throw Error('Another writer is inspecting the lock; retry after it finishes (a stale reclaim lock requires manual inspection)'); }
      try {
        // Re-read under the reclaim lock; never remove an owner observed before it.
        if (existsSync(path)) {
          const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; host: string };
          if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) throw Error('Run lock requires manual inspection');
          let stale = false;
          try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') stale = true; else throw e; }
          if (!stale) throw Error(`Run has an active writer (PID ${owner.pid})`);
          renameSync(path, `${path}.stale.${id()}`);
        }
        return this.acquire();
      } finally { closeSync(reclaim); rmSync(reclaimPath, { force: true }); }
    }
    this.lockToken = token;
  }
  private load(): void {
    const path = join(this.dir, 'events.jsonl');
    if (!existsSync(path)) return;
    const bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(10);
    this.validBytes = lastNewline + 1;
    this.tailBytes = bytes.length - this.validBytes;
    let state: State | undefined;
    for (const line of bytes.subarray(0, this.validBytes).toString('utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as Envelope;
      const { hash: checksum, ...body } = row;
      if (row.schemaVersion !== 1 || row.sequence !== this.sequence + 1 || row.previousHash !== this.previousHash || hash(JSON.stringify(body)) !== checksum) throw Error(`Corrupt event log at sequence ${row.sequence}`);
      for (const event of row.events) state = reduce(state, event);
      this.sequence = row.sequence; this.previousHash = checksum;
    }
    if (state) this.state = state;
  }
  repairTail(): void {
    this.requireWriter();
    if (!this.tailBytes) return;
    if (!this.state) throw Error('No committed run record; cannot recover this directory');
    const path = join(this.dir, 'events.jsonl');
    atomicWrite(join(this.dir, `discarded-tail-${id()}.bin`), readFileSync(path).subarray(this.validBytes));
    truncateSync(path, this.validBytes);
    const bytes = this.tailBytes; this.tailBytes = 0;
    this.append({ type: 'recovery.tail_discarded', bytes });
  }
  append(...events: Event[]): void {
    this.requireWriter();
    if (this.tailBytes) throw Error('Repair incomplete log tail before writing');
    if (events.length === 0) return;
    // Fold exactly the serialized representation so replay and live state agree.
    events = JSON.parse(JSON.stringify(events)) as Event[];
    let next = this.state;
    for (const event of events) next = reduce(next, event);
    const body = { schemaVersion: 1 as const, sequence: this.sequence + 1, previousHash: this.previousHash, timestamp: new Date().toISOString(), events };
    const row = { ...body, hash: hash(JSON.stringify(body)) };
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    const fd = openSync(join(this.dir, 'events.jsonl'), 'a', 0o600);
    try {
      let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (next !== this.state) this.projectionChanges++;
    this.state = next!; this.sequence = row.sequence; this.previousHash = row.hash;
    const checkpoint = events.some(event => event.type === 'run.created' || event.type === 'run.status' || (event.type === 'work.updated' && (event.work.state === 'settled' || event.work.state === 'unknown')));
    if (checkpoint || (this.projectionChanges > 0 && (this.projectionChanges >= 32 || Date.now() - this.projectionAt >= 1000))) this.flushProjection();
  }
  private flushProjection(): void {
    if (!this.state || this.projectionSequence === this.sequence) return;
    // The transaction is already committed. A rebuildable cache failure must
    // never make its caller treat that committed operation as unrecorded.
    try {
      atomicWrite(join(this.dir, 'state.json'), JSON.stringify({ sequence: this.sequence, state: this.state }, null, 2));
      this.projectionSequence = this.sequence; this.projectionChanges = 0; this.projectionAt = Date.now();
      delete this.projectionWarning;
    } catch (error) { this.projectionWarning = `State projection cache could not be refreshed: ${String(error)}`; }
  }
  put(data: string | Uint8Array): string {
    this.requireWriter();
    const digest = hash(data); const path = join(this.dir, 'artifacts', digest);
    if (!existsSync(path)) atomicWrite(path, data);
    else if (hash(readFileSync(path)) !== digest) throw Error(`Corrupt artifact ${digest}`);
    return digest;
  }
  putJSON(value: unknown): string { return this.put(JSON.stringify(value)); }
  get(digest: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid artifact digest');
    const data = readFileSync(join(this.dir, 'artifacts', digest));
    if (hash(data) !== digest) throw Error(`Artifact checksum mismatch: ${digest}`);
    return data;
  }
  getJSON<T>(digest: string): T { return JSON.parse(this.get(digest).toString('utf8')) as T; }
  private requireWriter(): void { if (!this.lockToken) throw Error('Store is read-only'); }
  close(): void {
    if (!this.lockToken) return;
    this.flushProjection();
    const path = join(this.dir, 'writer.lock');
    try { if (JSON.parse(readFileSync(path, 'utf8')).token === this.lockToken) rmSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { this.lockToken = undefined; }
  }
}
