import { spawnMspConnection } from '@muse-code/sdk';
import { z } from 'zod';
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Backend, BackendAnswer, BackendOperation, BackendRequest, BackendResult } from './backend.js';
import type { Config } from './types.js';
import { hash } from './store.js';
import { sandboxCommand } from './process.js';
import { executeMuseProtocol } from './muse-protocol.js';
import { recoverMuseProtocol } from './muse-recovery.js';
import { museEnvironment, museLaunchArguments } from './muse-environment.js';

export const SDK_VERSION = '1.4.14';
export function installedMuseSDK(): { version: string; entry: string; digest: string } {
  const entry = createRequire(import.meta.url).resolve('@muse-code/sdk');
  let directory = dirname(entry);
  while (true) {
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@muse-code/sdk') {
        if (pkg.version !== SDK_VERSION) throw Error('Installed Muse SDK differs from the pinned version');
        const runtime = dirname(entry);
        const modules = readdirSync(runtime, { recursive: true }).filter((name): name is string => typeof name === 'string' && name.endsWith('.js')).sort();
        return { version: pkg.version, entry, digest: hash(JSON.stringify(modules.map(name => [name, hash(readFileSync(join(runtime, name)))]))) };
      }
    }
    const parent = dirname(directory); if (parent === directory) throw Error('Could not identify installed Muse SDK'); directory = parent;
  }
}
export const compatibilitySchema = z.object({
  sdkVersion: z.literal(SDK_VERSION), binaryVersion: z.string().min(1), binaryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  schemaFingerprint: z.string().min(1), verifiedAt: z.string().datetime(),
  runtimeHome: z.string().refine(isAbsolute, 'runtimeHome must be absolute'),
  permissionProfile: z.string().min(1), approvalMode: z.enum(['denyUnmatched', 'promptUnmatched']),
  shellCommands: z.array(z.string().min(1)).default([]),
  isolationVerified: z.literal(true), untrackedWorkersDisabled: z.literal(true), usageIncludesAllWork: z.literal(true),
  isolationAuthority: z.enum(['muse', 'branchpilot-sandbox-exec']).default('muse'),
  isolateSessionHomes: z.boolean().default(false), runtimeSettingsDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  questionContinuationVerified: z.boolean().default(false), hostReconciliationVerified: z.boolean().default(false), concurrentIsolationVerified: z.boolean().default(false),
}).strict();
export function verifyMuseLock(binary: string, file: string) {
  const lock = compatibilitySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const sdkIdentity = installedMuseSDK();
  if (hash(readFileSync(binary)) !== lock.binaryDigest) throw Error('Muse binary differs from the tested compatibility lock');
  if (lock.approvalMode === 'promptUnmatched' && (lock.isolationAuthority !== 'branchpilot-sandbox-exec' || !lock.shellCommands.length)) throw Error('Client shell approvals require external OS isolation and an explicit command allowlist');
  if (lock.isolateSessionHomes && !lock.runtimeSettingsDigest) throw Error('Isolated session homes require pinned runtime settings');
  if (lock.runtimeSettingsDigest && hash(readFileSync(join(lock.runtimeHome, '.config/muse/settings.json'))) !== lock.runtimeSettingsDigest) throw Error('Muse runtime settings differ from the tested compatibility lock');
  return { ...lock, sdkIdentity };
}

/** Compiled against the real SDK. Live execution requires an independently tested lock. */
export class MuseBackend implements Backend {
  checkOperation(operation: BackendOperation, config: Config): void {
    if (config.backend.kind !== 'muse') throw Error('Muse configuration required');
    if (operation === 'answer') throw Error('Live Muse answers remain gated: owned stdio host shutdown cancels the active turn; persistent-host continuation is not implemented');
    const lock = verifyMuseLock(config.backend.binary, config.backend.compatibilityLock);
    if (!lock.hostReconciliationVerified) throw Error(`Live Muse ${operation} remains gated: this exact runtime pair has no verified ${operation} evidence`);
  }
  answer(request: BackendRequest, answer: BackendAnswer): Promise<BackendResult> {
    this.checkOperation('answer', request.config);
    return this.run(request, answer);
  }
  reconcile(request: BackendRequest): Promise<BackendResult> {
    this.checkOperation('reconcile', request.config);
    return this.run(request, null);
  }
  execute(request: BackendRequest): Promise<BackendResult> { return this.run(request); }
  private async run(request: BackendRequest, recovery?: BackendAnswer | null): Promise<BackendResult> {
    const config = request.config.backend;
    if (config.kind !== 'muse') throw Error('Muse backend configuration required');
    const lock = verifyMuseLock(config.binary, config.compatibilityLock);
    if (request.backendIdentity && hash(JSON.stringify({ kind: 'muse', ...lock })) !== hash(JSON.stringify(request.backendIdentity))) throw Error('Muse compatibility settings differ from the frozen run manifest');
    if (request.config.budget.maxConcurrency > 1 && !lock.concurrentIsolationVerified) throw Error('Concurrent Muse execution remains gated until isolation between concurrent hosts is verified');
    request.signal.throwIfAborted();
    let runtimeHome = lock.runtimeHome;
    if (lock.isolateSessionHomes) {
      if (config.apiKeyEnv !== 'META_API_KEY') throw Error('Isolated session homes require explicit environment authentication');
      runtimeHome = join(dirname(request.work.workspace), '.muse-runtime', request.work.id);
      const settingFile = join(runtimeHome, '.config/muse/settings.json');
      if (recovery === undefined) {
        mkdirSync(runtimeHome, { recursive: true, mode: 0o700 }); mkdirSync(dirname(settingFile), { recursive: true });
        writeFileSync(settingFile, readFileSync(join(lock.runtimeHome, '.config/muse/settings.json')), { flag: 'wx', mode: 0o600 });
      }
      if (hash(readFileSync(settingFile)) !== lock.runtimeSettingsDigest) throw Error('Attempt runtime settings changed');
    }
    const scratch = join(request.work.workspace, '.branchpilot-tmp'); mkdirSync(scratch, { recursive: true });
    const [command, args] = sandboxCommand(config.binary, museLaunchArguments(lock.isolationAuthority), [request.work.workspace, runtimeHome, config.binary], [request.work.workspace, runtimeHome], true);
    const openHost: import('./muse-protocol.js').MuseHostFactory = hooks => spawnMspConnection({
      command, args, cwd: request.work.workspace,
      env: museEnvironment(runtimeHome, scratch, config.apiKeyEnv),
      shutdownTimeoutMs: Math.round(request.config.budget.cancellationGraceSeconds * 1000),
      connection: { mintCommandId: hooks.mintCommandId }, onStderr: hooks.onStderr,
    });
    return recovery === undefined ? executeMuseProtocol(request, { ...lock, questionContinuationVerified: false }, openHost) : recoverMuseProtocol(request, lock, openHost, recovery ?? undefined);
  }
}
