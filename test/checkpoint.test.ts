import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './support.js';
import { runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';

test('a stopped token-limited edit is externally graded and can meet the goal', async t => {
  const { store } = setup(t, 'repair');
  await runController(store, { backend: { execute: async request => {
    writeFileSync(join(request.work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }');
    // Optional claim metadata may be interrupted; code is judged independently.
    writeFileSync(join(request.work.workspace, 'branchpilot-result.json'), '{');
    request.reportUsage!(request.work.reservation.tokens); assert.equal(request.signal.aborted, true);
    return { outcome: 'cancelled', tokens: request.work.reservation.tokens, stopped: true, proposal: 'unverified claim', hypotheses: [], receipt: {} };
  } } });
  assert.equal(store.state.outcome, 'goal_met');
  const attempt = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  assert.equal(attempt.outcome, 'cancelled'); assert.equal(attempt.state, 'settled');
  assert.equal(budgetView(store.state).spent.tokens, attempt.reservation.tokens);
  assert.ok(store.state.evaluations.some(e => e.revisionId === attempt.outputRevisionId && e.validity === 'pass'));
  assert.match(readFileSync(join(store.dir, 'events.jsonl'), 'utf8'), /attempt.checkpoint/);
});

test('a failed checkpoint feeds the next repair instead of discarding edits or resetting spending', async t => {
  const { store } = setup(t, 'auto', config => { config.budget.total.tokens = 1000; config.budget.perAttempt.tokenReservation = 100; config.task.selection.earlyStop = 'first_feasible'; });
  let calls = 0;
  await runController(store, { backend: { execute: async request => {
    calls++;
    if (calls === 1) {
      writeFileSync(join(request.work.workspace, 'progress.txt'), 'preserve this');
      request.reportUsage!(100);
      return { outcome: 'cancelled', tokens: 100, stopped: true, proposal: '', hypotheses: [], receipt: {} };
    }
    assert.equal(readFileSync(join(request.work.workspace, 'progress.txt'), 'utf8'), 'preserve this');
    assert.match(request.prompt, /developmentFeedback/);
    writeFileSync(join(request.work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }');
    return { outcome: 'completed', tokens: 40, stopped: true, proposal: '', hypotheses: [], receipt: {} };
  } } });
  assert.equal(calls, 2); assert.equal(store.state.outcome, 'goal_met'); assert.equal(budgetView(store.state).spent.tokens, 140);
});

for (const condition of ['user-cancelled', 'missing-usage', 'not-stopped'] as const) test(`partial edits are not promoted when ${condition}`, async t => {
  const { store } = setup(t, 'repair'); const cancel = new AbortController();
  await runController(store, { signal: cancel.signal, backend: { execute: async request => {
    writeFileSync(join(request.work.workspace, 'calculator.mjs'), 'export function add(a,b) { return a+b; }');
    request.reportUsage!(request.work.reservation.tokens);
    if (condition === 'user-cancelled') cancel.abort();
    return { outcome: 'cancelled', tokens: condition === 'missing-usage' ? null : request.work.reservation.tokens, stopped: condition !== 'not-stopped', proposal: '', hypotheses: [], receipt: {} };
  } } });
  assert.equal(store.state.revisions.filter(r => r.attemptId).length, 0);
  assert.notEqual(store.state.outcome, 'goal_met');
});
