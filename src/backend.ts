import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config, Hypothesis, Revision, Work } from './types.js';
import { contained } from './workspaces.js';

export interface BackendRequest {
  config: Config; work: Work; base: Revision; prompt: string; signal: AbortSignal;
  backendIdentity?: Record<string, unknown>;
  /** Monotonic cumulative tokens for this attempt/session, never account-wide. */
  reportUsage?: (tokens: number) => void;
  record: (kind: string, data: unknown, identity?: Partial<Pick<Work, 'sessionId' | 'commandId' | 'turnId'>>) => void;
}
export interface BackendResult {
  outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'; tokens: number | null;
  proposal: string; hypotheses: Hypothesis[]; receipt: unknown; stopped: boolean;
  answerSettled?: boolean;
  observedTokens?: number;
}
export interface BackendAnswer { userInputId: string; answers: Parameters<import('@muse-code/sdk').Session['answerUserInput']>[1] }
export type BackendOperation = 'answer' | 'reconcile';
export interface Backend {
  execute(request: BackendRequest): Promise<BackendResult>;
  checkOperation?(operation: BackendOperation, config: Config): void;
  answer?(request: BackendRequest, answer: BackendAnswer): Promise<BackendResult>;
  reconcile?(request: BackendRequest): Promise<BackendResult>;
}

/** Deterministic edits for local development. This is explicitly not an AI agent. */
export class FixtureBackend implements Backend {
  async execute(request: BackendRequest): Promise<BackendResult> {
    if (request.config.backend.kind !== 'fixture') throw Error('Fixture backend configuration required');
    const plan = request.config.backend.plans[request.work.index];
    if (!plan) return { outcome: 'failed', tokens: 0, proposal: request.base.proposal, hypotheses: request.base.hypotheses, receipt: { reason: 'No fixture plan for this attempt' }, stopped: true };
    request.record('fixture.started', { index: request.work.index });
    try {
      await delay(plan.delayMs, undefined, { signal: request.signal });
      for (const [path, contents] of Object.entries(plan.files)) {
        request.signal.throwIfAborted();
        const target = contained(request.work.workspace, path);
        if (contents === null) rmSync(target, { force: true });
        else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents); }
      }
      return { outcome: plan.outcome, tokens: plan.tokens, proposal: plan.proposal ?? request.base.proposal, hypotheses: plan.hypotheses.length ? plan.hypotheses : request.base.hypotheses, receipt: { fixture: true, index: request.work.index, written: Object.keys(plan.files) }, stopped: true };
    } catch (error) {
      if (request.signal.aborted) return { outcome: 'cancelled', tokens: plan.tokens, proposal: request.base.proposal, hypotheses: request.base.hypotheses, receipt: { fixture: true, cancelled: true }, stopped: true };
      throw error;
    }
  }
}
