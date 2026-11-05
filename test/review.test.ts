import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runController, switchStrategy } from '../src/controller.js';
import { actualUsage, admit, budgetView, zero } from '../src/budget.js';
import { outputSchema } from '../src/evaluation.js';
import { Scheduler } from '../src/scheduler.js';
import { RunStore, id } from '../src/store.js';
import { nextPlan } from '../src/search.js';
import type { Evaluation, Revision, Work } from '../src/types.js';
import { setup } from './support.js';

test('uncertain work retains observed overruns and blocks dispatch and switching', async t => {
  const { store } = setup(t);
  let calls = 0;
  const backend = { execute: async () => { calls++; return { outcome: 'unknown' as const, tokens: 2500, proposal: '', hypotheses: [], receipt: {}, stopped: false }; } };
  await runController(store, { backend });
  const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  assert.equal(work.actual?.tokens, 2500);
  assert.equal(budgetView(store.state).unknown.tokens, 2500);
  assert.throws(() => admit(store.state, zero(), 'search'), /reconciled/);
  assert.throws(() => switchStrategy(store, { name: 'direct' }), /Settle/);
  await runController(store, { backend }); assert.equal(calls, 1);
});

test('settled overruns reduce future capacity without clipping reported spend', async t => {
  const { store } = setup(t, 'retry', c => {
    c.budget.total.tokens = 1500;
    if (c.backend.kind === 'fixture') c.backend.plans[0]!.tokens = 1800;
  });
  await runController(store);
  assert.equal(budgetView(store.state).spent.tokens, 1800);
  assert.equal(budgetView(store.state).available.tokens, 0);
  assert.equal(budgetView(store.state).spent.attempts, 1);
  assert.ok(store.state.decisions.some(d => d.reason.includes('Insufficient tokens')));
});

test('output snapshot failure preserves known usage and never repeats the paid attempt', async t => {
  const { store } = setup(t); let calls = 0;
  const backend = { execute: async (request: Parameters<import('../src/backend.js').Backend['execute']>[0]) => {
    calls++; symlinkSync('/private/tmp', join(request.work.workspace, 'bad-link'));
    return { outcome: 'completed' as const, tokens: 1700, proposal: '', hypotheses: [], receipt: {}, stopped: true };
  } };
  await runController(store, { backend });
  assert.equal(store.state.status, 'needs_attention');
  assert.equal(budgetView(store.state).spent.tokens, 1700);
  assert.equal(Object.values(store.state.works).find(w => w.kind === 'attempt')!.state, 'settled');
  await runController(store, { backend }); assert.equal(calls, 1);
});

test('invalid elapsed usage cannot be serialized as null or credited as zero', t => {
  const { store } = setup(t);
  const work = { kind: 'attempt' } as Work;
  for (const value of [NaN, Infinity, -1]) assert.throws(() => actualUsage(work, 3, value), /Invalid work seconds/);
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => actualUsage(work, value, 1), /Invalid token usage/);
  assert.equal(store.state.revisions.length, 0);
});

test('cancellation during the last held-out evaluation remains cancelled on resume', async t => {
  const { store } = setup(t, 'repair', (c, root) => {
    writeFileSync(join(root, 'input/calculator.mjs'), 'export function add(a,b) { return a+b; }');
    c.budget.total.attempts = 0;
    c.task.evaluators.push({ ...c.task.evaluators[0]!, id: 'final', split: 'held_out', definition: { path: join(root, 'evaluators/final.json') } });
    writeFileSync(join(root, 'evaluators/final.json'), JSON.stringify({ schemaVersion: 1, script: 'final.mjs' }));
    writeFileSync(join(root, 'evaluators/final.mjs'), 'setTimeout(() => console.log(JSON.stringify({validity:"pass"})), 2000);');
    c.budget.finalizationReserve = { tokens: 0, workSeconds: 10, attempts: 0, experiments: 2 };
  });
  const abort = new AbortController(); let timer: NodeJS.Timeout | undefined;
  await runController(store, { signal: abort.signal, onProgress: message => { if (message.endsWith(': final')) timer = setTimeout(() => abort.abort(), 50); } });
  clearTimeout(timer);
  assert.equal(store.state.status, 'cancelled'); assert.equal(store.state.outcome, 'cancelled');
  assert.equal(budgetView(store.state).active, 0);
  const sequence = store.sequence; await runController(store); assert.equal(store.sequence, sequence);
});

test('assessment receipt recovery clears the answered prompt exactly once', async t => {
  const { store } = setup(t, 'human-review');
  await runController(store);
  const pending = store.state.pending!;
  new Scheduler(store, new AbortController().signal).assess(outputSchema.parse({ validity: 'pass' }), 'Offline test');
  const rows = readFileSync(join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n');
  const index = rows.findIndex(line => JSON.parse(line).events.some((e: { type: string; evaluation?: Evaluation }) => e.type === 'evaluation.recorded' && e.evaluation?.evaluatorId === pending.evaluatorId && e.evaluation.revisionId === pending.revisionId));
  assert.ok(index > 0);
  const dir = store.dir; store.close();
  writeFileSync(join(dir, 'events.jsonl'), rows.slice(0, index).join('\n') + '\n');
  const recovered = new RunStore(dir, true); t.after(() => recovered.close());
  new Scheduler(recovered, new AbortController().signal).recover();
  assert.equal(recovered.state.pending, undefined);
  assert.equal(recovered.state.evaluations.filter(e => e.revisionId === pending.revisionId && e.evaluatorId === pending.evaluatorId).length, 1);
  const resumed = await runController(recovered);
  assert.notEqual(resumed.pending?.revisionId, pending.revisionId);
  assert.equal(budgetView(recovered.state).spent.attempts, 1);
});

test('held-out finalization closes development entry points and reserves cannot cross splits', async t => {
  const { store } = setup(t); await runController(store);
  const scheduler = new Scheduler(store, new AbortController().signal);
  const revision = store.state.revisions[0]!;
  const count = Object.keys(store.state.works).length;
  await assert.rejects(scheduler.develop({ baseId: revision.id, reason: 'Forbidden search' }), /Search is closed/);
  await assert.rejects(scheduler.evaluate(revision, store.state.manifest.evaluators[0]!, 'held_out'), /phase must match/);
  await assert.rejects(scheduler.evaluate(revision, store.state.manifest.evaluators[0]!, 'search'), /Development evaluation is closed/);
  assert.equal(Object.keys(store.state.works).length, count);
});

test('tree width remains bounded when a new revision displaces an allocated parent', async t => {
  const { store } = setup(t, 'optimization'); await runController(store, { pauseAfter: 0 });
  const state = structuredClone(store.state);
  state.strategy = { name: 'tree', width: 1, maxDepth: 2, maxChildren: 1 };
  const baseline = state.revisions[0]!;
  function candidate(name: string, score: number): Revision {
    const revision: Revision = { ...baseline, id: name, candidateId: name, depth: 1, attemptId: id(), parentIds: [baseline.id] };
    state.revisions.push(revision);
    for (const evaluation of state.evaluations.filter(e => e.revisionId === baseline.id)) {
      const copy: Evaluation = structuredClone(evaluation); copy.id = id(); copy.revisionId = name;
      for (const metric of copy.metrics) { metric.estimate = score; metric.samples = [score]; }
      state.evaluations.push(copy);
    }
    return revision;
  }
  const oldParent = candidate('old', 10); const newParent = candidate('new', 1);
  const work = (base: Revision): Work => ({ id: id(), kind: 'attempt', phase: 'search', revisionId: base.id, reservation: { ...zero(), attempts: 1 }, state: 'settled', actual: { ...zero(), attempts: 1 }, intent: '', workspace: '', index: 0, epoch: 0 });
  for (const base of [baseline, oldParent]) { const attempt = work(base); state.works[attempt.id] = attempt; }
  assert.notEqual(oldParent.id, newParent.id);
  assert.equal(nextPlan(state), undefined, 'the displaced parent already consumed the only slot at depth 1');
});
