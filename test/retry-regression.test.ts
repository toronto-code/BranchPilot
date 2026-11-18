import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from '../src/backend.js';
import { budgetView } from '../src/budget.js';
import { runController } from '../src/controller.js';
import { nextPlan } from '../src/search.js';
import { setup } from './support.js';

const grader = (cases: [string, number, number][]) => `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { add } = await import(pathToFileURL(join(process.argv[2], 'calculator.mjs')));
const cases = ${JSON.stringify(cases)};
const checks = cases.map(([id, a, b]) => ({ id, outcome: add(a,b) === a+b ? 'pass' : 'fail' }));
console.log(JSON.stringify({ validity: checks.every(c => c.outcome === 'pass') ? 'pass' : 'fail', checks }));
`;

// The last edit repairs rounding in whichever snapshot the controller supplies.
const backend: Backend = { execute: async ({ work }) => {
  const file = join(work.workspace, 'calculator.mjs');
  if (work.index === 0) writeFileSync(file, 'export const add = (a,b) => Math.trunc(a+b);');
  else if (work.index === 1) writeFileSync(file, 'export const add = (a,b) => a < 0 ? 0 : Math.trunc(a+b);');
  else writeFileSync(file, readFileSync(file, 'utf8').replace('Math.trunc(a+b)', '(a+b)'));
  return { stopped: true, outcome: 'completed', tokens: 100, proposal: '', hypotheses: [], receipt: {} };
} };

for (const mode of ['auto', 'fixed'] as const) test(`${mode} retry after a regressed edit survives pause and resume`, async t => {
  const { store } = setup(t, mode === 'auto' ? 'auto' : 'retry', (c, root) => {
    c.budget.total.attempts = 3;
    c.task.constraints = []; // Acceptance still requires all configured evaluators to pass.
    c.task.selection.earlyStop = 'first_feasible';
    const dir = join(root, 'evaluators');
    writeFileSync(join(dir, 'repair.mjs'), grader([['positive', 2, 3], ['negative', -4, 7], ['fraction', 1.25, 0.5]]));
    writeFileSync(join(dir, 'final.mjs'), grader([['withheld', -2.5, 0.75]]));
    writeFileSync(join(dir, 'final.json'), JSON.stringify({ schemaVersion: 1, script: 'final.mjs' }));
    c.task.evaluators.push({ ...c.task.evaluators[0]!, id: 'final', split: 'held_out', definition: { path: join(dir, 'final.json') } });
    c.budget.finalizationReserve = { tokens: 0, attempts: 0, experiments: 2, workSeconds: 10 };
  });
  const before = await runController(store, { backend, pauseAfter: 2 });
  const [, first, second] = before.revisions;
  assert.equal(before.status, 'paused');
  const plan = nextPlan(before)!;
  assert.equal(plan.baseId, mode === 'auto' ? first!.id : second!.id);
  if (mode === 'auto') {
    const branched = structuredClone(before);
    branched.revisions.at(-1)!.parentIds = [branched.baselineId!];
    assert.equal(nextPlan(branched)!.baseId, first!.id, 'Retain better checkpoints from before a rollback');
    branched.revisions.find(r => r.id === first!.id)!.candidateId = 'unrelated';
    assert.equal(nextPlan(branched)!.baseId, second!.id, 'Independent candidates are excluded');
    for (const variant of ['tradeoff', 'unknown', 'missing', 'different-environment', 'infrastructure', 'held-out']) {
      const state = structuredClone(before);
      const latest = state.evaluations.find(e => e.revisionId === second!.id)!;
      const prior = state.evaluations.find(e => e.revisionId === first!.id)!;
      if (variant === 'tradeoff') latest.checks.find(c => c.id === 'fraction')!.outcome = 'pass';
      if (variant === 'unknown') latest.checks[0]!.outcome = 'unknown';
      if (variant === 'missing') latest.checks.pop();
      if (variant === 'different-environment') prior.environmentDigest = 'other';
      if (variant === 'infrastructure') latest.failureType = 'infrastructure';
      if (variant === 'held-out') prior.split = 'held_out';
      assert.equal(nextPlan(state)!.baseId, second!.id, variant);
    }
  }
  const after = await runController(store, { backend });
  assert.equal(after.outcome, mode === 'auto' ? 'goal_met' : 'inconclusive');
  assert.equal(budgetView(after).spent.tokens, 300);
  const attempts = Object.values(after.works).filter(w => w.kind === 'attempt');
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map(w => w.candidateId)).size, 1);
  assert.deepEqual(after.revisions.at(-1)!.parentIds, [plan.baseId]);
  if (mode === 'auto') {
    const { prompt } = store.getJSON<{ prompt: string }>(attempts[2]!.intent);
    assert.doesNotMatch(prompt, /withheld/);
    assert.ok(after.evaluations.some(e => e.revisionId === after.revisions.at(-1)!.id && e.split === 'held_out' && e.validity === 'pass'));
    const history = JSON.parse(prompt).handoff.history;
    assert.equal(history[0].relation, 'regressed_retry');
    assert.equal(history[0].revisionId, second!.id);
  }
});
