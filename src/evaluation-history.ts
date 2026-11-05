import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hash, id, RunStore } from './store.js';
import type { EvaluationExposure, FrozenEvaluator, Manifest } from './types.js';
import { readRegularText } from './workspaces.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const exposureSchema = z.object({ key: digest, runId: z.string().min(1), evaluatorId: z.string().min(1), definitionDigest: digest, datasetId: z.string().optional(), split: z.enum(['development', 'held_out']), at: z.string().datetime() }).strict();
type History = NonNullable<Manifest['evaluationHistory']>;
export class HoldoutReuseError extends Error {}
export function evaluationKey(evaluator: FrozenEvaluator): string {
  return hash(JSON.stringify(evaluator.spec.datasetId ? ['dataset', evaluator.spec.datasetId] : ['definition', evaluator.definitionDigest]));
}
function firstExposure(history: History, key: string): EvaluationExposure | undefined {
  let text: string;
  try { text = readRegularText(join(history.directory, key, 'first.json'), 16 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const envelope = z.object({ exposure: exposureSchema, hash: digest }).strict().parse(JSON.parse(text));
  if (envelope.exposure.key !== key || hash(JSON.stringify(envelope.exposure)) !== envelope.hash) throw Error('Evaluation history integrity check failed');
  return envelope.exposure;
}
function isPrior(first: EvaluationExposure | undefined, runId: string, evaluator: FrozenEvaluator): first is EvaluationExposure {
  return !!first && (first.runId !== runId || first.split !== evaluator.spec.split);
}
function enforce(history: History, evaluator: FrozenEvaluator, runId: string, first?: EvaluationExposure): void {
  if (history.reuse === 'reject' && evaluator.spec.split === 'held_out' && isPrior(first, runId, evaluator)) throw new HoldoutReuseError(`Held-out evaluator ${evaluator.spec.id} was already exposed by run ${first.runId} (${first.split}); use fresh held-out data in a new run`);
}
/** Local checks only. Execution claims again, closing races between run creation and finalization. */
export function checkEvaluationHistory(history: History, evaluators: FrozenEvaluator[], runId: string): void {
  for (const evaluator of evaluators.filter(e => e.spec.split === 'held_out')) {
    const key = evaluationKey(evaluator);
    if (history.reuse === 'reject' && evaluators.some(e => e.spec.split === 'development' && evaluationKey(e) === key)) throw new HoldoutReuseError(`Evaluator ${evaluator.spec.id} shares held-out data with development evaluation`);
    enforce(history, evaluator, runId, firstExposure(history, key));
  }
}
/** Atomic hard-link publication is no-clobber: a concurrent run cannot replace the first exposure. */
export function recordEvaluationExposure(store: RunStore, evaluator: FrozenEvaluator): void {
  const history = store.state.manifest.evaluationHistory;
  if (!history || store.state.evaluationExposures?.some(e => e.evaluatorId === evaluator.spec.id)) return;
  const key = evaluationKey(evaluator); const directory = join(history.directory, key);
  const exposure: EvaluationExposure = { key, runId: store.state.id, evaluatorId: evaluator.spec.id, definitionDigest: evaluator.definitionDigest, ...(evaluator.spec.datasetId ? { datasetId: evaluator.spec.datasetId } : {}), split: evaluator.spec.split, at: new Date().toISOString() };
  mkdirSync(directory, { recursive: true });
  enforce(history, evaluator, store.state.id, firstExposure(history, key));
  const temporary = join(directory, `${id()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify({ exposure, hash: hash(JSON.stringify(exposure)) })); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, join(directory, 'first.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const first = firstExposure(history, key)!;
    enforce(history, evaluator, store.state.id, first);
    // Keep one immutable receipt per run/evaluator. A crash after publication is
    // conservatively exposed even if dispatch never happened.
    try { linkSync(temporary, join(directory, `${hash(JSON.stringify([store.state.id, evaluator.spec.id]))}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    store.append({ type: 'evaluation.exposed', exposure: { ...exposure, ...(isPrior(first, store.state.id, evaluator) ? { prior: { runId: first.runId, split: first.split, definitionDigest: first.definitionDigest, at: first.at } } : {}) } });
  } finally { rmSync(temporary, { force: true }); }
}
