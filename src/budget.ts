import type { Resources, State, Work } from './types.js';

export const zero = (): Resources => ({ tokens: 0, workSeconds: 0, attempts: 0, experiments: 0 });
export const keys = ['tokens', 'workSeconds', 'attempts', 'experiments'] as const;
export function add(to: Resources, value: Resources): void { for (const key of keys) to[key] += value[key]; }
export interface BudgetView { spent: Resources; reserved: Resources; unknown: Resources; available: Resources; active: number }
export class BudgetError extends Error {}
export function budgetView(state: State, final = false): BudgetView {
  const spent = zero(); const reserved = zero(); const unknown = zero(); let active = 0;
  for (const work of Object.values(state.works)) {
    if (work.state === 'released') continue;
    for (const reservation of Object.values(work.evaluationReservations ?? {})) add(reserved, reservation);
    if (work.state === 'unknown') {
      // Observed usage is a lower bound while termination is unproven. Never
      // hide an overrun behind the smaller admission estimate.
      for (const key of keys) unknown[key] += Math.max(work.reservation[key], work.actual?.[key] ?? 0, key === 'tokens' ? work.observedTokens ?? 0 : 0);
      active++; continue;
    }
    if (work.state === 'reserved' || work.state === 'running') { add(reserved, { ...work.reservation, tokens: Math.max(work.reservation.tokens, work.observedTokens ?? 0) }); active++; continue; }
    if (!work.actual) throw Error('Settled work must have actual usage');
    for (const key of keys) {
      const amount = work.actual[key];
      if (amount === null) unknown[key] += Math.max(work.reservation[key], key === 'tokens' ? work.observedTokens ?? 0 : 0);
      else spent[key] += amount;
    }
  }
  const available = zero();
  for (const key of keys) available[key] = Math.max(0, state.config.budget.total[key] - spent[key] - reserved[key] - unknown[key] - (final ? 0 : state.config.budget.finalizationReserve[key]));
  return { spent, reserved, unknown, available, active };
}
export function finalizationSeconds(state: State): number {
  return state.config.task.evaluators.filter(e => e.split === 'held_out').reduce((n, e) => n + e.timeoutSeconds, 0) * (state.config.task.selection.maxFinalists + 1);
}
export function admit(state: State, cost: Resources, phase: Work['phase'], now = Date.now()): void {
  const final = phase === 'held_out' || phase === 'report'; const view = budgetView(state, final);
  if (Object.values(state.works).some(w => w.state === 'unknown') || keys.some(k => view.unknown[k] > 0)) throw new BudgetError('Unresolved usage or work must be reconciled before scheduling');
  if (view.active >= state.config.budget.maxConcurrency) throw new BudgetError('Concurrency limit reached');
  const remaining = (Date.parse(state.deadline) - now) / 1000;
  const wallReserve = final ? 0 : finalizationSeconds(state) + state.config.budget.cancellationGraceSeconds;
  if (remaining < cost.workSeconds + wallReserve) throw new BudgetError('Insufficient wall time for work and finalization');
  for (const key of keys) if (cost[key] > view.available[key] + 1e-9) throw new BudgetError(`Insufficient ${key}: needs ${cost[key]}, available ${view.available[key]}`);
}
export function actualUsage(work: Work, tokens: number | null, seconds: number): NonNullable<Work['actual']> {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) throw Error('Invalid token usage');
  if (!Number.isFinite(seconds) || seconds < 0) throw Error('Invalid work seconds');
  return { tokens, workSeconds: seconds, attempts: work.kind === 'attempt' ? 1 : 0, experiments: work.kind === 'experiment' ? 1 : 0 };
}
