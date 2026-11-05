import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureBackend } from '../src/backend.js';
import { budgetView } from '../src/budget.js';
import { runController, switchStrategy } from '../src/controller.js';
import { RunStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { setup } from './support.js';

function alternatives(config: import('../src/types.js').Config, count = 4) {
  config.strategy = { name: 'best-of-n', n: count }; config.budget.maxConcurrency = 2;
  if (config.backend.kind !== 'fixture') throw Error();
  config.backend.plans = Array.from({ length: count }, (_, index) => ({ files: { 'calculator.mjs': `export function add(a,b) { return a+b; } // alternative ${index}` }, hypotheses: [], tokens: 100 + index, delayMs: index % 2 ? 5 : 80, outcome: 'completed' }));
}

test('best-of-N overlaps independent attempts with full reservations, bounded writers and deterministic archive order', async t => {
  const { store } = setup(t, 'repair', c => alternatives(c));
  const fixture = new FixtureBackend(); let active = 0; let peak = 0; const completion: number[] = [];
  let releaseSibling: (() => void) | undefined;
  await runController(store, { backend: { execute: async request => {
    active++; peak = Math.max(peak, active);
    assert.ok(budgetView(store.state).reserved.experiments >= active);
    assert.throws(() => switchStrategy(store, { name: 'direct' }), /Settle/);
    if (request.work.index % 2 === 0) await new Promise<void>(resolve => { releaseSibling = resolve; });
    const result = await fixture.execute(request); completion.push(request.work.index); active--;
    if (request.work.index % 2) releaseSibling!();
    return result;
  } } });
  assert.equal(peak, 2); assert.equal(active, 0); assert.deepEqual(completion, [1, 0, 3, 2]);
  assert.equal(store.state.outcome, 'goal_met');
  const revisions = store.state.revisions.filter(r => r.attemptId);
  assert.deepEqual(revisions.map(r => store.state.works[r.attemptId!]!.index), [0, 1, 2, 3]);
  assert.equal(store.state.finalists![0], revisions[0]!.id);
  assert.equal(budgetView(store.state).spent.tokens, 406); assert.equal(budgetView(store.state).active, 0);
  assert.equal(budgetView(store.state).reserved.experiments, 0);
  const replay = new RunStore(store.dir); assert.deepEqual(replay.state, store.state);
  const events = readFileSync(join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n').flatMap(row => JSON.parse(row).events);
  assert.equal(events.filter(e => e.type === 'work.reserved' && e.work.kind === 'attempt').length, 4);
});

test('concurrent admission protects evaluation capacity and finalization before dispatch', async t => {
  const { store } = setup(t, 'repair', c => { alternatives(c); c.budget.total.experiments = 3; });
  await runController(store);
  assert.equal(budgetView(store.state).spent.attempts, 2);
  assert.equal(budgetView(store.state).spent.experiments, 3);
  assert.equal(budgetView(store.state).reserved.experiments, 0);
});

test('pause-after bounds a concurrent wave exactly and resumes remaining alternatives', async t => {
  const { store } = setup(t, 'repair', c => alternatives(c, 5));
  await runController(store, { pauseAfter: 3 });
  assert.equal(store.state.status, 'paused'); assert.equal(budgetView(store.state).spent.attempts, 3); assert.equal(budgetView(store.state).active, 0);
  await runController(store); assert.equal(budgetView(store.state).spent.attempts, 5); assert.equal(store.state.status, 'completed');
});

test('an uncertain sibling drains the active wave and prevents further dispatch, evaluation and finalization', async t => {
  const { store } = setup(t, 'repair', c => alternatives(c, 5));
  const fixture = new FixtureBackend(); let active = 0; let calls = 0;
  await runController(store, { backend: { execute: async request => {
    active++; calls++;
    try { if (request.work.index === 1) throw Error('Simulated disconnected host'); return await fixture.execute(request); }
    finally { active--; }
  } } });
  assert.equal(active, 0); assert.equal(calls, 2); assert.equal(store.state.status, 'needs_attention');
  assert.equal(store.state.finalists, undefined); assert.equal(store.state.evaluations.length, 1);
  await runController(store); assert.equal(Object.values(store.state.works).filter(w => w.kind === 'attempt').length, 2);
});

test('cancellation settles every active concurrent attempt before returning', async t => {
  const { store } = setup(t, 'repair', c => alternatives(c, 5));
  const abort = new AbortController(); const fixture = new FixtureBackend(); let active = 0; let calls = 0;
  await runController(store, { signal: abort.signal, backend: { execute: async request => {
    active++; calls++; if (calls === 2) abort.abort();
    try { return await fixture.execute(request); } finally { active--; }
  } } });
  assert.equal(calls, 2); assert.equal(active, 0); assert.equal(store.state.status, 'cancelled');
  assert.equal(budgetView(store.state).spent.attempts, 2); assert.equal(budgetView(store.state).active, 0);
  assert.equal(budgetView(store.state).reserved.experiments, 0);
});

test('feedback-dependent retries remain sequential despite a higher concurrency setting', async t => {
  const { store } = setup(t, 'retry', c => { c.budget.maxConcurrency = 4; });
  const fixture = new FixtureBackend(); let active = 0; let peak = 0;
  await runController(store, { backend: { execute: async request => { active++; peak = Math.max(peak, active); try { return await fixture.execute(request); } finally { active--; } } } });
  assert.equal(peak, 1); assert.equal(budgetView(store.state).spent.attempts, 2); assert.equal(store.state.outcome, 'goal_met');
});

for (const grouped of [true, false]) {
  test(`evaluation resource groups ${grouped ? 'exclude shared workers' : 'allow independent workers to overlap'}`, async t => {
    const { store, root } = setup(t, 'repair', (c, root) => {
      alternatives(c, 2);
      c.task.evaluators[0]!.resourceGroup = grouped ? 'benchmark-cpu' : undefined;
      const trace = join(root, 'trace.jsonl');
      writeFileSync(join(root, 'evaluators/repair.mjs'), `import {appendFileSync} from 'node:fs'; const file=${JSON.stringify(trace)}; appendFileSync(file,JSON.stringify({kind:'start',pid:process.pid})+'\\n'); setTimeout(()=>{appendFileSync(file,JSON.stringify({kind:'end',pid:process.pid})+'\\n');console.log(JSON.stringify({validity:'pass',checks:[{id:'addition',outcome:'pass'}]}));},120);`);
    });
    await runController(store);
    const trace = readFileSync(join(root, 'trace.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    let active = 0; let peak = 0;
    for (const event of trace) { active += event.kind === 'start' ? 1 : -1; peak = Math.max(peak, active); }
    assert.equal(active, 0); assert.equal(peak, grouped ? 1 : 2);
    assert.equal(store.state.status, 'completed');
  });
}

test('prepared attempts recover as unstarted without losing or charging their evaluation reserves', async t => {
  const { store } = setup(t, 'repair', c => alternatives(c, 2));
  await runController(store, { pauseAfter: 0 });
  const scheduler = new Scheduler(store, new AbortController().signal);
  const work = scheduler.prepare({ baseId: store.state.baselineId!, reason: 'Reserved before simulated crash' });
  assert.equal(budgetView(store.state).reserved.experiments, 1);
  scheduler.recover();
  assert.equal(store.state.works[work.id]!.state, 'released'); assert.equal(budgetView(store.state).reserved.experiments, 0);
  await runController(store); assert.equal(budgetView(store.state).spent.attempts, 2);
});

test('cancellation racing a completed wave releases unused evaluation holds', async t => {
  const { store } = setup(t, 'repair', c => alternatives(c, 2));
  const abort = new AbortController(); const fixture = new FixtureBackend(); let completed = 0;
  await runController(store, { signal: abort.signal, backend: { execute: async request => {
    const result = await fixture.execute(request); completed++; if (completed === 2) abort.abort(); return result;
  } } });
  assert.equal(store.state.status, 'cancelled'); assert.equal(budgetView(store.state).reserved.experiments, 0);
  assert.equal(budgetView(store.state).spent.attempts, 2);
});
