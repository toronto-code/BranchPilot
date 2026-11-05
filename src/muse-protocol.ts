import { createUuidV7Mint, MuseClient, MspError, readSessionDurability } from '@muse-code/sdk';
import type { MspHandshake, Session, SpawnedMspConnection } from '@muse-code/sdk';
import { z } from 'zod';
import type { BackendRequest, BackendResult } from './backend.js';
import { museCapabilities, untrackedMuseWork, verifyHandshake, verifySessionAuthority, waitForMuseSetting } from './muse-contract.js';
import { modelCatalogSchema, resolveMuseSettings } from './muse-models.js';

/** Only protocol facts: this is not a compatibility lock or a live-run gate. */
export interface MuseProtocolExpectation {
  binaryVersion: string; schemaFingerprint: string;
  permissionProfile: string; approvalMode: 'denyUnmatched';
  questionContinuationVerified?: boolean;
}
/** The owned host is the only injectable boundary; folds and commands use the real SDK. */
export interface MuseHost {
  initialize(params: Parameters<MspHandshake['initialize']>[0]): Promise<Pick<SpawnedMspConnection, 'connection' | 'initializeResult' | 'fingerprintWarning'>>;
  close(): Promise<unknown>;
}
export type MuseHostFactory = (hooks: { mintCommandId: () => string; onStderr: (chunk: string) => void }) => MuseHost;
export const terminalOutcome = (terminal: unknown): BackendResult['outcome'] => terminal === 'completed' || terminal === 'failed' || terminal === 'cancelled' ? terminal : 'unknown';

/** Shared protocol engine. Simulations supply an in-memory host; live callers must verify the lock first. */
export async function executeMuseProtocol(request: BackendRequest, expected: MuseProtocolExpectation, openHost: MuseHostFactory): Promise<BackendResult> {
  request.signal.throwIfAborted();
  let session: Session | undefined;
  let client: MuseClient | undefined;
  let nextMintIsTurn = false;
  let submissionPrepared = false;
  let turnCommandId: string | undefined;
  let terminalObserved = false;
  let tokens: number | null = null;
  let observedTokens: number | undefined;
  let recordedUsage = '';
  let poll: NodeJS.Timeout | undefined;
  let backstop: NodeJS.Timeout | undefined;
  let cancel: (() => void) | undefined;
  let stopRequested = false;
  let approvalFailed = false;
  let untrackedWork = false;
  const input = [{ type: 'text' as const, text: request.prompt }];
  const mint = createUuidV7Mint();
  const host = openHost({
    mintCommandId: () => {
      const commandId = mint();
      const turnSubmission = nextMintIsTurn;
      request.record('muse.command_prepared', {
        commandId, turnSubmission,
        ...(turnSubmission ? { method: 'turn/start', params: { commandId, sessionId: session!.sessionId, input } } : {}),
      }, turnSubmission ? { commandId } : undefined);
      if (turnSubmission) { submissionPrepared = true; turnCommandId = commandId; }
      nextMintIsTurn = false;
      return commandId;
    },
    onStderr: chunk => request.record('muse.stderr', { text: chunk.slice(0, 65536) }),
  });
  let closing: Promise<void> | undefined;
  const closeHost = () => closing ??= (async () => {
    try { await host.close(); }
    finally { await client?.close(); }
  })();
  const interrupt = () => {
    if (cancel) cancel();
    else void closeHost().catch(error => request.record('muse.close_error', { error: String(error) }));
  };
  const captureInput = () => {
    const inputs = session?.fold.pendingUserInputs() ?? [];
    if (inputs.length) {
      // Also called after settlement/EOF: a fast terminal can beat the poll.
      const signature = JSON.stringify(inputs);
      if (signature !== recordedInputs) { request.record('muse.input_required', inputs); recordedInputs = signature; }
      if (!terminalObserved) {
        if (expected.questionContinuationVerified) {
          request.record('muse.input_paused', { sessionId: session!.sessionId });
          void closeHost().catch(error => request.record('muse.close_error', { error: String(error) }));
        } else cancel?.();
      }
    }
  };
  let recordedInputs = '';
  const captureUsage = () => {
    const usage = session?.fold.sessionState.get('session/tokenUsage');
    if (usage) {
      const signature = JSON.stringify(usage);
      if (signature === recordedUsage) return;
      recordedUsage = signature; request.record('muse.usage', usage);
      // Fresh session, one turn. Do not add raw cache counters to this total.
      const total = usage.cumulative?.totalTokens;
      const valid = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0;
      tokens = valid && total >= (observedTokens ?? 0) ? total : null;
      if (valid) {
        observedTokens = Math.max(observedTokens ?? 0, total);
        if (!terminalObserved) request.reportUsage?.(observedTokens);
      }
    }
  };
  request.signal.addEventListener('abort', interrupt, { once: true });
  if (request.signal.aborted) interrupt();
  let result: BackendResult | undefined;
  try {
    const msp = await host.initialize({ clientInfo: { name: 'branchpilot', version: '0.1.0' }, capabilities: museCapabilities(expected.questionContinuationVerified === true) });
    request.record('muse.initialized', msp.initializeResult);
    verifyHandshake(msp, expected, request.record);
    request.signal.throwIfAborted();
    client = new MuseClient(msp.connection, { durability: readSessionDurability(msp.initializeResult) });
    session = await client.startSession({ workspaceRoot: request.work.workspace, permissionProfile: expected.permissionProfile, requirePermissionProfile: true, approvalMode: expected.approvalMode });
    request.record('muse.session', { sessionId: session.sessionId, durability: client.durability }, { sessionId: session.sessionId });
    session.onApproval(approval => {
      request.record('muse.approval', approval);
      const denied = approval.availableChoices.find(choice => choice.decision === 'denied') ?? approval.availableChoices.find(choice => choice.decision === 'abort');
      if (!denied) throw Error('Host offered no denial choice');
      return { choiceId: denied.choiceId };
    });
    session.onApprovalError(error => {
      request.record('muse.approval_error', { ...error, error: 'error' in error ? String(error.error) : undefined });
      approvalFailed = true;
      cancel?.();
    });
    const catalog = await msp.connection.request('model/list', { sessionId: session.sessionId });
    request.record('muse.models', catalog);
    const rows = modelCatalogSchema.parse(catalog.models);
    const requested = request.config.agent;
    const selection = resolveMuseSettings(requested, rows);
    const { model, effort } = selection;
    request.record('muse.settings_selected', { requested, selection });
    if (selection.setModel && model) {
      await msp.connection.command('session/setModel', { sessionId: session.sessionId, model: { providerId: model.providerId, modelId: model.modelId } });
      await waitForMuseSetting(async () => {
        const read = await msp.connection.request('session/read', { sessionId: session!.sessionId });
        const value = z.object({ session: z.object({ providerId: z.string().nullable(), modelId: z.string().nullable() }).passthrough() }).parse(read).session;
        return value.providerId === model.providerId && value.modelId === model.modelId;
      }, request.signal, request.config.budget.perAttempt.timeoutSeconds, 'the requested model');
    }
    if (effort !== undefined) {
      await msp.connection.command('session/setReasoningEffort', { sessionId: session.sessionId, reasoningEffort: effort });
      await waitForMuseSetting(async () => session!.fold.sessionState.get('session/reasoningEffortChanged')?.reasoningEffort === effort, request.signal, request.config.budget.perAttempt.timeoutSeconds, 'the requested effort');
    }
    const readback = await msp.connection.request('session/read', { sessionId: session.sessionId });
    request.record('muse.settings_readback', { requested, readback });
    verifySessionAuthority(readback.session, session.sessionId, request.work.workspace, expected);
    if (selection.setModel || effort !== undefined) {
      const settings = z.object({ session: z.object({ providerId: z.string().nullable(), modelId: z.string().nullable() }).passthrough() }).parse(readback).session;
      if (!model || settings.providerId !== model.providerId || settings.modelId !== model.modelId) throw Error('Host has not confirmed the requested model');
    }
    if (effort !== undefined) {
      const confirmed = session.fold.sessionState.get('session/reasoningEffortChanged');
      if (!confirmed || confirmed.reasoningEffort !== effort) throw Error('Host has not confirmed the requested effort');
    }
    const confirmedModel = z.object({ providerId: z.string().nullable(), modelId: z.string().nullable() }).passthrough().parse(readback.session);
    const displayLabel = rows.find(row => row.providerId === confirmedModel.providerId && row.modelId === confirmedModel.modelId)?.displayLabel;
    if (confirmedModel.providerId && confirmedModel.modelId) request.record('muse.settings_confirmed', {
      providerId: confirmedModel.providerId, modelId: confirmedModel.modelId,
      ...(displayLabel !== undefined ? { displayLabel } : {}), ...(effort !== undefined ? { effort } : {}), reason: selection.reason,
    });
    request.signal.throwIfAborted();
    nextMintIsTurn = true;
    const turn = await session.sendUserTurn({ input });
    request.record('muse.turn', { turnId: turn.turnId }, { turnId: turn.turnId });
    cancel = () => {
      if (stopRequested || terminalObserved) return;
      stopRequested = true;
      request.record('muse.cancel_requested', { turnId: turn.turnId });
      void msp.connection.command('turn/cancel', { sessionId: session!.sessionId, turnId: turn.turnId }).then(
        ack => request.record('muse.cancel_ack', ack),
        error => {
          if (!(error instanceof MspError && error.kind === 'commandRejected' && error.data.reason === 'already_terminal')) request.record('muse.cancel_error', { error: String(error) });
        },
      );
      // An acknowledgement is admission only. Without a terminal, close and
      // retain uncertainty even when the owned host's shutdown succeeds.
      backstop = setTimeout(() => { void closeHost().catch(error => request.record('muse.close_error', { error: String(error) })); }, request.config.budget.cancellationGraceSeconds * 1000);
    };
    if (request.signal.aborted || approvalFailed) cancel();
    captureInput(); captureUsage();
    poll = setInterval(() => { captureInput(); captureUsage(); }, 100);
    const items = (async () => { for await (const item of turn.items()) {
      request.record('muse.item', item);
      if (untrackedMuseWork(item) && !untrackedWork) {
        untrackedWork = true; request.record('muse.untracked_work', { item, reason: 'Parent session totals exclude child work; independent termination and usage evidence are required' }); cancel?.();
      }
    } })();
    let streamFailed = false;
    const observedItems = items.catch(error => { streamFailed = true; request.record('muse.stream_error', { error: String(error) }); });
    const outcome = await turn.completed;
    await observedItems;
    request.record('muse.turn_outcome', outcome);
    terminalObserved = outcome.kind === 'unqueued' || (outcome.kind === 'completed' && terminalOutcome(outcome.params.terminal) !== 'unknown');
    captureInput(); captureUsage();
    result = {
      outcome: outcome.kind === 'completed' ? terminalOutcome(outcome.params.terminal) : outcome.kind === 'unqueued' ? 'cancelled' : 'unknown',
      tokens, ...(observedTokens !== undefined ? { observedTokens } : {}), proposal: request.base.proposal, hypotheses: request.base.hypotheses, receipt: outcome,
      stopped: terminalObserved && !streamFailed,
    };
    if (approvalFailed && result.outcome === 'completed') result.outcome = 'failed';
  } catch (error) {
    captureInput(); captureUsage();
    const observedTurn = session?.fold.turns().find(turn => turn.commandId === turnCommandId && turnCommandId !== undefined);
    if (observedTurn) request.record('muse.turn_state', observedTurn, { turnId: observedTurn.turnId });
    request.record('muse.error', { error: String(error) });
    result = { outcome: submissionPrepared ? 'unknown' : request.signal.aborted ? 'cancelled' : 'failed', tokens: submissionPrepared ? tokens : 0, ...(observedTokens !== undefined ? { observedTokens } : {}), proposal: request.base.proposal, hypotheses: request.base.hypotheses, receipt: { error: String(error), submissionPrepared }, stopped: !submissionPrepared };
  } finally {
    if (poll) clearInterval(poll);
    if (backstop) clearTimeout(backstop);
    request.signal.removeEventListener('abort', interrupt);
    try { await closeHost(); }
    catch (error) { request.record('muse.close_error', { error: String(error) }); if (result) result.stopped = false; }
  }
  if (untrackedWork) result = { ...result!, tokens: null, stopped: false, outcome: 'unknown' };
  return result!;
}
