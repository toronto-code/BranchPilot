import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './support.js';
import { RunStore } from '../src/store.js';
import { reduce } from '../src/types.js';
import type { Evaluation, State } from '../src/types.js';
import { dominates, feasible, frontier, resultsFor } from '../src/evaluation.js';
import { runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { configSchema } from '../src/config.js';
import { renderReport } from '../src/report.js';

test('reducer preserves earlier state while changing only affected collections', t => {
  const { store } = setup(t); const before = store.state; const saved = structuredClone(before);
  const changed = reduce(before, { type: 'strategy.changed', strategy: { name: 'retry', maxAttemptsPerCandidate: 3 }, reason: 'Test', policyMode: 'auto' });
  assert.deepEqual(before, saved); assert.equal(before.config.policy.mode, 'fixed');
  assert.equal(changed.config.policy.mode, 'auto'); assert.notEqual(changed.config, before.config);
  assert.equal(changed.revisions, before.revisions); assert.equal(changed.works, before.works);
  const input = reduce(changed, { type: 'backend.event', workId: 'one', kind: 'muse.input_required', artifact: 'a'.repeat(64) });
  const cleared = reduce(input, { type: 'backend.input_cleared', workId: 'one' });
  assert.ok(input.backendInputs!.one); assert.equal(cleared.backendInput, undefined);
});

test('invalid later event cannot partially mutate a transaction or its previous projection', t => {
  const { store } = setup(t); const before = store.state; const log = readFileSync(join(store.dir, 'events.jsonl'), 'utf8');
  assert.throws(() => store.append(
    { type: 'run.status', status: 'paused', message: 'Must roll back' },
    { type: 'work.updated', work: { id: 'absent' } as State['works'][string] },
  ), /Unknown work/);
  assert.equal(store.state, before); assert.equal(store.state.status, 'preparing');
  assert.equal(readFileSync(join(store.dir, 'events.jsonl'), 'utf8'), log);
});

test('stream events stay durable without rewriting the state cache and replay without that cache', t => {
  const { store } = setup(t); const cache = join(store.dir, 'state.json');
  const initial = readFileSync(cache, 'utf8'); const before = store.state;
  const artifact = store.putJSON({ simulated: true, item: 'example' });
  for (let i = 0; i < 100; i++) store.append({ type: 'backend.event', workId: 'simulated', kind: 'muse.item', artifact });
  assert.equal(store.state, before); assert.equal(readFileSync(cache, 'utf8'), initial);
  assert.equal(new RunStore(store.dir).sequence, store.sequence);
  assert.deepEqual(new RunStore(store.dir).state, store.state);
  store.close(); assert.equal(JSON.parse(readFileSync(cache, 'utf8')).sequence, store.sequence);
  rmSync(cache); assert.deepEqual(new RunStore(store.dir).state, store.state);
});

test('settled checkpoints flush throttled projections and preserve archive order', async t => {
  const { store } = setup(t, 'concurrent'); await runController(store);
  const cached = JSON.parse(readFileSync(join(store.dir, 'state.json'), 'utf8'));
  assert.equal(cached.sequence, store.sequence); assert.deepEqual(cached.state, store.state);
  assert.deepEqual(store.state.revisions.filter(r => r.attemptId).map(r => store.state.works[r.attemptId!]!.index), [0, 1, 2]);
  assert.deepEqual(new RunStore(store.dir).state, store.state);
});

test('indexed frontier matches the reference across tradeoffs, noise, missing and incompatible evidence', t => {
  const { store } = setup(t, 'optimization');
  let seed = 731;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 24; trial++) {
    const state = structuredClone(store.state); state.config.task.constraints = [];
    state.config.task.evaluators = [state.config.task.evaluators[0]!];
    state.config.task.objectives = [
      { metric: 'time', direction: 'minimize', unit: 'ms', evidenceKind: 'executable', minMeaningfulChange: trial % 3 },
      { metric: 'quality', direction: 'maximize', unit: 'points', evidenceKind: 'executable', minMeaningfulChange: trial % 2 },
    ];
    for (let i = 0; i < 40; i++) {
      const revisionId = `r${i}`;
      state.revisions.push({ id: revisionId, candidateId: revisionId, parentIds: [], snapshot: 'a'.repeat(64), proposal: '', hypotheses: [], depth: 1, createdAt: state.startedAt });
      const measurements = ['time', 'quality'].map((name, index) => {
        const value = Math.floor(random() * 12); const noise = Math.floor(random() * 3);
        return { name, unit: index ? 'points' : 'ms', estimate: value, samples: [value - noise, value, value + noise], uncertainty: { kind: 'range' as const, low: value - noise, high: value + noise } };
      });
      const evaluation: Evaluation = { id: `e${i}`, workId: `w${i}`, revisionId, evaluatorId: state.config.task.evaluators[0]!.id, split: i % 17 ? 'development' : 'held_out', kind: 'executable', definitionDigest: i % 13 ? 'definition-a' : 'definition-b', environmentDigest: i % 11 ? 'environment-a' : 'environment-b', validity: i % 19 ? 'pass' : 'fail', checks: [], metrics: i % 7 ? measurements : measurements.slice(1), feedback: '', findings: [], evidence: [] };
      state.evaluations.push(evaluation);
    }
    const candidates = state.revisions.filter(r => feasible(state.config, resultsFor(state, r.id)));
    const reference = candidates.filter(r => !candidates.some(other => other.id !== r.id && dominates(state.config, resultsFor(state, other.id), resultsFor(state, r.id))));
    assert.deepEqual(frontier(state).map(r => r.id), reference.map(r => r.id));
  }
});

test('opt-in deterministic reuse coalesces concurrent identical checks and releases all escrow', async t => {
  const { store } = setup(t, 'repair', c => {
    c.strategy = { name: 'best-of-n', n: 8 }; c.budget.maxConcurrency = 4;
    c.task.evaluators[0]!.reuseIdentical = true;
    if (c.backend.kind === 'fixture') { const plan = c.backend.plans[0]!; c.backend.plans = Array.from({ length: 8 }, () => structuredClone(plan)); }
  });
  await runController(store);
  const budget = budgetView(store.state);
  assert.equal(store.state.outcome, 'goal_met');
  assert.equal(budget.spent.attempts, 8); assert.equal(budget.spent.tokens, 960);
  assert.equal(budget.spent.experiments, 2); assert.equal(budget.reserved.experiments, 0);
  const reused = store.state.evaluations.filter(e => e.reusedFrom);
  assert.equal(reused.length, 7);
  const original = store.state.evaluations.find(e => e.id === reused[0]!.reusedFrom!.evaluationId)!;
  assert.ok(reused.every(e => e.workId === original.workId && e.reusedFrom!.evaluationId === original.id));
  assert.match(renderReport(store), /not new measurements/);
  assert.deepEqual(new RunStore(store.dir).state, store.state);
});

test('correctness reuse never crosses changed snapshots or reuses a failure', async t => {
  const { store } = setup(t, 'repair', c => {
    c.strategy = { name: 'best-of-n', n: 4 }; c.task.evaluators[0]!.reuseIdentical = true;
    if (c.backend.kind === 'fixture') {
      const plan = c.backend.plans[0]!;
      c.backend.plans = [structuredClone(plan), { ...structuredClone(plan), files: { 'calculator.mjs': 'export function add(a,b) { return a+b; } // different snapshot\n' } }, { ...structuredClone(plan), files: { 'calculator.mjs': 'export function add(a,b) { return a-b; }\n' } }, { ...structuredClone(plan), files: { 'calculator.mjs': 'export function add(a,b) { return a-b; }\n' } }];
    }
  });
  await runController(store);
  assert.equal(store.state.evaluations.filter(e => e.reusedFrom).length, 0);
  assert.equal(budgetView(store.state).spent.experiments, 5);
  assert.deepEqual(store.state.evaluations.map(e => e.validity), ['fail', 'pass', 'pass', 'fail', 'fail']);
});

test('reuse is disabled by default and cannot be enabled for benchmarks, humans or held-out data', async t => {
  const { store, config } = setup(t, 'repair', c => {
    c.strategy = { name: 'best-of-n', n: 3 };
    if (c.backend.kind === 'fixture') { const plan = c.backend.plans[0]!; c.backend.plans = [plan, structuredClone(plan), structuredClone(plan)]; }
  });
  await runController(store);
  assert.equal(budgetView(store.state).spent.experiments, 4);
  for (const patch of [{ role: 'objective' }, { kind: 'human_preference' }, { split: 'held_out' }]) {
    const candidate = structuredClone(config);
    Object.assign(candidate.task.evaluators[0]!, patch, { reuseIdentical: true });
    assert.equal(configSchema.safeParse(candidate).success, false);
  }
});

test('metric-bearing correctness results still execute fresh when reuse is enabled', async t => {
  const { store } = setup(t, 'repair', (c, root) => {
    c.strategy = { name: 'best-of-n', n: 3 }; c.task.evaluators[0]!.reuseIdentical = true;
    if (c.backend.kind === 'fixture') { const plan = c.backend.plans[0]!; c.backend.plans = [plan, structuredClone(plan), structuredClone(plan)]; }
    const definition = join(root, 'evaluators', 'metric-correctness.json');
    writeFileSync(definition, JSON.stringify({ schemaVersion: 1, script: 'metric-correctness.mjs' }));
    writeFileSync(join(root, 'evaluators', 'metric-correctness.mjs'), 'console.log(JSON.stringify({validity:"pass",checks:[{id:"addition",outcome:"pass"}],metrics:[{name:"time",unit:"ms",value:1}]}));');
    c.task.evaluators[0]!.definition.path = definition;
  });
  await runController(store);
  assert.equal(store.state.evaluations.length, 4);
  assert.equal(store.state.evaluations.filter(e => e.reusedFrom).length, 0);
  assert.equal(budgetView(store.state).spent.experiments, 4);
});

test('saved correctness procedures make room for more alternatives under the same experiment budget', async t => {
  const attempts: number[] = [];
  for (const reuseIdentical of [false, true]) {
    const { store } = setup(t, 'repair', c => {
      c.strategy = { name: 'best-of-n', n: 8 }; c.budget.total.experiments = 4;
      c.task.evaluators[0]!.reuseIdentical = reuseIdentical;
      if (c.backend.kind === 'fixture') { const plan = c.backend.plans[0]!; c.backend.plans = Array.from({ length: 8 }, () => structuredClone(plan)); }
    });
    await runController(store);
    const budget = budgetView(store.state);
    assert.equal(store.state.outcome, 'goal_met');
    assert.ok(budget.spent.experiments <= 4);
    assert.equal(budget.reserved.experiments, 0); assert.equal(budget.unknown.experiments, 0);
    attempts.push(budget.spent.attempts);
  }
  assert.deepEqual(attempts, [3, 8]);
});
