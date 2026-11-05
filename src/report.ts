import { join } from 'node:path';
import { budgetView } from './budget.js';
import { atomicWrite, RunStore } from './store.js';

const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('<', '&lt;');
export function renderReport(store: RunStore): string {
  const s = store.state; const budget = budgetView(s, true);
  const lines = [
    `# BranchPilot: ${s.config.task.key}`, '',
    `Run: ${s.id}`, `Status: **${s.status}** · Outcome: **${s.outcome ?? 'pending'}**`, '',
    s.config.backend.kind === 'fixture' ? '**SIMULATION:** Candidate edits and token usage come from deterministic fixture plans. External evaluators actually ran. No coding model was contacted.' : 'Backend: Muse Code. Compatibility and usage evidence are recorded in the run.', '',
    s.config.task.goal, '', s.message ?? '', '',
    `Requested model: \`${cell(JSON.stringify(s.config.agent.model))}\`; effort: \`${cell(JSON.stringify(s.config.agent.effort))}\`. Host confirmation, when available, is preserved in backend event artifacts.`, '',
    ...(Object.values(s.works).some(w => w.agentSettings) ? [
      '## Confirmed model settings', '', '| Attempt | Provider / model | Effort | Selection reason |', '|---|---|---|---|',
      ...Object.values(s.works).filter(w => w.agentSettings).map(w => `| ${w.id} | ${cell(w.agentSettings!.providerId)} / ${cell(w.agentSettings!.modelId)} | ${cell(w.agentSettings!.effort ?? 'host default (unconfirmed)')} | ${cell(w.agentSettings!.reason)} |`), '',
    ] : []),
    '## Budget', '', '| Resource | Spent | Reserved | Unknown liability | Limit |', '|---|---:|---:|---:|---:|',
    ...(['tokens', 'workSeconds', 'attempts', 'experiments'] as const).map(k => `| ${k} | ${budget.spent[k].toFixed(k === 'workSeconds' ? 3 : 0)} | ${budget.reserved[k]} | ${budget.unknown[k]} | ${s.config.budget.total[k]} |`), '',
    `Active token policy: ${s.config.budget.tokenLimitPolicy ?? 'observe'}. Cancellation requests depend on reported usage; they are not a hard provider cap. Cleanup can exceed a timeout. Missing usage is never treated as zero.`, '',
    '## Evaluation reuse', '',
    ...(s.manifest.evaluationHistory ? [`Registry: ${cell(s.manifest.evaluationHistory.directory)}; policy: ${s.manifest.evaluationHistory.reuse}.`, '',
      '| Evaluator | Split | Prior exposure |', '|---|---|---|',
      ...(s.evaluationExposures ?? []).map(e => `| ${cell(e.evaluatorId)} | ${e.split} | ${e.prior ? `Reused from ${cell(e.prior.runId)} (${e.prior.split}); not independent held-out evidence` : 'No earlier exposure recorded in this registry'} |`), '',
      'Dataset identity uses an explicit datasetId when provided, otherwise the frozen definition digest. This local history does not prove that data was never used elsewhere.', '',
    ] : ['Legacy run: cross-run evaluation history was not recorded.', '']),
    '## Work accounting', '', '| Work | Kind | State | Outcome | Usage source | Receipt |', '|---|---|---|---|---|---|',
    ...Object.values(s.works).map(w => `| ${w.id} | ${w.kind} | ${w.state} | ${w.outcome ?? ''} | ${w.usageSource ?? 'unresolved'} | ${w.receipt ? `[artifact](artifacts/${w.receipt})` : ''} |`), '',
    '## Candidate archive', '', '| Revision | Parent revisions | Candidate | Stage | Snapshot | Finalist |', '|---|---|---|---|---|---|',
    ...s.revisions.map(r => `| ${r.id} | ${r.parentIds.join(', ') || 'baseline'} | ${r.candidateId} | ${s.config.task.type === 'idea' ? 'proposal / inspect evidence below' : 'implementation'} | ${r.snapshot} | ${s.finalists?.includes(r.id) ? 'yes' : ''} |`), '',
    '## Evaluations', '', '| Revision | Evaluator | Evidence | Split | Validity | Measurements |', '|---|---|---|---|---|---|',
    ...s.evaluations.map(e => `| ${e.revisionId.slice(0, 8)} | ${cell(e.evaluatorId)} | ${e.kind}${e.reusedFrom ? ` (reused ${e.reusedFrom.evaluationId.slice(0, 8)})` : ''} | ${e.split} | ${e.validity} | ${cell(e.metrics.map(m => `${m.name}: ${m.estimate} ${m.unit} (n=${m.samples.length}; ${m.uncertainty.kind === 'range' ? `range ${m.uncertainty.low}–${m.uncertainty.high}` : 'uncertainty unknown'})`).join('; '))} |`), '',
    ...(s.evaluations.some(e => e.reusedFrom) ? [`${s.evaluations.filter(e => e.reusedFrom).length} declared deterministic correctness checks reused a passing result for identical snapshot/definition/environment within this run. Reused rows reference the original experiment and samples; they are not new measurements or charged procedures.`, ''] : []),
    'Ranges describe observed variability, not statistical confidence intervals. Scores from different evaluator/environment definitions are not directly comparable.', '',
    '## Findings and feedback', '',
    ...s.evaluations.flatMap(e => [`- ${e.revisionId.slice(0, 8)} / ${cell(e.evaluatorId)}: ${cell(e.feedback || e.validity)}`, ...e.findings.map(f => `  - ${cell(f)}`), `  - Raw evidence: ${e.evidence.map((digest, index) => `[${index + 1}](artifacts/${digest})`).join(', ') || 'none'}`]), '',
    ...(s.config.task.type === 'idea' || s.revisions.some(revision => revision.hypotheses.length) ? ['## Proposals and hypotheses', '', 'Candidate claims are unverified metadata. Evaluator records supply their supporting or refuting evidence.', '', ...s.revisions.flatMap(r => [
      `### Revision ${r.id}`, '', ...r.proposal.split('\n').map(line => `> ${line.replaceAll('<', '&lt;')}`), '',
      '| Hypothesis | Assumption | Expected benefit | Uncertainty | Prediction | Falsification test |', '|---|---|---|---|---|---|',
      ...r.hypotheses.map(h => `| ${cell(h.id)} | ${cell(h.assumption)} | ${cell(h.expectedBenefit)} | ${cell(h.uncertainty)} | ${cell(h.prediction)} | ${cell(h.falsificationTest)} |`), '',
    ])] : []),
    '## Decisions', '', ...s.decisions.map(d => `- Epoch ${d.epoch}: **${cell(d.action)}** — ${cell(d.reason)} (${d.evidenceIds.length} development evidence records)`), '',
    '## Scope and limitations', '',
    '- Immutable snapshots and the append-only log remain available after workspaces are removed.',
    '- Selected revision IDs are frozen before held-out evaluation; failed final checks do not trigger further search.',
    '- Independent best-of-N attempts run in bounded waves; retries and tree development stay sequential. Evaluator resource groups exclude overlapping procedures within this run.',
    '- Unknown backend work requires explicit reconciliation; resuming never automatically repeats it.',
    s.config.execution.isolationProfile === 'trusted-fixture' ? '- Trusted-fixture mode is for known local fixtures only; it is not an OS sandbox for arbitrary candidate code.' : '- Execution uses the configured sandbox-exec profile; live Muse compatibility requires its separate smoke-test evidence.', '',
  ];
  if (s.pending) lines.push('## Pending assessment', '', `Evaluator: ${s.pending.evaluatorId}; revision: ${s.pending.revisionId}. Record an assessment with the CLI, then resume.`, '');
  if (store.projectionWarning) lines.push('## Storage warning', '', cell(store.projectionWarning), 'The event log remains authoritative; repair the cache destination before the next write.', '');
  if (s.backendInput) {
    lines.push('## Pending backend input', '', 'Use inspect to read the question and its IDs. Answering or reconciling live Muse work requires separate runtime verification.', '');
    for (const [workId, artifact] of Object.entries(s.backendInputs ?? { [s.backendInput.workId]: s.backendInput.artifact })) {
      const work = s.works[workId]!;
      lines.push(`- Work: ${workId}; session: ${cell(work.sessionId)}; turn: ${cell(work.turnId)}; [question artifact](artifacts/${artifact}).`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
export function writeReport(store: RunStore): void {
  if (!store.state) return;
  atomicWrite(join(store.dir, 'report.md'), renderReport(store));
  atomicWrite(join(store.dir, 'report.json'), JSON.stringify({ schemaVersion: 1, state: store.state, budget: budgetView(store.state, true), sourceSequence: store.sequence }, null, 2));
}
