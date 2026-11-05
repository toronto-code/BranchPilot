import { readSessionDurability } from '@muse-code/sdk';
import type { SpawnedMspConnection } from '@muse-code/sdk';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackendRequest } from './backend.js';
import type { MuseProtocolExpectation } from './muse-protocol.js';

export const museCapabilities = (dialogs = false) => ({ experimentalApi: true, userInputDialogs: dialogs });

export function verifyHandshake(msp: Pick<SpawnedMspConnection, 'initializeResult' | 'fingerprintWarning'>, expected: MuseProtocolExpectation, record: BackendRequest['record']): void {
  const result = msp.initializeResult;
  // The SDK's stable-schema warning is advisory. The independently tested
  // runtime lock still has to match the exact served schema and binary.
  if (msp.fingerprintWarning) record('muse.schema_warning', msp.fingerprintWarning);
  if (result.schema.fingerprint !== expected.schemaFingerprint || result.serverInfo.version !== expected.binaryVersion) throw Error('Muse handshake does not match the tested compatibility lock');
  if (!result.experimentalApi) throw Error('Muse did not negotiate experimental permission-profile readback');
  if (readSessionDurability(result).kind !== 'durable') throw Error('BranchPilot requires durable Muse sessions for accounting and recovery');
  if (expected.isolationAuthority === 'branchpilot-sandbox-exec') {
    record('muse.isolation_authority', { authority: expected.isolationAuthority, hostSandboxAvailability: result.sandboxAvailability });
  } else if (result.sandboxAvailability === 'unavailable') throw Error(`Muse cannot enforce its sandbox: ${result.sandboxUnavailableReason ?? 'reason unavailable'}`);
}

const sessionSchema = z.object({
  sessionId: z.string(), workspaceRoot: z.string().nullable(),
  permissionState: z.object({ profileId: z.string() }).passthrough(),
  approvalMode: z.object({ mode: z.string() }).passthrough(),
}).passthrough();

export function verifySessionAuthority(raw: unknown, sessionId: string, workspace: string, expected: MuseProtocolExpectation): void {
  const session = sessionSchema.parse(raw);
  if (session.sessionId !== sessionId || session.workspaceRoot !== workspace || session.permissionState.profileId !== expected.permissionProfile || session.approvalMode.mode !== expected.approvalMode) throw Error('Muse session identity, workspace, permission profile or approval mode is unconfirmed');
}

/** A command acknowledgement is admission, not application of a setting. */
export async function waitForMuseSetting(check: () => Promise<boolean>, signal: AbortSignal, timeoutSeconds: number, label: string): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutSeconds * 1000, 5000);
  do {
    signal.throwIfAborted();
    if (await check()) return;
    if (Date.now() >= deadline) break;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
  } while (Date.now() < deadline);
  throw Error(`Host has not confirmed ${label} before the settings deadline`);
}

/** These items own work outside the parent session's cumulative token counter. */
export function untrackedMuseWork(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const value = item as Record<string, unknown>;
  return ['subagent', 'workflow', 'reminderChild', 'sideChat', 'scheduledFire'].includes(String(value.kind)) || (value.kind === 'toolCall' && value.background === true);
}
