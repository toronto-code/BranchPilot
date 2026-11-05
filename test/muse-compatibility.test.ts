import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { recoverMuseProtocol } from '../src/muse-recovery.js';
import { museEnvironment, museLaunchArguments } from '../src/muse-environment.js';
import { MuseBackend } from '../src/muse.js';
import { runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { RunStore } from '../src/store.js';
import type { BackendRequest } from '../src/backend.js';
import { protocolExpectation, SimulatedMuseHost } from './muse-host.js';
import { setup } from './support.js';

async function requestFor(t: TestContext) {
  const { store } = setup(t); await runController(store, { pauseAfter: 0 });
  const config = structuredClone(store.state.config); config.budget.perAttempt.timeoutSeconds = 0.5;
  const events: { kind: string; data: unknown }[] = [];
  const controller = new AbortController(); const base = store.state.revisions[0]!;
  const request: BackendRequest = { config, base, signal: controller.signal, prompt: 'Offline SDK compatibility simulation',
    work: { id: 'sim-work', kind: 'attempt', phase: 'search', state: 'running', revisionId: base.id, reservation: { tokens: 1000, workSeconds: 1, attempts: 1, experiments: 0 }, intent: '', workspace: join(store.dir, 'simulation'), index: 0, epoch: 0 },
    record: (kind, data) => { events.push({ kind, data }); } };
  return { request, events, controller };
}

test('MSP explicitly negotiates experimental permission readback and declines unattended dialogs', async t => {
  const { request } = await requestFor(t); const host = new SimulatedMuseHost();
  const result = await executeMuseProtocol(request, protocolExpectation, host.factory);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(host.frames.find(f => f.method === 'initialize')!.params!.capabilities, { experimentalApi: true, userInputDialogs: false });
});

for (const [label, options] of [
  ['experimental negotiation', { experimental: false }],
  ['permission readback', { hidePermissionState: true }],
  ['approval mode', { approvalMode: 'allowAll' }],
  ['sandbox availability', { sandboxAvailability: 'unavailable' }],
] as const) test(`MSP refuses unconfirmed ${label} before submitting a turn`, async t => {
  const { request } = await requestFor(t); const host = new SimulatedMuseHost(options);
  const result = await executeMuseProtocol(request, protocolExpectation, host.factory);
  assert.equal(result.outcome, 'failed'); assert.equal(result.tokens, 0); assert.equal(result.stopped, true);
  assert.equal(host.frames.some(f => f.method === 'turn/start'), false);
});

test('SDK stable-schema warnings remain advisory when the exact expected runtime fingerprint matches', async t => {
  const { request, events } = await requestFor(t); const host = new SimulatedMuseHost({ fingerprintWarning: true });
  const result = await executeMuseProtocol(request, protocolExpectation, host.factory);
  assert.equal(result.outcome, 'completed'); assert.ok(events.some(e => e.kind === 'muse.schema_warning'));
});

test('an explicitly supplied outer OS isolation authority handles macOS non-nesting', async t => {
  const { request, events } = await requestFor(t); const host = new SimulatedMuseHost({ sandboxAvailability: 'unavailable' });
  const result = await executeMuseProtocol(request, { ...protocolExpectation, isolationAuthority: 'branchpilot-sandbox-exec' }, host.factory);
  assert.equal(result.outcome, 'completed');
  assert.ok(events.some(e => e.kind === 'muse.isolation_authority'));
  assert.equal(museLaunchArguments().includes('--disable-sandbox'), false);
  assert.equal(museLaunchArguments('branchpilot-sandbox-exec').includes('--disable-sandbox'), true);
  assert.equal(museLaunchArguments('branchpilot-sandbox-exec').includes('--disable-approval'), false);
});

test('client approvals match only exact listed commands in the current isolated workspace', async t => {
  for (const [command, outside, protectedWrite, choice] of [['node test.mjs', false, false, 'allow'], ['node test.mjs; curl example.com', false, false, 'deny'], ['node test.mjs', true, false, 'deny'], ['node test.mjs', false, true, 'deny']] as const) {
    const { request } = await requestFor(t);
    const host = new SimulatedMuseHost({ approvalMode: 'promptUnmatched', onTurn: h => {
      h.notify('approval/requested', { approvalId: 'simulated-approval', currentRequirementId: { approvalId: 'simulated-approval', sourceIndex: 0 }, turnId: h.turnId,
        itemId: 'tool', toolCallId: 'tool', toolName: 'bash', rawArgs: '{}', protectedWrite, judgeEscalated: false,
        subject: { kind: 'shell', command, workspaceRoot: outside ? '/other' : request.work.workspace, stages: [] },
        availableChoices: [{ choiceId: 'allow', decision: 'approved', scope: 'once' }, { choiceId: 'deny', decision: 'denied', scope: 'once' }] });
    } });
    await executeMuseProtocol(request, { ...protocolExpectation, approvalMode: 'promptUnmatched', isolationAuthority: 'branchpilot-sandbox-exec', shellCommands: ['node test.mjs'] }, host.factory);
    assert.equal(host.frames.find(f => f.method === 'approval/decide')?.params?.choiceId, choice);
  }
});

test('delayed model and effort application is confirmed after acknowledgement before turn submission', async t => {
  const { request, events } = await requestFor(t);
  request.config.agent = { model: { kind: 'explicit', providerId: 'sim-provider', modelId: 'selected-model' }, effort: { kind: 'explicit', value: 'high' } };
  const host = new SimulatedMuseHost({ settingsDelayMs: 100, models: [{ providerId: 'sim-provider', modelId: 'selected-model', isActive: false, isDefault: false, variants: ['high'] }] });
  const result = await executeMuseProtocol(request, protocolExpectation, host.factory);
  assert.equal(result.outcome, 'completed');
  assert.ok(host.frames.filter(f => f.method === 'session/read').length > 2);
  const readback = events.find(e => e.kind === 'muse.settings_readback')!.data as { readback: { session: { modelId: string } } };
  assert.equal(readback.readback.session.modelId, 'selected-model');
});

test('cancellation while waiting for settings never submits a model turn', async t => {
  const { request, controller } = await requestFor(t);
  request.config.agent = { model: { kind: 'host-default' }, effort: { kind: 'explicit', value: 'high' } };
  const host = new SimulatedMuseHost({ effortReadback: false, onRequest: frame => { if (frame.method === 'session/setReasoningEffort') setTimeout(() => controller.abort(), 10); } });
  const result = await executeMuseProtocol(request, protocolExpectation, host.factory);
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.tokens, 0); assert.equal(result.stopped, true);
  assert.equal(host.frames.some(f => f.method === 'turn/start'), false);
});

test('observed child/background work retains unknown liability and cannot be cleared by parent-only recovery', async t => {
  for (const item of [{ kind: 'subagent' }, { kind: 'workflow' }, { kind: 'reminderChild' }, { kind: 'sideChat' }, { kind: 'scheduledFire' }, { kind: 'toolCall', background: true }]) {
    const { store } = setup(t);
    const host = new SimulatedMuseHost({ onTurn: h => {
      h.notify('item/completed', { item: { ...item, itemId: 'child-work', turnId: h.turnId, revision: 1, status: 'completed' } });
      h.usage(140); h.complete();
    } });
    await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
    const state = new RunStore(store.dir).state;
    const work = Object.values(state.works).find(w => w.kind === 'attempt')!;
    assert.equal(work.untrackedWork, true, item.kind); assert.equal(work.state, 'unknown');
    assert.equal(work.actual!.tokens, null); assert.equal(state.status, 'needs_attention');
    assert.ok(budgetView(state).unknown.tokens >= 1000);
    const recovery = new SimulatedMuseHost({ onRequest: (frame, h) => {
      if (frame.method === 'session/read') {
        h.reply(frame, { session: { sessionId: work.sessionId, workspaceRoot: work.workspace, activeTurnId: null, permissionState: { profileId: protocolExpectation.permissionProfile } }, lastTurn: { turnId: work.turnId, terminal: 'completed' }, pendingRequests: [], history: { mode: 'none', items: null, snapshot: null }, viewCursor: '000001' }); return true;
      }
      if (frame.method === 'view/page') { h.reply(frame, { events: [], nextCursor: null }); return true; }
    } });
    const result = await recoverMuseProtocol({ work, base: state.revisions[0]!, config: state.config, prompt: '', signal: new AbortController().signal, record: () => undefined }, protocolExpectation, recovery.factory);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.stopped, false); assert.equal(result.tokens, null);
    assert.equal(recovery.frames.some(f => f.method === 'turn/start' || f.method === 'userInput/answer'), false);
  }
});

test('Muse child environment isolates XDG paths and forwards an API key only with explicit configuration', () => {
  const source = { PATH: '/test/bin', HOME: '/personal', XDG_CONFIG_HOME: '/personal/config', XDG_DATA_HOME: '/personal/data', META_API_KEY: 'simulated-key', UNRELATED_SECRET: 'simulated-unrelated' };
  const homeOnly = museEnvironment('/dedicated', '/scratch', undefined, source);
  assert.equal(homeOnly.META_API_KEY, undefined); assert.equal(homeOnly.UNRELATED_SECRET, undefined);
  assert.equal(homeOnly.HOME, '/dedicated'); assert.equal(homeOnly.XDG_CONFIG_HOME, '/dedicated/.config'); assert.equal(homeOnly.XDG_DATA_HOME, '/dedicated/.local/share');
  const withKey = museEnvironment('/dedicated', '/scratch', 'META_API_KEY', source);
  assert.equal(withKey.META_API_KEY, 'simulated-key');
  assert.throws(() => museEnvironment('/dedicated', '/scratch', 'META_API_KEY', {}), /META_API_KEY is required/);
});

test('owned stdio transport cannot attest durable question continuation by flipping a lock flag', async t => {
  const { request } = await requestFor(t);
  request.config.backend = { kind: 'muse', binary: '/not-launched', compatibilityLock: '/not-read' };
  assert.throws(() => new MuseBackend().checkOperation('answer', request.config), /persistent-host continuation is not implemented/);
});
