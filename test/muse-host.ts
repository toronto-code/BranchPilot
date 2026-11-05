// Protocol simulation only: no Muse executable, credentials, provider, or compatibility lock.
import { Connection } from '@muse-code/sdk';
import type { DuplexTransport } from '@muse-code/sdk';
import type { SourceRange } from '@muse-code/sdk/dist/src/msp.js';
import type { MuseHost, MuseHostFactory, MuseProtocolExpectation } from '../src/muse-protocol.js';

type Frame = { jsonrpc: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
export function simulatedSourceRange(sequence: number, sessionId: string): SourceRange {
  const position = { id: `simulated-record-${sequence}`, sequence };
  return { stream: { id: sessionId, kind: 'session' }, first: position, last: position };
}
export const protocolExpectation: MuseProtocolExpectation = {
  binaryVersion: 'offline-protocol-simulation', schemaFingerprint: 'simulated-schema',
  permissionProfile: 'simulated-deny-profile', approvalMode: 'denyUnmatched',
};
export interface SimulatedHostOptions {
  fingerprint?: string; version?: string; durability?: string; permissionProfile?: string;
  models?: readonly unknown[]; readbackModel?: string; effortReadback?: boolean;
  closeError?: boolean;
  experimental?: boolean; sandboxAvailability?: string; fingerprintWarning?: boolean;
  settingsDelayMs?: number; approvalMode?: string; hidePermissionState?: boolean;
  onRequest?: (frame: Frame, host: SimulatedMuseHost) => boolean | void;
  onTurn?: (host: SimulatedMuseHost) => void;
  onCancel?: (host: SimulatedMuseHost) => void;
}
export class SimulatedMuseHost {
  frames: Frame[] = [];
  connection!: Connection;
  sessionId = 'simulated-session';
  turnId?: string;
  closeCount = 0;
  initializeCount = 0;
  private cursor = 0;
  private chunks: string[] = [];
  private wake?: () => void;
  private ended = false;
  private providerId = 'sim-provider';
  private modelId = 'sim-model';
  private workspaceRoot = '/simulated-workspace';
  private experimental = false;
  private closePromise?: Promise<void>;
  readonly factory: MuseHostFactory;
  constructor(readonly options: SimulatedHostOptions = {}) {
    this.factory = hooks => {
      const transport: DuplexTransport = {
        incoming: this.incoming(),
        write: async chunk => {
          for (const line of chunk.trim().split('\n')) {
            const frame = JSON.parse(line) as Frame; this.frames.push(frame);
            if (frame.id !== undefined && frame.method) this.request(frame);
          }
        },
        close: async () => { this.disconnect(); },
      };
      this.connection = new Connection(transport, { mintCommandId: hooks.mintCommandId });
      const host: MuseHost = {
        initialize: async params => {
          this.initializeCount++;
          const initializeResult = await this.connection.request('initialize', { ...params });
          this.connection.notify('initialized', {});
          // Raw wire fixtures are intentionally synthetic. The engine still runs
          // its handshake checks, and the SDK owns every session/turn operation.
          return { connection: this.connection, initializeResult: initializeResult as unknown as Awaited<ReturnType<MuseHost['initialize']>>['initializeResult'], fingerprintWarning: this.options.fingerprintWarning ? { kind: 'schemaFingerprintMismatch', pinned: 'stable-simulation', served: protocolExpectation.schemaFingerprint, message: 'Simulated stable/experimental warning' } : undefined };
        },
        close: () => this.closePromise ??= (async () => {
          this.closeCount++;
          await this.connection.close();
          if (this.options.closeError) throw Error('Simulated unproven host shutdown');
        })(),
      };
      return host;
    };
  }
  private async *incoming(): AsyncIterable<string> {
    while (true) {
      const chunk = this.chunks.shift();
      if (chunk !== undefined) { yield chunk; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  private push(frame: unknown): void { this.chunks.push(JSON.stringify(frame) + '\n'); this.wake?.(); this.wake = undefined; }
  disconnect(): void { this.ended = true; this.wake?.(); this.wake = undefined; }
  reply(frame: Frame, result: unknown): void { this.push({ jsonrpc: '2.0', id: frame.id, result }); }
  reject(frame: Frame, code: number, kind: string): void { this.push({ jsonrpc: '2.0', id: frame.id, error: { code, message: 'Simulated refusal', data: { kind, retryable: false } } }); }
  notify(method: string, params: Record<string, unknown>): void {
    this.cursor++;
    this.push({ jsonrpc: '2.0', method, params: { sessionId: this.sessionId, viewCursor: String(this.cursor).padStart(6, '0'), sourceRange: simulatedSourceRange(this.cursor, this.sessionId), ...params } });
  }
  usage(totalTokens: unknown = 123): void {
    this.notify('session/tokenUsage', { turnId: this.turnId, modelId: this.modelId, promptTokens: 100, totalTokens, cumulative: { totalTokens }, usage: { inputTokens: 100, outputTokens: 23, cachedTokens: 20, reasoningTokens: 10 } });
  }
  complete(terminal = 'completed'): void { this.notify('turn/completed', { turnId: this.turnId, terminal }); }
  item(text = 'Simulated response'): void {
    this.notify('item/completed', { item: { itemId: 'simulated-item', turnId: this.turnId, kind: 'assistantMessage', revision: 1, status: 'completed', text } });
  }
  question(): void {
    this.notify('userInput/requested', { turnId: this.turnId, userInputId: 'simulated-question', itemId: 'question-item', toolCallId: 'question-tool', toolName: 'ask', questions: [{ id: 'q1', question: 'Which option?', options: [{ label: 'A', value: 'a' }] }] });
  }
  approval(deny = true): void {
    this.notify('approval/requested', { approvalId: 'simulated-approval', currentRequirementId: { approvalId: 'simulated-approval', sourceIndex: 0 }, turnId: this.turnId, itemId: 'tool-item', toolCallId: 'tool', toolName: 'shell', rawArgs: '{}', availableChoices: [{ choiceId: 'allow', decision: 'approved' }, ...(deny ? [{ choiceId: 'deny', decision: 'denied' }] : [])] });
  }
  private request(frame: Frame): void {
    if (this.options.onRequest?.(frame, this) === true) return;
    const params = frame.params ?? {};
    switch (frame.method) {
      case 'initialize':
        this.experimental = this.options.experimental ?? (params.capabilities as { experimentalApi?: boolean } | undefined)?.experimentalApi ?? false;
        this.reply(frame, { experimentalApi: this.experimental, sandboxAvailability: this.options.sandboxAvailability ?? 'available', grantedCapabilities: [], museHome: '/simulated-home', platformFamily: 'unix', platformOs: 'macos', serverInfo: { name: 'simulation', version: this.options.version ?? protocolExpectation.binaryVersion }, schema: { version: 1, fingerprint: this.options.fingerprint ?? protocolExpectation.schemaFingerprint }, sessionDurability: this.options.durability ?? 'durable', userAgent: 'offline-simulation' }); break;
      case 'session/start':
        this.workspaceRoot = String(params.workspaceRoot);
        this.reply(frame, { session: this.sessionRecord(), viewCursor: '000000' }); break;
      case 'model/list':
        this.reply(frame, { models: this.options.models ?? [{ providerId: this.providerId, modelId: this.modelId, isDefault: true, isActive: true, variants: ['high', 'low'] }] }); break;
      case 'session/setModel':
        this.reply(frame, { commandId: params.commandId });
        setTimeout(() => { this.providerId = (params.model as { providerId: string }).providerId; this.modelId = (params.model as { modelId: string }).modelId; this.notify('session/modelChanged', { providerId: this.providerId, modelId: this.modelId, source: 'user' }); }, this.options.settingsDelayMs ?? 0); break;
      case 'session/setReasoningEffort':
        this.reply(frame, { commandId: params.commandId });
        if (this.options.effortReadback !== false) setTimeout(() => this.notify('session/reasoningEffortChanged', { reasoningEffort: params.reasoningEffort, source: 'user' }), this.options.settingsDelayMs ?? 0);
        break;
      case 'session/read':
        this.reply(frame, { session: this.sessionRecord() }); break;
      case 'turn/start':
        this.turnId = String(params.commandId);
        this.reply(frame, { commandId: params.commandId, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: this.turnId });
        this.notify('turn/started', { commandId: params.commandId, turnId: this.turnId });
        if (this.options.onTurn) this.options.onTurn(this);
        else { this.item(); this.usage(); this.complete(); }
        break;
      case 'approval/decide':
        this.reply(frame, { commandId: params.commandId, terminal: true }); this.usage(); this.complete(); break;
      case 'turn/cancel':
        this.reply(frame, { commandId: params.commandId });
        if (this.options.onCancel) this.options.onCancel(this);
        else { this.usage(); this.complete('cancelled'); }
        break;
      default: throw Error(`Unexpected simulated request: ${frame.method}`);
    }
  }
  private sessionRecord() {
    return { sessionId: this.sessionId, workspaceRoot: this.workspaceRoot, activeTurnId: this.turnId ?? null,
      ...(this.experimental && !this.options.hidePermissionState ? { permissionState: { profileId: this.options.permissionProfile ?? protocolExpectation.permissionProfile } } : {}),
      approvalMode: { mode: this.options.approvalMode ?? 'denyUnmatched', source: 'sessionStart', lastCommandId: null },
      providerId: this.providerId, modelId: this.options.readbackModel ?? this.modelId };
  }
}
