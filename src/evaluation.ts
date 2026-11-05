import { z } from 'zod';
import type { Config, Evaluation, Measurement, Revision, State } from './types.js';
import { midpoint } from './statistics.js';

export const outputSchema = z.object({
  validity: z.enum(['pass', 'fail', 'inconclusive', 'not_applicable']),
  checks: z.array(z.object({ id: z.string(), outcome: z.enum(['pass', 'fail', 'unknown']) }).strict()).default([]),
  metrics: z.array(z.object({ name: z.string(), unit: z.string(), value: z.number().finite() }).strict()).default([]),
  feedback: z.string().default(''), findings: z.array(z.string()).default([]),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.checks.map(c => c.id)).size !== v.checks.length || new Set(v.metrics.map(m => m.name)).size !== v.metrics.length) ctx.addIssue({ code: 'custom', message: 'Duplicate check or metric names' });
  if (v.validity === 'pass' && v.checks.some(c => c.outcome !== 'pass')) ctx.addIssue({ code: 'custom', message: 'Passing output cannot contain failed/unknown checks' });
});
export type EvaluatorOutput = z.infer<typeof outputSchema>;
export function aggregate(samples: EvaluatorOutput[]): Pick<Evaluation, 'validity' | 'checks' | 'metrics' | 'feedback' | 'findings'> {
  if (!samples.length) throw Error('No evaluation samples');
  const first = samples[0]!;
  const signature = (v: EvaluatorOutput) => JSON.stringify({ checks: v.checks.map(c => c.id).sort(), metrics: v.metrics.map(m => [m.name, m.unit]).sort() });
  if (samples.some(s => signature(s) !== signature(first))) throw Error('Evaluator schema changed between repetitions');
  const metrics: Measurement[] = first.metrics.map(m => {
    const values = samples.map(s => s.metrics.find(x => x.name === m.name)!.value).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const estimate = values.length % 2 ? values[middle]! : midpoint(values[middle - 1]!, values[middle]!);
    return { name: m.name, unit: m.unit, samples: values, estimate, uncertainty: values.length > 1 ? { kind: 'range', low: values[0]!, high: values.at(-1)! } : { kind: 'unknown' } };
  });
  return {
    validity: samples.some(s => s.validity === 'fail') ? 'fail' : samples.some(s => s.validity === 'inconclusive') ? 'inconclusive' : samples.every(s => s.validity === 'not_applicable') ? 'not_applicable' : samples.some(s => s.validity === 'not_applicable') ? 'inconclusive' : 'pass',
    checks: first.checks.map(c => ({ id: c.id, outcome: samples.some(s => s.checks.find(x => x.id === c.id)!.outcome === 'fail') ? 'fail' : samples.some(s => s.checks.find(x => x.id === c.id)!.outcome === 'unknown') ? 'unknown' : 'pass' })),
    metrics, feedback: [...new Set(samples.map(s => s.feedback).filter(Boolean))].join('\n'), findings: [...new Set(samples.flatMap(s => s.findings))],
  };
}
export function resultsFor(state: State, revisionId: string, split: Evaluation['split'] = 'development'): Evaluation[] {
  return state.evaluations.filter(e => e.revisionId === revisionId && e.split === split);
}
export function feasible(config: Config, evaluations: Evaluation[], options: { final?: boolean; baseline?: boolean } = {}): boolean {
  if (!evaluations.length || evaluations.some(e => e.validity !== 'pass')) return false;
  for (const spec of config.task.evaluators.filter(e => e.split === 'development' || options.final)) if (!evaluations.some(e => e.evaluatorId === spec.id && e.split === spec.split && e.validity === 'pass')) return false;
  for (const objective of config.task.objectives) {
    if (!evaluations.some(e => e.split === 'development' && e.validity === 'pass' && e.kind === objective.evidenceKind && e.metrics.some(m => m.name === objective.metric && m.unit === objective.unit))) return false;
  }
  for (const constraint of config.task.constraints) {
    // A correct optimization baseline may be above the target metric threshold.
    if (options.baseline && constraint.kind !== 'check') continue;
    if (constraint.kind === 'check' && !options.final && config.task.evaluators.find(e => e.id === constraint.evaluatorId)?.split === 'held_out') continue;
    if (constraint.kind === 'human') return false;
    if (constraint.kind === 'check' && !evaluations.some(e => e.evaluatorId === constraint.evaluatorId && e.checks.some(c => c.id === constraint.check && c.outcome === 'pass'))) return false;
    if (constraint.kind === 'metric') {
      const metrics = evaluations.flatMap(e => e.metrics).filter(m => m.name === constraint.metric && m.unit === constraint.unit);
      if (!metrics.length || metrics.some(metric => constraint.op === 'lte' ? Math.max(...metric.samples) > constraint.value : Math.min(...metric.samples) < constraint.value)) return false;
    }
  }
  return true;
}
export function dominates(config: Config, a: Evaluation[], b: Evaluation[]): boolean {
  let better = false;
  if (!config.task.objectives.length) return false;
  for (const objective of config.task.objectives) {
    const ea = a.find(e => e.validity === 'pass' && e.kind === objective.evidenceKind && e.metrics.some(m => m.name === objective.metric && m.unit === objective.unit));
    const eb = b.find(e => e.validity === 'pass' && e.kind === objective.evidenceKind && e.metrics.some(m => m.name === objective.metric && m.unit === objective.unit));
    if (!ea || !eb || ea.definitionDigest !== eb.definitionDigest || ea.environmentDigest !== eb.environmentDigest || ea.split !== eb.split) return false;
    const ma = ea.metrics.find(m => m.name === objective.metric)!; const mb = eb.metrics.find(m => m.name === objective.metric)!;
    const gain = (mb.estimate - ma.estimate) * (objective.direction === 'minimize' ? 1 : -1);
    if (gain < 0) return false;
    const separated = objective.direction === 'minimize' ? Math.max(...ma.samples) < Math.min(...mb.samples) : Math.min(...ma.samples) > Math.max(...mb.samples);
    if (gain > objective.minMeaningfulChange && separated) better = true;
  }
  return better;
}
export function frontier(state: State): Revision[] {
  const evidence = new Map<string, Evaluation[]>();
  for (const evaluation of state.evaluations) if (evaluation.split === 'development') {
    const rows = evidence.get(evaluation.revisionId);
    if (rows) rows.push(evaluation); else evidence.set(evaluation.revisionId, [evaluation]);
  }
  const revisions = state.revisions.filter(r => feasible(state.config, evidence.get(r.id) ?? []));
  const objectives = state.config.task.objectives;
  if (!objectives.length) return revisions;
  // Extract comparable points and sample bounds once. Pairwise comparison must
  // not rescan the complete archive or every raw sample for each pair.
  const points = revisions.map(revision => objectives.map(objective => {
    const evaluation = evidence.get(revision.id)!.find(e => e.validity === 'pass' && e.kind === objective.evidenceKind && e.metrics.some(m => m.name === objective.metric && m.unit === objective.unit));
    const metric = evaluation?.metrics.find(m => m.name === objective.metric && m.unit === objective.unit);
    return evaluation && metric ? { definition: evaluation.definitionDigest, environment: evaluation.environmentDigest, estimate: metric.estimate, low: Math.min(...metric.samples), high: Math.max(...metric.samples) } : undefined;
  }));
  return revisions.filter((_revision, index) => !points.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    let better = false;
    for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex++) {
      const a = other[objectiveIndex]; const b = points[index]![objectiveIndex]; const objective = objectives[objectiveIndex]!;
      if (!a || !b || a.definition !== b.definition || a.environment !== b.environment) return false;
      const minimize = objective.direction === 'minimize';
      const gain = (b.estimate - a.estimate) * (minimize ? 1 : -1);
      if (gain < 0) return false;
      if (gain > objective.minMeaningfulChange && (minimize ? a.high < b.low : a.low > b.high)) better = true;
    }
    return better;
  }));
}
export function finalists(state: State): string[] {
  const preferred = frontier(state);
  // Missing executable evidence never grants an idea demonstrated status, but its
  // rubric/proposal can still be retained as a clearly unproven finalist.
  const pool = preferred.length ? preferred : state.config.task.type === 'idea' ? state.revisions.filter(r => r.id !== state.baselineId && resultsFor(state, r.id).length > 0) : [];
  return pool.slice(0, state.config.task.selection.maxFinalists).map(r => r.id);
}
