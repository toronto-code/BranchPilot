import { spawnMspConnection } from '@muse-code/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { installedMuseSDK } from './muse.js';
import { executeMuseProtocol } from './muse-protocol.js';
import type { MuseHost, MuseHostFactory } from './muse-protocol.js';
import type { BackendRequest } from './backend.js';
import { configSchema } from './config.js';
import { atomicWrite, hash, id, RunStore } from './store.js';
import { runProcess, sandboxCommand } from './process.js';
import { contained, readRegularText, rejectNestedStorage } from './workspaces.js';
import { museEnvironment, museLaunchArguments } from './muse-environment.js';

export const smokeSpecSchema = z.object({
  schemaVersion: z.literal(1), binary: z.string().min(1), runtimeHome: z.string().refine(isAbsolute),
  binaryVersion: z.string().min(1), schemaFingerprint: z.string().min(1), permissionProfile: z.string().min(1),
  apiKeyEnv: z.literal('META_API_KEY').optional(),
  isolationAuthority: z.enum(['muse', 'branchpilot-sandbox-exec']).default('muse'),
  model: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).strict(), effort: z.string().min(1),
  timeoutSeconds: z.number().finite().positive().max(120).default(30), cancellationGraceSeconds: z.number().finite().positive().max(10).default(2),
}).strict();
type SmokeSpec = z.infer<typeof smokeSpecSchema>;
export const smokeCases = ['completion', 'cancellation', 'host-failure', 'isolation'] as const;
export type SmokeCase = typeof smokeCases[number];
interface SmokePlan {
  schemaVersion: 1; id: string; createdAt: string; spec: SmokeSpec;
  binaryDigest: string; sdk: { version: string; entry: string; digest: string }; config: BackendRequest['config'];
  canary: string; expectedEdit: string;
}

/** Purely local preparation: never initializes a host and never writes a compatibility lock. */
export function prepareSmoke(specFile: string, output: string): void {
  const spec = smokeSpecSchema.parse(JSON.parse(readFileSync(specFile, 'utf8')));
  spec.binary = resolve(dirname(resolve(specFile)), spec.binary);
  output = resolve(output);
  rejectNestedStorage(spec.runtimeHome, output);
  const sdk = installedMuseSDK(); const binaryDigest = hash(readFileSync(spec.binary));
  const config = configSchema.parse({
    schemaVersion: 1, task: { key: 'compatibility-smoke', type: 'code', goal: 'Record compatibility observations', evaluators: [{ id: 'unused', kind: 'executable', role: 'correctness', definition: { path: 'unused' }, timeoutSeconds: 1 }], baseline: { mode: 'initial_artifacts', description: 'Smoke canary' }, selection: {} },
    backend: { kind: 'muse', binary: spec.binary, compatibilityLock: join(output, 'NO_COMPATIBILITY_LOCK'), ...(spec.apiKeyEnv ? { apiKeyEnv: spec.apiKeyEnv } : {}) },
    agent: { model: { kind: 'explicit', ...spec.model }, effort: { kind: 'explicit', value: spec.effort } },
    budget: { total: { tokens: 0, attempts: 1, experiments: 0, workSeconds: spec.timeoutSeconds }, wallSeconds: spec.timeoutSeconds, perAttempt: { tokenReservation: 1, timeoutSeconds: spec.timeoutSeconds }, cancellationGraceSeconds: spec.cancellationGraceSeconds }, execution: { isolationProfile: 'sandbox-exec' },
  });
  const plan: SmokePlan = { schemaVersion: 1, id: id(), createdAt: new Date().toISOString(), spec, binaryDigest, sdk, config, canary: `private-${id()}`, expectedEdit: `edited-${id()}\n` };
  mkdirSync(output, { recursive: false });
  atomicWrite(join(output, 'plan.json'), JSON.stringify({ plan, digest: hash(JSON.stringify(plan)) }, null, 2));
  atomicWrite(join(output, 'private-canary.txt'), plan.canary);
  atomicWrite(join(output, 'README.txt'), 'UNVERIFIED compatibility experiment. No Muse was launched by preparation. Each case may execute once. Live cases can incur provider cost. Results never generate or authorize a compatibility lock.\n');
  writeSmokeReport(output);
}

function readPlan(directory: string): SmokePlan {
  const envelope = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')) as { plan: SmokePlan; digest: string };
  if (hash(JSON.stringify(envelope.plan)) !== envelope.digest) throw Error('Smoke plan integrity check failed');
  smokeSpecSchema.parse(envelope.plan.spec);
  return envelope.plan;
}

export async function runSmokeCase(directory: string, name: SmokeCase, options: { allowLive: boolean; allowProviderCost: boolean; signal?: AbortSignal; openHost?: MuseHostFactory }): Promise<void> {
  if (!options.allowLive || !options.allowProviderCost) throw Error('Smoke execution requires explicit --allow-live and --allow-provider-cost; preparation and reporting never launch Muse');
  if (!smokeCases.includes(name)) throw Error('Unknown smoke case');
  readPlan(directory);
  const owner = new RunStore(directory, true);
  try { await executeSmokeCase(resolve(directory), name, options); }
  finally { owner.close(); }
}
async function executeSmokeCase(directory: string, name: SmokeCase, options: { signal?: AbortSignal; openHost?: MuseHostFactory }): Promise<void> {
  const plan = readPlan(directory); const spec = plan.spec;
  if (hash(readFileSync(spec.binary)) !== plan.binaryDigest || JSON.stringify(installedMuseSDK()) !== JSON.stringify(plan.sdk)) throw Error('SDK or binary changed after smoke preparation');
  options.signal?.throwIfAborted();
  const caseDirectory = join(directory, name);
  // Exclusive creation is intentional: crashes/unknown outcomes never authorize automatic replay.
  mkdirSync(caseDirectory);
  const mode = options.openHost ? 'protocol_simulation' : 'live';
  atomicWrite(join(caseDirectory, 'intent.json'), JSON.stringify({ planId: plan.id, case: name, mode, binaryDigest: plan.binaryDigest, sdk: plan.sdk, startedAt: new Date().toISOString() }));
  const workspace = join(caseDirectory, 'workspace'); const scratch = join(workspace, '.branchpilot-tmp'); mkdirSync(scratch, { recursive: true });
  writeFileSync(join(workspace, 'smoke.txt'), 'before\n');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(Error('Smoke timeout')), spec.timeoutSeconds * 1000);
  const events: { kind: string; data: unknown }[] = []; let bytes = 0; let limited = false; let host: MuseHost | undefined;
  const record: BackendRequest['record'] = (kind, data) => {
    const value = { kind, data }; const encoded = JSON.stringify(value);
    if (limited) return;
    bytes += Buffer.byteLength(encoded);
    if (bytes > 32 * 1024 * 1024 || events.length >= 10000) { limited = true; controller.abort(Error('Smoke evidence limit')); return; }
    events.push(value);
    atomicWrite(join(caseDirectory, `event-${events.length}.json`), encoded);
    if (kind === 'muse.turn' && name === 'cancellation') queueMicrotask(() => controller.abort(Error('Intentional cancellation probe')));
    if (kind === 'muse.turn' && name === 'host-failure') queueMicrotask(() => { void host?.close().catch(error => record('smoke.close_error', String(error))); });
  };
  try {
    if (name === 'isolation') {
      if (options.openHost) throw Error('OS isolation cannot be established by a protocol simulation');
      const forbidden = join(directory, 'forbidden-write.txt'); const canary = join(directory, 'private-canary.txt');
      const script = `const fs=require('node:fs');const result={};for(const [key,fn] of [['read',()=>fs.readFileSync(${JSON.stringify(canary)})],['write',()=>fs.writeFileSync(${JSON.stringify(forbidden)},'unexpected')]]){try{fn();result[key]='allowed'}catch(e){result[key]=e.code}}console.log(JSON.stringify(result));`;
      const [probe, probeArgs] = sandboxCommand(process.execPath, ['-e', script], [workspace, spec.runtimeHome, spec.binary], [workspace, spec.runtimeHome], true);
      const result = await runProcess(probe, probeArgs, { cwd: workspace, timeoutMs: spec.timeoutSeconds * 1000, graceMs: spec.cancellationGraceSeconds * 1000, signal: controller.signal, env: { PATH: process.env.PATH, HOME: spec.runtimeHome, TMPDIR: scratch } });
      record('smoke.isolation_probe', result);
      atomicWrite(join(caseDirectory, 'result.json'), JSON.stringify({ mode, result, observation: result.stopped && result.code === 0 ? JSON.parse(result.stdout) : null }));
    } else {
      const [command, args] = options.openHost ? ['', [] as string[]] : sandboxCommand(spec.binary, museLaunchArguments(spec.isolationAuthority), [workspace, spec.runtimeHome, spec.binary], [workspace, spec.runtimeHome], true);
      const open: MuseHostFactory = hooks => {
        host = options.openHost ? options.openHost(hooks) : spawnMspConnection({ command, args, cwd: workspace, env: museEnvironment(spec.runtimeHome, scratch, spec.apiKeyEnv), shutdownTimeoutMs: Math.round(spec.cancellationGraceSeconds * 1000), connection: { mintCommandId: hooks.mintCommandId }, onStderr: hooks.onStderr });
        return host;
      };
      const work: BackendRequest['work'] = { id: id(), kind: 'attempt', phase: 'search', revisionId: 'smoke-baseline', reservation: { tokens: 0, attempts: 1, experiments: 0, workSeconds: spec.timeoutSeconds }, state: 'running', intent: 'smoke', workspace, index: 0, epoch: 0 };
      const base: BackendRequest['base'] = { id: work.revisionId, candidateId: 'smoke', parentIds: [], snapshot: '', proposal: '', hypotheses: [], depth: 0, createdAt: new Date().toISOString() };
      const result = await executeMuseProtocol({ config: plan.config, work, base, record, signal: controller.signal, prompt: `Compatibility smoke experiment. Edit only smoke.txt to contain exactly ${JSON.stringify(plan.expectedEdit)}. Do not request additional agents, workers, or detached processes. ${name === 'completion' ? 'Finish after this edit.' : 'After the edit, continue describing the change until interrupted.'}` }, { ...spec, approvalMode: 'denyUnmatched' }, open);
      let edited: boolean | null = null;
      if (result.stopped && result.outcome !== 'unknown') {
        try { edited = readRegularText(contained(workspace, 'smoke.txt'), 4096) === plan.expectedEdit; }
        catch (error) { edited = false; record('smoke.edit_probe_error', { error: String(error) }); }
      }
      const submission = events.some(event => event.kind === 'muse.command_prepared' && (event.data as { turnSubmission?: boolean }).turnSubmission);
      const facts = { settingsReadbackAccepted: submission, streamedItems: events.filter(event => event.kind === 'muse.item').length, expectedEditObserved: edited, reportedTokens: result.tokens, terminalAndHostStopObserved: result.stopped && result.outcome !== 'unknown', cancellationTerminalObserved: result.stopped && result.outcome === 'cancelled', hostFailureRetainedUncertainty: name === 'host-failure' && result.outcome === 'unknown', evidenceTruncated: limited };
      atomicWrite(join(caseDirectory, 'result.json'), JSON.stringify({ mode, result, facts }, null, 2));
    }
  } catch (error) {
    atomicWrite(join(caseDirectory, 'error.json'), JSON.stringify({ error: String(error), outcome: 'unknown', mode }));
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort); writeSmokeReport(directory);
  }
}

export function writeSmokeReport(directory: string): void {
  const plan = readPlan(directory);
  const cases = smokeCases.map(name => {
    const file = join(directory, name, 'result.json'); const intent = join(directory, name, 'intent.json');
    return { name, status: existsSync(file) ? 'observations_recorded' : existsSync(intent) ? 'unknown_do_not_replay' : 'unverified', ...(existsSync(file) ? { evidence: JSON.parse(readFileSync(file, 'utf8')) as unknown } : {}) };
  });
  const unverified = ['authentication beyond the observed request', 'all billable child/tool usage included', 'absence of surviving descendant/provider work', 'runtime-home isolation and cross-run held-out exposure', 'question continuation', 'host reconciliation after real host failures', 'concurrent host isolation'];
  atomicWrite(join(directory, 'summary.json'), JSON.stringify({ schemaVersion: 1, planId: plan.id, sdk: plan.sdk, binaryDigest: plan.binaryDigest, compatibilityVerified: false, cases, unverified }, null, 2));
  atomicWrite(join(directory, 'summary.md'), [`# Muse compatibility evidence: ${plan.id}`, '', '**UNVERIFIED. This harness never creates a compatibility lock.**', '', `SDK ${plan.sdk.version}; binary SHA-256 ${plan.binaryDigest}.`, '', ...cases.map(entry => `- ${entry.name}: ${entry.status}`), '', 'Recorded observations need independent review. Normalized token usage does not prove every worker is accounted for; a terminal and host close do not prove no work survives.', '', 'Still unverified:', '', ...unverified.map(item => `- ${item}`), ''].join('\n'));
}

