import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore } from './store.js';
import { budgetView } from './budget.js';
import type { Envelope, Snapshot } from './types.js';

export const templates = ['code', 'optimization', 'idea'] as const;
export type Template = typeof templates[number];
/** A self-contained fixture project. It never enables a live backend. */
export function initializeProject(directory: string, template: Template): void {
  const examples = resolve(dirname(fileURLToPath(import.meta.url)), '../../examples');
  const source = { code: 'repair', optimization: 'optimization', idea: 'ideas' }[template];
  const fixture = template === 'code' ? 'repair' : template === 'idea' ? 'idea' : 'optimization';
  const config = readFileSync(join(examples, `${source}.json`), 'utf8');
  // Exclusive creation: never overwrite an existing project or its files.
  mkdirSync(directory);
  mkdirSync(join(directory, 'fixtures'));
  cpSync(join(examples, 'fixtures', fixture), join(directory, 'fixtures', fixture), { recursive: true, errorOnExist: true, force: false });
  cpSync(join(examples, 'evaluators'), join(directory, 'evaluators'), { recursive: true, errorOnExist: true, force: false });
  writeFileSync(join(directory, 'config.json'), config, { flag: 'wx' });
  writeFileSync(join(directory, 'README.md'), `# BranchPilot ${template} project\n\nThis is an offline fixture: edits are predetermined and external evaluations really execute.\n\nRun from this directory with an installed CLI:\n\n\`\`\`sh\nbranchpilot run config.json --out runs\nbranchpilot runs runs\n\`\`\`\n\nEdit config.json to set your goal, constraints, budget, strategy, and fixture plans. Candidate inputs live in fixtures/; trusted evaluation assets live separately in evaluators/. Production Muse execution needs a separately verified runtime lock. This template does not authorize provider calls.\n`, { flag: 'wx' });
}

export function listRuns(directory: string, limit = 20): unknown[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('Run limit must be between 1 and 1000');
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(directory, entry.name, 'events.jsonl')))
    .map(entry => ({ path: join(directory, entry.name), updated: statSync(join(directory, entry.name, 'events.jsonl')).mtimeMs }))
    .sort((a, b) => b.updated - a.updated || a.path.localeCompare(b.path)).slice(0, limit).map(({ path }) => {
      try {
        const store = new RunStore(path); const state = store.state;
        if (!state) throw Error('No committed run');
        return { directory: path, id: state.id, task: state.config.task.key, status: state.status, outcome: state.outcome ?? null, backend: state.config.backend.kind, strategy: state.strategy.name, budget: budgetView(state, true), report: join(path, 'report.md') };
      } catch (error) { return { directory: path, error: String(error) }; }
    });
}

/** Read-only integrity check; no execution, repair, or approval of runtime claims. */
export function verifyRun(store: RunStore): { runId: string; sequence: number; artifacts: number; snapshots: number } {
  if (existsSync(join(store.dir, 'writer.lock'))) throw Error('Verify a settled run after its writer exits');
  const log = readFileSync(join(store.dir, 'events.jsonl'));
  if (log.length && log.at(-1) !== 10) throw Error('Incomplete event-log tail; use resume to reconcile it before verification');
  let artifacts = 0;
  for (const entry of readdirSync(join(store.dir, 'artifacts'), { withFileTypes: true })) {
    if (entry.name.endsWith('.tmp')) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) throw Error(`Unexpected artifact entry: ${entry.name}`);
    store.get(entry.name); artifacts++;
  }
  const required = new Set<string>(); const snapshots = new Set<string>();
  const state = store.state; required.add(state.manifest.configDigest); required.add(state.manifest.environment);
  snapshots.add(state.manifest.initialSnapshot);
  for (const evaluator of state.manifest.evaluators) { required.add(evaluator.definitionDigest); snapshots.add(evaluator.bundle); }
  for (const revision of state.revisions) snapshots.add(revision.snapshot);
  for (const work of Object.values(state.works)) { required.add(work.intent); if (work.receipt) required.add(work.receipt); if (work.operation) required.add(work.operation.intent); }
  for (const evaluation of state.evaluations) { required.add(evaluation.definitionDigest); required.add(evaluation.environmentDigest); for (const artifact of evaluation.evidence) required.add(artifact); }
  for (const line of log.toString('utf8').trim().split('\n')) {
    const envelope = JSON.parse(line) as Envelope;
    for (const event of envelope.events) if (event.type === 'backend.event') {
      required.add(event.artifact); if (event.kind === 'partial_snapshot') snapshots.add(event.artifact);
    }
  }
  for (const snapshot of snapshots) {
    const value = store.getJSON<Snapshot>(snapshot);
    if (!Array.isArray(value.files)) throw Error('Invalid snapshot manifest');
    for (const file of value.files) required.add(file.blob);
  }
  for (const artifact of required) store.get(artifact);
  return { runId: state.id, sequence: store.sequence, artifacts, snapshots: snapshots.size };
}
