import { createUuidV7Mint, MuseClient, readSessionDurability } from '@muse-code/sdk';
import type { Session, Turn } from '@muse-code/sdk';
import { z } from 'zod';
import type { BackendAnswer, BackendRequest, BackendResult } from './backend.js';
import type { MuseHostFactory, MuseProtocolExpectation } from './muse-protocol.js';
import { terminalOutcome } from './muse-protocol.js';
import { validateBackendAnswer } from './backend-input.js';
import { museCapabilities, untrackedMuseWork, verifyHandshake, verifySessionAuthority } from './muse-contract.js';

const readSchema = z.object({
  session: z.object({ sessionId: z.string(), workspaceRoot: z.string().nullable(), activeTurnId: z.string().nullable(), permissionState: z.object({ profileId: z.string() }).passthrough(), providerId: z.string().nullable().optional(), modelId: z.string().nullable().optional() }).passthrough(),
  lastTurn: z.object({ turnId: z.string(), terminal: z.string() }).passthrough().optional(),
  pendingRequests: z.array(z.object({ kind: z.string(), userInputId: z.string().optional(), viewCursor: z.string() }).passthrough()),
  history: z.object({ mode: z.string(), items: z.array(z.record(z.unknown())).nullable(), snapshot: z.object({ schemaVersion: z.literal(1), state: z.record(z.unknown()) }).passthrough().nullable() }).passthrough(),
  viewCursor: z.string(),
}).passthrough();
const positionSchema = z.object({ id: z.string().min(1), sequence: z.number().finite().int().nonnegative() }).passthrough();
const sourceRangeSchema = z.object({ stream: z.object({ id: z.string().min(1), kind: z.string().min(1) }).passthrough(), first: positionSchema, last: positionSchema }).passthrough();
const pageSchema = z.object({ events: z.array(z.object({ method: z.string(), params: z.object({ sessionId: z.string().min(1), viewCursor: z.string().min(1), sourceRange: sourceRangeSchema }).passthrough() })).max(1000), nextCursor: z.string().nullable() }).passthrough();
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Explicit read/reattach operations only. This function never submits or replays turn/start. */
export async function recoverMuseProtocol(request: BackendRequest, expected: MuseProtocolExpectation, openHost: MuseHostFactory, answer?: BackendAnswer): Promise<BackendResult> {
  const work = request.work;
  if (!work.sessionId || !work.commandId) throw Error('Recovery needs the durable session and original command IDs');
  if (answer && !work.turnId) throw Error('Answering requires an observed turn ID');
  if (answer && work.untrackedWork) throw Error('Untracked child work requires independent termination and usage resolution before continuation');
  request.signal.throwIfAborted();
  let answerMint = false; let answerCommandId: string | undefined;
  const mint = createUuidV7Mint();
  const host = openHost({ mintCommandId: () => {
    const commandId = mint();
    if (answerMint) {
      request.record('muse.answer_prepared', { commandId, method: 'userInput/answer', params: { commandId, sessionId: work.sessionId, ...answer } });
      answerCommandId = commandId; answerMint = false;
    } else request.record('muse.recovery_command_prepared', { commandId });
    return commandId;
  }, onStderr: chunk => request.record('muse.stderr', { text: chunk.slice(0, 65536) }) });
  let client: MuseClient | undefined; let session: Session | undefined;
  let inputPoll: NodeJS.Timeout | undefined;
  let cancelBackstop: NodeJS.Timeout | undefined;
  let cancelTurn: (() => void) | undefined;
  let tokens: number | null = null; let result: BackendResult | undefined; let turn: Turn | undefined;
  let untrackedWork = Boolean(work.untrackedWork);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { try { await host.close(); } finally { await client?.close(); } })();
  const abort = () => { if (cancelTurn) cancelTurn(); else void close().catch(() => undefined); };
  request.signal.addEventListener('abort', abort, { once: true });
  const baseResult = () => ({ tokens, proposal: request.base.proposal, hypotheses: request.base.hypotheses });
  try {
    const msp = await host.initialize({ clientInfo: { name: 'branchpilot', version: '0.1.0' }, capabilities: museCapabilities(Boolean(answer)) });
    request.record('muse.recovery_initialized', msp.initializeResult);
    verifyHandshake(msp, expected, request.record);
    if (readSessionDurability(msp.initializeResult).kind !== 'durable') throw Error('Host offers no durable session recovery guarantee');
    request.signal.throwIfAborted();
    const raw = await msp.connection.request('session/read', { sessionId: work.sessionId, excludeItems: false });
    request.record('muse.recovery_read', raw);
    const read = readSchema.parse(raw);
    const verifySession = (value: typeof read.session) => {
      if (value.sessionId !== work.sessionId || value.workspaceRoot !== work.workspace || value.permissionState.profileId !== expected.permissionProfile) throw Error('Recovery session, workspace or permission profile does not match the original work');
      const model = request.config.agent.model;
      if (answer && model.kind === 'explicit' && (value.providerId !== model.providerId || value.modelId !== model.modelId)) throw Error('Resumed model differs from the requested settings');
      if (answer && (model.kind === 'preference' || work.agentSettings)) {
        if (!work.agentSettings || value.providerId !== work.agentSettings.providerId || value.modelId !== work.agentSettings.modelId) throw Error('Resumed model differs from the original confirmed selection');
      }
      if (answer) verifySessionAuthority(value, work.sessionId!, work.workspace, expected);
    };
    verifySession(read.session);
    const events: z.infer<typeof pageSchema>['events'] = [];
    const cursors = new Set<string>(); let cursor: string | undefined;
    // Read the served history without taking a writer lease or re-running work.
    for (let page = 0; ; page++) {
      request.signal.throwIfAborted();
      if (page >= 100) throw Error('Recovery history exceeds the bounded page limit');
      const rawPage = await msp.connection.request('view/page', { sessionId: work.sessionId, limit: 1000, direction: 'forward', ...(cursor ? { cursor } : {}) });
      const next = pageSchema.parse(rawPage);
      request.record('muse.recovery_page', rawPage); events.push(...next.events);
      if (next.nextCursor === null) break;
      if (cursors.has(next.nextCursor)) throw Error('Recovery history cursor did not advance');
      cursors.add(next.nextCursor); cursor = next.nextCursor;
    }
    if (events.some(e => e.params.sessionId !== work.sessionId)) throw Error('Recovery history contains a foreign session');
    const historyItems = [...(read.history.items ?? []), ...(Array.isArray(read.history.snapshot?.state.items) ? read.history.snapshot.state.items : []), ...events.map(e => e.params.item)];
    if (work.untrackedWork || historyItems.some(untrackedMuseWork)) {
      untrackedWork = true;
      request.record('muse.untracked_work', { reason: 'Parent-only reconciliation cannot settle child work', sessionId: work.sessionId });
      throw Error('Untracked child work requires independent termination and complete usage evidence');
    }
    const matchingStart = events.find(e => e.method === 'turn/started' && e.params.commandId === work.commandId);
    const matchingItem = [...(read.history.items ?? []), ...(Array.isArray(read.history.snapshot?.state.items) ? read.history.snapshot.state.items as Record<string, unknown>[] : [])].find(item => item.commandId === work.commandId && typeof item.turnId === 'string');
    const observedId = matchingStart?.params.turnId ?? matchingItem?.turnId;
    const targetId = work.turnId ?? (typeof observedId === 'string' ? observedId : undefined);
    if (!targetId || (observedId !== undefined && observedId !== targetId)) throw Error('Cannot establish the original command-to-turn identity');
    request.record('muse.recovery_identity', { sessionId: work.sessionId, turnId: targetId, commandId: work.commandId }, { turnId: targetId });
    if (events.some(e => e.method === 'turn/started' && e.params.turnId !== targetId)) throw Error('The fresh attempt session contains another turn; cumulative usage is ambiguous');
    let latestUsageIndex = -1; let latestUsage: number | null = null; let lastAnswerIndex = -1;
    for (const [index, event] of events.entries()) {
      if (event.method === 'userInput/settled' && event.params.outcome === 'answered' && (event.params.turnId === undefined || event.params.turnId === targetId)) lastAnswerIndex = index;
      if (event.method !== 'session/tokenUsage' || event.params.turnId !== targetId) continue;
      const total = count((event.params.cumulative as { totalTokens?: unknown } | undefined)?.totalTokens);
      latestUsageIndex = index; latestUsage = total;
      if (total !== null) tokens = Math.max(tokens ?? 0, total);
    }
    const terminals = events.filter(e => e.method === 'turn/completed' && e.params.turnId === targetId);
    const terminalEvent = terminals[0];
    if (terminals.some(e => e.params.terminal !== terminalEvent!.params.terminal) || (terminalEvent && read.lastTurn?.turnId === targetId && read.lastTurn.terminal !== terminalEvent.params.terminal)) throw Error('Host returned conflicting terminal evidence');
    const terminal = typeof terminalEvent?.params.terminal === 'string' ? terminalEvent.params.terminal : read.lastTurn?.turnId === targetId ? read.lastTurn.terminal : undefined;
    const pending = events.filter(e => e.method === 'userInput/requested' && read.pendingRequests.some(p => p.kind === 'userInput' && p.userInputId === e.params.userInputId)).map(e => e.params);
    if (pending.length) request.record('muse.input_required', pending);
    const priorAnswer = work.pendingAnswer ?? work.usageAfterAnswer;
    const answerSettled = priorAnswer ? events.some(e => e.method === 'userInput/settled' && e.params.userInputId === priorAnswer.userInputId && e.params.decidedByCommandId === priorAnswer.commandId && e.params.outcome === 'answered') : false;
    if (!answer) {
      const stopped = terminalOutcome(terminal) !== 'unknown' && read.session.activeTurnId === null;
      const completeUsage = latestUsage !== null && latestUsage >= (tokens ?? 0) && latestUsageIndex > lastAnswerIndex && (!priorAnswer || answerSettled);
      result = { ...baseResult(), tokens: completeUsage ? tokens : null, ...(tokens !== null ? { observedTokens: tokens } : {}), outcome: stopped ? terminalOutcome(terminal) : 'unknown', stopped, answerSettled, receipt: { operation: 'reconcile', sessionId: work.sessionId, turnId: targetId, terminal: terminal ?? null, observedHead: read.viewCursor, completeUsage } };
    } else {
      if (terminal || read.session.activeTurnId !== targetId) throw Error('Original turn is terminal or no longer active; reconcile it instead of submitting a new turn');
      const requested = [...events].reverse().find(e => e.method === 'userInput/requested' && e.params.userInputId === answer.userInputId);
      if (!requested || !read.pendingRequests.some(p => p.kind === 'userInput' && p.userInputId === answer.userInputId)) throw Error('Question is no longer pending on the original session');
      validateBackendAnswer(answer, requested.params, work.sessionId, targetId);
      client = new MuseClient(msp.connection, { durability: readSessionDurability(msp.initializeResult) });
      session = await client.resumeSession({ sessionId: work.sessionId, permissionProfile: expected.permissionProfile, excludeItems: true, onApproval: approval => {
        request.record('muse.approval', approval);
        const deny = approval.availableChoices.find(c => c.decision === 'denied') ?? approval.availableChoices.find(c => c.decision === 'abort');
        if (!deny) { abort(); throw Error('No denial choice on resumed approval'); }
        return { choiceId: deny.choiceId };
      }, onApprovalError: error => { request.record('muse.approval_error', { error: String(error) }); abort(); } });
      if (session.sessionId !== work.sessionId) throw Error('Host resumed the wrong session');
      const opened = readSchema.parse(session.opening!.result); verifySession(opened.session);
      if (opened.session.activeTurnId !== targetId || opened.lastTurn?.turnId === targetId) throw Error('Original turn settled during reattachment');
      if (!opened.pendingRequests.some(p => p.kind === 'userInput' && p.userInputId === answer.userInputId)) throw Error('Question settled during reattachment');
      if (request.config.agent.effort.kind !== 'host-default') {
        const expectedEffort = request.config.agent.effort.kind === 'explicit' ? request.config.agent.effort.value : work.agentSettings?.effort;
        if (!expectedEffort) throw Error('Original effort selection is missing; refusing to select a new effort during recovery');
        const effort = read.history.snapshot?.state.reasoningEffort as { reasoningEffort?: string } | undefined;
        const event = [...events].reverse().find(e => e.method === 'session/reasoningEffortChanged');
        if ((event?.params.reasoningEffort ?? effort?.reasoningEffort) !== expectedEffort) throw Error('Resumed effort is unconfirmed');
      }
      request.signal.throwIfAborted();
      turn = session.turn(targetId);
      let cancelRequested = false;
      cancelTurn = () => {
        if (cancelRequested) return; cancelRequested = true;
        request.record('muse.cancel_requested', { turnId: targetId, operation: 'answer' });
        void msp.connection.command('turn/cancel', { sessionId: work.sessionId!, turnId: targetId }).then(
          ack => request.record('muse.cancel_ack', ack),
          error => request.record('muse.cancel_error', { error: String(error) }),
        );
        cancelBackstop = setTimeout(() => { void close().catch(() => undefined); }, request.config.budget.cancellationGraceSeconds * 1000);
      };
      const usageBeforeAnswer = session.fold.sessionState.get('session/tokenUsage');
      // Attach both observers before sending: an answer can produce an immediate terminal.
      let streamError: unknown;
      const items = (async () => { for await (const item of turn!.items()) {
        request.record('muse.item', item);
        if (untrackedMuseWork(item)) { untrackedWork = true; request.record('muse.untracked_work', { item, reason: 'Parent session usage excludes child work' }); streamError = Error('Untracked child work'); cancelTurn?.(); }
      } })().catch(error => { streamError = error; });
      const completion = turn.completed.then(value => ({ value }), error => ({ error }));
      answerMint = true;
      const ack = await session.answerUserInput(answer.userInputId, answer.answers);
      request.record('muse.answer_ack', ack);
      const pauseForNextQuestion = () => {
        const usage = count(session!.fold.sessionState.get('session/tokenUsage')?.cumulative.totalTokens);
        if (usage !== null) { tokens = Math.max(tokens ?? 0, usage); request.reportUsage?.(tokens); }
        const pending = session!.fold.pendingUserInputs().filter(input => input.userInputId !== answer.userInputId);
        if (pending.length) { request.record('muse.input_required', pending); void close().catch(() => undefined); }
      };
      pauseForNextQuestion(); inputPoll = setInterval(pauseForNextQuestion, 100);
      const completed = await completion;
      await items;
      if ('error' in completed) throw completed.error;
      const settled = session.fold.settledUserInputs().find(input => input.userInputId === answer.userInputId);
      request.record('muse.input_settlement', settled ?? { missing: true });
      const usage = session.fold.sessionState.get('session/tokenUsage');
      const latest = count(usage?.cumulative.totalTokens); if (latest !== null) tokens = Math.max(tokens ?? 0, latest);
      const completeUsage = latest !== null && usage?.viewCursor !== usageBeforeAnswer?.viewCursor && latest >= (tokens ?? 0);
      const confirmed = settled?.outcome === 'answered' && settled.decidedByCommandId === answerCommandId;
      const done = completed.value.kind === 'completed' && terminalOutcome(completed.value.params.terminal) !== 'unknown';
      result = { ...baseResult(), tokens: completeUsage ? tokens : null, ...(tokens !== null ? { observedTokens: tokens } : {}), outcome: completed.value.kind === 'completed' && confirmed ? terminalOutcome(completed.value.params.terminal) : 'unknown', stopped: done && confirmed && !streamError, answerSettled: confirmed, receipt: { operation: 'answer', ack, settled, outcome: completed.value, completeUsage } };
    }
  } catch (error) {
    const latest = count(session?.fold.sessionState.get('session/tokenUsage')?.cumulative.totalTokens);
    if (latest !== null) tokens = Math.max(tokens ?? 0, latest);
    request.record('muse.recovery_error', { error: String(error) });
    const settled = session?.fold.settledUserInputs().find(input => input.userInputId === answer?.userInputId);
    const confirmed = settled?.outcome === 'answered' && settled.decidedByCommandId === answerCommandId && answerCommandId !== undefined;
    const pending = session?.fold.pendingUserInputs() ?? [];
    if (pending.length) request.record('muse.input_required', pending);
    result = { ...baseResult(), outcome: 'unknown', stopped: false, answerSettled: confirmed, receipt: { error: String(error), answerCommandId, settled } };
  } finally {
    if (inputPoll) clearInterval(inputPoll);
    if (cancelBackstop) clearTimeout(cancelBackstop);
    request.signal.removeEventListener('abort', abort);
    try { await close(); } catch (error) { request.record('muse.close_error', { error: String(error) }); if (result) result.stopped = false; }
  }
  if (untrackedWork) result = { ...result!, tokens: null, stopped: false, outcome: 'unknown' };
  return result!;
}
