import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './support.js';
import { runController } from '../src/controller.js';
import { buildAttemptPrompt, HISTORY_CHARACTER_LIMIT } from '../src/handoff.js';
import { autoSwitch, nextPlan } from '../src/search.js';
import { budgetView } from '../src/budget.js';
import type { Config, Snapshot } from '../src/types.js';

const repeated = (config: Config) => {
  if (config.backend.kind !== 'fixture') throw Error();
  const failed = config.backend.plans[0]!;
  config.backend.plans = [structuredClone(failed), structuredClone(failed), config.backend.plans[1]!];
  config.task.selection.earlyStop = 'first_feasible';
};

test('retry handoff preserves goals, constraints and earlier development evidence without hidden results', async t => {
  const { store } = setup(t, 'retry'); await runController(store, { pauseAfter: 1 });
  const state = structuredClone(store.state); const base = state.revisions.at(-1)!;
  state.evaluations.push({ ...state.evaluations[0]!, id: 'hidden', split: 'held_out', feedback: 'HELD_OUT_SECRET', findings: ['HIDDEN_FINDING'] });
  const before = JSON.stringify(state);
  const prompt = buildAttemptPrompt(state, base, nextPlan(state)!, digest => store.getJSON(digest));
  const content = JSON.parse(prompt);
  assert.equal(content.goal, state.config.task.goal); assert.deepEqual(content.constraints, state.config.task.constraints);
  assert.equal(content.handoff.conversation, 'fresh-session'); assert.equal(content.handoff.history[0].relation, 'ancestor');
  assert.match(prompt, /Addition failed/); assert.doesNotMatch(prompt, /HELD_OUT_SECRET|HIDDEN_FINDING/);
  assert.equal(JSON.stringify(state), before);
});
test('independent alternatives get different approaches without seeing other candidate outcomes', async t => {
  const { store } = setup(t, 'concurrent', config => { if (config.backend.kind === 'fixture') config.backend.plans[0]!.proposal = 'SIBLING_SECRET'; });
  await runController(store, { pauseAfter: 1 });
  const state = store.state; const base = state.revisions[0]!;
  const first = Object.values(state.works).find(w => w.kind === 'attempt')!;
  const firstPrompt = JSON.parse(store.getJSON<{ prompt: string }>(first.intent).prompt);
  const next = buildAttemptPrompt(state, base, nextPlan(state)!, digest => store.getJSON(digest));
  const content = JSON.parse(next);
  assert.equal(content.handoff.independent, true); assert.deepEqual(content.handoff.history, []);
  assert.notEqual(content.approach.focus, firstPrompt.approach.focus); assert.equal(content.approach.alternative, 2);
  assert.doesNotMatch(next, /SIBLING_SECRET/);
});
test('tree handoffs label sibling findings as separate alternatives and bound history size', async t => {
  const { store } = setup(t, 'concurrent'); await runController(store, { pauseAfter: 2 });
  const state = structuredClone(store.state); state.strategy = { name: 'tree', width: 2, maxDepth: 3, maxChildren: 2 };
  const base = state.revisions[1]!; state.revisions[2]!.proposal = 'SIBLING_LESSON';
  const prompt = JSON.parse(buildAttemptPrompt(state, base, { baseId: base.id, reason: 'Expand tested branch' }, digest => store.getJSON(digest)));
  assert.ok(prompt.handoff.history.some((entry: { relation: string }) => entry.relation === 'sibling'));
  assert.match(JSON.stringify(prompt.handoff), /SIBLING_LESSON/);
  assert.ok(prompt.rules.some((rule: string) => rule.includes('not edits present here')));
  for (const evaluation of state.evaluations) { evaluation.checks = Array.from({ length: 1000 }, (_, i) => ({ id: `check-${i}`, outcome: 'fail' })); evaluation.feedback = 'long '.repeat(5000); }
  const large = JSON.parse(buildAttemptPrompt(state, base, { baseId: base.id, reason: 'Bounded history' }, digest => store.getJSON(digest)));
  assert.ok(JSON.stringify(large.handoff.history).length <= HISTORY_CHARACTER_LIMIT); assert.ok(large.handoff.omittedHistory > 0);
  assert.match(large.developmentFeedback[0].feedback, /characters omitted/);
});
test('handoff records cumulative additions, modifications, mode changes and deletions', async t => {
  const { store } = setup(t); await runController(store, { pauseAfter: 0 });
  const base = { ...store.state.revisions[0]!, snapshot: 'current' };
  const initial: Snapshot = { files: [{ path: 'removed', blob: 'x', executable: false }, { path: 'edited', blob: 'x', executable: false }, { path: 'mode', blob: 'x', executable: false }] };
  const current: Snapshot = { files: [{ path: 'added', blob: 'y', executable: false }, { path: 'edited', blob: 'y', executable: false }, { path: 'mode', blob: 'x', executable: true }] };
  const content = JSON.parse(buildAttemptPrompt(store.state, base, { baseId: base.id, reason: 'Inspect changes' }, digest => digest === 'current' ? current : initial));
  assert.deepEqual(content.handoff.changedFiles, [{ path: 'added', change: 'added' }, { path: 'edited', change: 'modified' }, { path: 'mode', change: 'modified' }, { path: 'removed', change: 'deleted' }]);
});
test('automatic search escapes a repeated failed repair without resetting its budget', async t => {
  const { store } = setup(t, 'auto', repeated); const state = await runController(store);
  assert.equal(state.outcome, 'goal_met');
  assert.equal(budgetView(state).spent.attempts, 3); assert.equal(budgetView(state).spent.tokens, 300);
  const switchDecision = state.decisions.find(d => d.action === 'switch:best-of-n');
  assert.match(switchDecision!.reason, /identical candidate content/); assert.ok(switchDecision!.evidenceIds.length);
  const attempts = Object.values(state.works).filter(w => w.kind === 'attempt');
  assert.equal(attempts[0]!.candidateId, attempts[1]!.candidateId); assert.notEqual(attempts[1]!.candidateId, attempts[2]!.candidateId);
});
test('stagnation needs complete unchanged evidence, settled work and automatic policy', async t => {
  const { store } = setup(t, 'auto', repeated); await runController(store, { pauseAfter: 2 });
  assert.equal(autoSwitch(store.state)!.strategy.name, 'best-of-n');
  for (const change of ['new-proposal', 'new-evidence', 'missing-evaluation', 'unknown-work', 'fixed-policy', 'no-alternatives']) {
    const state = structuredClone(store.state); const latest = state.revisions.at(-1)!;
    if (change === 'new-proposal') latest.proposal += ' New hypothesis';
    if (change === 'new-evidence') state.evaluations.at(-1)!.findings.push('A new observation');
    if (change === 'missing-evaluation') state.evaluations = state.evaluations.filter(e => e.revisionId !== latest.id);
    if (change === 'unknown-work') state.works[latest.attemptId!]!.state = 'unknown';
    if (change === 'fixed-policy') state.config.policy.mode = 'fixed';
    if (change === 'no-alternatives') state.config.policy.allowedStrategies = ['direct', 'retry'];
    assert.equal(autoSwitch(state), undefined, change);
  }
});
