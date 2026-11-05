import type { State, Strategy } from './types.js';
import { feasible, frontier, resultsFor } from './evaluation.js';

export interface DevelopmentPlan { baseId: string; candidateId?: string; reason: string }
/** Pure proposal functions; no IO or resource allocation. All counters survive switches. */
export function nextPlan(state: State): DevelopmentPlan | undefined {
  if (state.finalists || !state.baselineId) return;
  const attempts = Object.values(state.works).filter(w => w.kind === 'attempt' && w.state !== 'released');
  const current = attempts.filter(w => w.epoch === state.epoch);
  const strategy = state.strategy;
  switch (strategy.name) {
    case 'direct': return current.length ? undefined : { baseId: state.baselineId, reason: 'One direct attempt from the baseline' };
    case 'retry': {
      const previousAttempt = attempts.at(-1);
      const candidateId = previousAttempt?.candidateId;
      const root = state.revisions.filter(r => r.candidateId === candidateId).at(-1) ?? state.revisions.find(r => r.id === (previousAttempt?.revisionId ?? state.baselineId))!;
      const count = candidateId ? attempts.filter(a => a.candidateId === candidateId).length : 0;
      if (count >= strategy.maxAttemptsPerCandidate || (root.candidateId === candidateId && state.config.task.type === 'code' && feasible(state.config, resultsFor(state, root.id)))) return;
      return { baseId: root.id, candidateId, reason: 'Continue the candidate with structured development feedback' };
    }
    case 'best-of-n': return current.length >= strategy.n ? undefined : { baseId: state.baselineId, reason: `Independent alternative ${current.length + 1}/${strategy.n} from the shared baseline` };
    case 'tree': {
      const preferred = frontier(state);
      const roots = preferred.length ? preferred : [state.revisions.find(r => r.id === state.baselineId)!];
      const parentIds = new Set(attempts.map(work => work.revisionId));
      const allocatedParents = state.revisions.filter(revision => parentIds.has(revision.id));
      const depths = [...new Set([...roots, ...allocatedParents].map(revision => revision.depth))].filter(depth => depth < strategy.maxDepth).sort((a, b) => a - b);
      for (const depth of depths) {
        // An allocated parent keeps its beam slot even if new evidence changes
        // the frontier. Recomputing the slice from scratch can expand unlimited
        // parents at one depth despite a width of one.
        const allocated = allocatedParents.filter(r => r.depth === depth);
        const eligible = roots.filter(r => r.depth === depth && !allocated.some(a => a.id === r.id));
        const beam = [...allocated, ...eligible].slice(0, strategy.width);
        for (const base of beam) {
          const children = attempts.filter(w => w.revisionId === base.id);
          if (children.length < strategy.maxChildren) return { baseId: base.id, reason: `Expand depth ${base.depth} within width/depth/child limits` };
        }
      }
      return;
    }
  }
}
export function autoSwitch(state: State): { strategy: Strategy; reason: string } | undefined {
  if (state.config.policy.mode !== 'auto' || state.finalists) return;
  const tried = new Set(state.decisions.filter(d => d.action.startsWith('switch:')).map(d => d.action.slice(7)));
  const latest = state.revisions.filter(r => r.attemptId).at(-1);
  if (!latest) return;
  const results = resultsFor(state, latest.id);
  if (results.some(e => e.failureType === 'infrastructure' || e.failureType === 'timeout')) return;
  if (state.config.task.type === 'code' && feasible(state.config, results)) return;
  if (state.strategy.name === 'retry' && repeatedFailedRevision(state) && !tried.has('best-of-n') && state.config.policy.allowedStrategies.includes('best-of-n')) return {
    strategy: { name: 'best-of-n', n: 3 },
    reason: 'Two completed attempts produced identical candidate content and identical failed development evidence; explore independent alternatives instead of repeating the same repair',
  };
  if (state.strategy.name === 'direct' && results.some(e => e.validity === 'fail') && state.config.policy.allowedStrategies.includes('retry')) return { strategy: { name: 'retry', maxAttemptsPerCandidate: 3 }, reason: 'Actionable development failure: allow at most two additional attempts on this candidate' };
  if (!nextPlan(state) && !tried.has('best-of-n') && state.config.policy.allowedStrategies.includes('best-of-n')) return { strategy: { name: 'best-of-n', n: 3 }, reason: 'Current strategy exhausted; compare up to three independent alternatives within remaining budget' };
  if (!nextPlan(state) && !tried.has('tree') && frontier(state).length > 1 && state.config.policy.allowedStrategies.includes('tree')) return { strategy: { name: 'tree', width: 2, maxDepth: 3, maxChildren: 2 }, reason: 'Multiple feasible tradeoffs remain; expand a bounded beam' };
}

/** A narrow stagnation signal, not a general claim that failed ideas are useless. */
function repeatedFailedRevision(state: State): boolean {
  const pair = state.revisions.filter(r => r.attemptId).slice(-2);
  if (pair.length !== 2) return false;
  const [before, after] = pair;
  if (before!.candidateId !== after!.candidateId || before!.snapshot !== after!.snapshot || before!.proposal !== after!.proposal || JSON.stringify(before!.hypotheses) !== JSON.stringify(after!.hypotheses)) return false;
  const required = state.config.task.evaluators.filter(e => e.split === 'development');
  if (required.some(e => e.kind !== 'executable')) return false;
  const signature = (revisionId: string) => {
    const evaluations = resultsFor(state, revisionId);
    if (!required.every(spec => evaluations.some(e => e.evaluatorId === spec.id)) || !evaluations.some(e => e.validity === 'fail') || evaluations.some(e => !['pass', 'fail'].includes(e.validity) || ['infrastructure', 'timeout', 'insufficient_evidence'].includes(e.failureType ?? ''))) return;
    return JSON.stringify(evaluations.map(({ evaluatorId, definitionDigest, environmentDigest, kind, validity, failureType, checks, metrics, feedback, findings }) => ({ evaluatorId, definitionDigest, environmentDigest, kind, validity, failureType, checks, metrics, feedback, findings })).sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId)));
  };
  if (pair.some(r => { const work = state.works[r.attemptId!]; return !work || work.state !== 'settled' || work.outcome !== 'completed'; })) return false;
  const previous = signature(before!.id);
  return previous !== undefined && previous === signature(after!.id);
}
