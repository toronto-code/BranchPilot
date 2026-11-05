import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { MAX_TIMEOUT_MS } from './time.js';

export interface ProcessResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; truncated: boolean; stopped: boolean; seconds: number }
export function sandboxCommand(command: string, args: string[], reads: string[], writes: string[], network = false): [string, string[]] {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw Error('sandbox-exec isolation is unavailable on this host');
  const quote = (path: string) => JSON.stringify(realpathSync(path));
  const profile = [
    '(version 1)', '(deny default)', '(allow process-exec process-fork sysctl-read mach-lookup)', '(allow file-read-metadata)',
    // dyld's cache discovery opens the root directory on current macOS. A
    // literal grant permits that directory only, never its descendants.
    `(allow file-read* ${['/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/var/db/timezone', ...reads, ...writes].filter(existsSync).map(p => `(subpath ${quote(p)})`).join(' ')} (literal "/") (literal "/dev/urandom") (literal "/dev/null"))`,
    `(allow file-write* ${writes.map(p => `(subpath ${quote(p)})`).join(' ')} (literal "/dev/null"))`,
    '(allow signal (target self))', network ? '(allow network*)' : '',
  ].join('\n');
  return ['/usr/bin/sandbox-exec', ['-p', profile, command, ...args]];
}
export function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; graceMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false, stopped: true, seconds: 0 });
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS || !Number.isFinite(options.graceMs) || options.graceMs < 0 || options.graceMs > MAX_TIMEOUT_MS) throw Error('Worker timeout/grace exceeds the supported timer range');
  return new Promise((resolve, reject) => {
    const began = Date.now(); let diagnostics = ''; let truncated = false; let timedOut = false; let cancelled = false; let escalation: NodeJS.Timeout | undefined;
    const output = () => ({ chunks: [] as Buffer[], bytes: 0, truncated: false });
    const stdout = output(); const stderr = output(); const limit = 1024 * 1024;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const alive = () => {
      if (!child.pid) return false;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const kill = (signal: NodeJS.Signals) => { if (!child.pid) return; try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') diagnostics = (diagnostics + `\nCould not ${signal} worker: ${String(error)}`).slice(0, 4096); } };
    const stop = () => { kill('SIGTERM'); if (!escalation) escalation = setTimeout(() => kill('SIGKILL'), options.graceMs); };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.timeoutMs));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (stream: ReturnType<typeof output>, chunk: Buffer) => {
      const length = Math.min(chunk.length, limit - stream.bytes);
      if (length) { stream.chunks.push(Buffer.from(chunk.subarray(0, length))); stream.bytes += length; }
      if (length < chunk.length) { stream.truncated = true; truncated = true; stop(); }
    };
    const decode = (stream: ReturnType<typeof output>) => {
      const decoder = new StringDecoder('utf8');
      const text = decoder.write(Buffer.concat(stream.chunks));
      return text + (stream.truncated ? '' : decoder.end());
    };
    child.stdout.on('data', (chunk: Buffer) => { collect(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { collect(stderr, chunk); });
    const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    // An exited parent can leave children holding its output pipes. Stop its group.
    child.on('exit', () => { if (alive()) stop(); });
    child.on('close', (code, signal) => {
      cleanup(); if (alive()) kill('SIGKILL');
      resolve({ code, signal, stdout: decode(stdout), stderr: decode(stderr) + diagnostics, timedOut, cancelled, truncated, stopped: !alive(), seconds: (Date.now() - began) / 1000 });
    });
  });
}
