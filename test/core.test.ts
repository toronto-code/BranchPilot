import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { configSchema, loadConfig } from '../src/config.js';
import type { Config, Evaluation, Work } from '../src/types.js';
import { createRun, runController, switchStrategy } from '../src/controller.js';
import { budgetView, zero } from '../src/budget.js';
import { dominates, outputSchema } from '../src/evaluation.js';
import { id, RunStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { capture, contained, materialize, rejectNestedStorage } from '../src/workspaces.js';
import { runProcess } from '../src/process.js';
import { FixtureBackend } from '../src/backend.js';
import { renderReport } from '../src/report.js';
import { compatibilitySchema } from '../src/muse.js';

function setup(t: TestContext, example = 'repair', modify: (c: Config, root: string) => void = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-test-'));
  const config = loadConfig(resolve(`examples/${example}.json`));
  const input = join(root, 'input'); cpSync(config.task.inputs[0]!.path, input, { recursive: true }); config.task.inputs[0]!.path = input;
  const evaluatorDir = join(root, 'evaluators'); cpSync(resolve('examples/evaluators'), evaluatorDir, { recursive: true });
  for (const evaluator of config.task.evaluators) evaluator.definition.path = join(evaluatorDir, basename(evaluator.definition.path));
  modify(config, root);
  const store = createRun(config, join(root, 'runs'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store };
}

test('direct run evaluates real baseline/output, preserves input, and rebuilds from log', async t => {
  const { store, root } = setup(t);
  const state = await runController(store);
  assert.equal(state.status, 'completed'); assert.equal(state.outcome, 'goal_met');
  assert.deepEqual(state.evaluations.map(e => e.validity), ['fail', 'pass']);
  assert.equal(budgetView(state).spent.tokens, 120); assert.equal(budgetView(state).spent.attempts, 1);
  assert.match(readFileSync(join(root, 'input/calculator.mjs'), 'utf8'), /a - b/);
  assert.notEqual(state.revisions[0]!.snapshot, state.revisions[1]!.snapshot);
  const dir = store.dir; const expected = structuredClone(state); store.close();
  rmSync(join(dir, 'state.json'));
  const replay = new RunStore(dir, true); t.after(() => replay.close());
  assert.deepEqual(replay.state, expected);
  const seq = replay.sequence; await runController(replay); assert.equal(replay.sequence, seq);
  const exported = join(root, 'export'); materialize(replay, state.revisions[1]!.snapshot, exported);
  assert.match(readFileSync(join(exported, 'calculator.mjs'), 'utf8'), /a \+ b/);
  assert.throws(() => materialize(replay, state.revisions[1]!.snapshot, exported), /empty/);
});

test('retry creates immutable revisions for the same candidate and spends cumulatively', async t => {
  const { store } = setup(t, 'retry'); const state = await runController(store);
  assert.equal(state.outcome, 'goal_met'); assert.equal(state.revisions.length, 3);
  assert.equal(state.revisions[1]!.candidateId, state.revisions[2]!.candidateId);
  assert.equal(state.revisions[2]!.previousId, state.revisions[1]!.id);
  assert.equal(budgetView(state).spent.tokens, 210);
  const second = Object.values(state.works).filter(w => w.kind === 'attempt')[1]!;
  assert.match(store.get(second.intent).toString(), /Addition failed/);
});

test('failed agent attempts count against per-candidate retry caps', async t => {
  const { store } = setup(t, 'retry', c => {
    if (c.backend.kind !== 'fixture') throw Error();
    c.backend.plans = Array.from({ length: 8 }, () => ({ files: {}, hypotheses: [], tokens: 20, delayMs: 0, outcome: 'failed' }));
  });
  const state = await runController(store);
  assert.equal(budgetView(state).spent.attempts, 3);
  assert.equal(state.outcome, 'inconclusive');
});

test('best-of-N gates benchmark scores on correctness and freezes held-out selection', async t => {
  const { store } = setup(t, 'optimization'); const state = await runController(store);
  assert.equal(state.status, 'completed'); assert.equal(state.finalists!.length, 2);
  const bad = state.revisions[1]!;
  assert.equal(state.evaluations.some(e => e.revisionId === bad.id && e.evaluatorId === 'reads'), false);
  const attempts = Object.values(state.works).filter(w => w.kind === 'attempt');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(a => a.revisionId === state.baselineId));
  for (const work of attempts) assert.doesNotMatch(store.get(work.intent).toString(), /unique-heldout|final-correctness/);
  const baselineMetric = state.evaluations.find(e => e.revisionId === state.baselineId && e.evaluatorId === 'reads')!.metrics[0]!;
  const improved = state.evaluations.find(e => e.revisionId === state.finalists![0] && e.evaluatorId === 'reads')!.metrics[0]!;
  assert.ok(improved.estimate < baselineMetric.estimate);
  const events = readFileSync(join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n').flatMap(line => JSON.parse(line).events);
  const freeze = events.findIndex(e => e.type === 'finalists.selected');
  assert.ok(events.findIndex(e => e.type === 'work.reserved' && e.work.phase === 'held_out') > freeze);
});

test('automatic policy logs its switch and retains spending', async t => {
  const { store } = setup(t, 'auto'); const state = await runController(store);
  assert.equal(state.outcome, 'goal_met'); assert.equal(state.epoch, 1);
  assert.equal(budgetView(state).spent.attempts, 2);
  assert.ok(state.decisions.some(d => d.action === 'switch:retry' && d.evidenceIds.length > 0));
});

test('tree advances beyond finished parents and respects beam, depth, and child caps', async t => {
  const { store } = setup(t, 'repair', (c, root) => {
    c.strategy = { name: 'tree', width: 1, maxDepth: 2, maxChildren: 2 };
    writeFileSync(join(root, 'input/calculator.mjs'), 'export function add(a,b) { return a+b; }');
    if (c.backend.kind !== 'fixture') throw Error();
    c.backend.plans = Array.from({ length: 8 }, () => ({ files: {}, hypotheses: [], tokens: 20, delayMs: 0, outcome: 'completed' }));
  });
  const state = await runController(store);
  const attempts = Object.values(state.works).filter(w => w.kind === 'attempt');
  assert.equal(attempts.length, 4);
  assert.equal(Math.max(...state.revisions.map(r => r.depth)), 2);
  for (const parent of state.revisions) assert.ok(attempts.filter(w => w.revisionId === parent.id).length <= 2);
  assert.equal(new Set(attempts.filter(w => w.revisionId !== state.baselineId).map(w => w.revisionId)).size, 1);
});

test('manual switch at a checkpoint preserves run, deadline, evidence and budget', async t => {
  const { store } = setup(t, 'retry', c => { c.strategy = { name: 'direct' }; });
  await runController(store, { pauseAfter: 1 });
  assert.equal(store.state.status, 'paused');
  const deadline = store.state.deadline; const runId = store.state.id; const evidenceIds = store.state.evaluations.map(e => e.id);
  switchStrategy(store, { name: 'retry', maxAttemptsPerCandidate: 3 });
  await runController(store);
  assert.equal(store.state.id, runId); assert.equal(store.state.deadline, deadline); assert.equal(store.state.outcome, 'goal_met');
  assert.ok(evidenceIds.every(e => store.state.evaluations.some(x => x.id === e))); assert.equal(budgetView(store.state).spent.tokens, 210);
  assert.throws(() => switchStrategy(store, { name: 'direct' }), /termination/);
});

test('missing token usage retains liability and prevents resume dispatch', async t => {
  const { store } = setup(t, 'repair', c => { if (c.backend.kind === 'fixture') c.backend.plans[0]!.tokens = null; });
  await runController(store); assert.equal(store.state.status, 'needs_attention');
  assert.equal(budgetView(store.state).unknown.tokens, 1000);
  await runController(store);
  assert.equal(Object.values(store.state.works).filter(w => w.kind === 'attempt').length, 1);
  assert.throws(() => switchStrategy(store, { name: 'direct' }), /usage/);
});

test('unknown dispatched work is never resubmitted after resume', async t => {
  const { store } = setup(t); let calls = 0;
  const backend = { execute: async () => { calls++; throw Error('Connection lost after submit'); } };
  await runController(store, { backend }); assert.equal(store.state.status, 'needs_attention');
  await runController(store, { backend }); assert.equal(calls, 1);
  assert.equal(budgetView(store.state).unknown.attempts, 1);
});

test('completed receipts reconcile a crash before the transaction is appended', async t => {
  const { store } = setup(t); await runController(store);
  const rows = readFileSync(join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n');
  const index = rows.findIndex(line => JSON.parse(line).events.some((e: { type: string; revision?: { attemptId?: string } }) => e.type === 'revision.created' && e.revision?.attemptId));
  assert.ok(index > 0); const dir = store.dir; store.close();
  writeFileSync(join(dir, 'events.jsonl'), rows.slice(0, index).join('\n') + '\n');
  const recovered = new RunStore(dir, true); t.after(() => recovered.close());
  let calls = 0;
  await runController(recovered, { backend: { execute: async () => { calls++; throw Error('Must not repeat'); } } });
  assert.equal(calls, 0); assert.equal(recovered.state.outcome, 'goal_met');
  assert.equal(recovered.state.revisions.length, 2); assert.equal(budgetView(recovered.state).spent.attempts, 1);
});

test('unstarted reservations can be released during recovery', async t => {
  const { store } = setup(t); await runController(store, { pauseAfter: 0 });
  const work: Work = { id: id(), kind: 'attempt', phase: 'search', revisionId: store.state.baselineId!, reservation: { ...zero(), tokens: 1000, attempts: 1, workSeconds: 5 }, state: 'reserved', intent: store.putJSON({ example: true }), workspace: join(store.dir, 'not-started'), index: 0, epoch: 0 };
  store.append({ type: 'work.reserved', work });
  await runController(store);
  assert.equal(store.state.works[work.id]!.state, 'released'); assert.equal(budgetView(store.state).spent.attempts, 1);
});

test('budget exhaustion stops before dispatching an unaffordable attempt', async t => {
  const { store } = setup(t, 'repair', c => { c.budget.total.attempts = 0; });
  let calls = 0; await runController(store, { backend: { execute: async () => { calls++; throw Error(); } } });
  assert.equal(calls, 0); assert.equal(store.state.outcome, 'inconclusive');
  assert.ok(store.state.decisions.some(d => d.reason.includes('Insufficient attempts')));
});

test('cancellation settles the fixture, records spend and does not evaluate partial work', async t => {
  const { store } = setup(t, 'repair', c => { if (c.backend.kind === 'fixture') c.backend.plans[0]!.delayMs = 1000; });
  const abort = new AbortController(); const fixture = new FixtureBackend();
  await runController(store, { signal: abort.signal, backend: { execute: async request => { setTimeout(() => abort.abort(), 20); return fixture.execute(request); } } });
  assert.equal(store.state.status, 'cancelled'); assert.equal(store.state.revisions.length, 1);
  assert.equal(budgetView(store.state).spent.attempts, 1); assert.equal(budgetView(store.state).reserved.attempts, 0);
});

test('process timeout confirms worker termination', async t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-process-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, timeoutMs: 100, graceMs: 50 });
  assert.equal(result.timedOut, true); assert.equal(result.stopped, true); assert.ok(result.seconds < 3);
});

test('input and evaluator content are frozen before the first attempt', async t => {
  const { store, root } = setup(t);
  writeFileSync(join(root, 'input/calculator.mjs'), 'throw new Error("source changed");');
  writeFileSync(join(root, 'evaluators/repair.mjs'), 'throw new Error("evaluator changed");');
  await runController(store); assert.equal(store.state.outcome, 'goal_met');
});

test('malformed evaluator output is infrastructure failure, not an incorrect candidate', async t => {
  const { store } = setup(t, 'repair', (_c, root) => writeFileSync(join(root, 'evaluators/repair.mjs'), 'console.log("not-json");'));
  await runController(store);
  assert.equal(store.state.status, 'needs_attention'); assert.equal(store.state.evaluations[0]!.validity, 'inconclusive');
  assert.equal(store.state.evaluations[0]!.failureType, 'infrastructure'); assert.equal(budgetView(store.state).spent.attempts, 0);
});

test('mutating evaluator invalidates the result', async t => {
  const { store } = setup(t, 'repair', (_c, root) => writeFileSync(join(root, 'evaluators/repair.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2]+"/calculator.mjs", "changed"); console.log(JSON.stringify({validity:"pass"}));'));
  await runController(store); assert.equal(store.state.evaluations[0]!.failureType, 'infrastructure');
  assert.match(store.state.evaluations[0]!.feedback, /changed/);
});

test('held-out failure does not rerank finalists or restart search', async t => {
  const { store } = setup(t, 'repair', (c, root) => {
    c.task.evaluators.push({ ...c.task.evaluators[0]!, id: 'final', split: 'held_out', definition: { path: join(root, 'evaluators/final.json') } });
    writeFileSync(join(root, 'evaluators/final.json'), JSON.stringify({ schemaVersion: 1, script: 'final.mjs' }));
    writeFileSync(join(root, 'evaluators/final.mjs'), 'console.log(JSON.stringify({validity:"fail",feedback:"Final check failed"}));');
    c.budget.finalizationReserve = { tokens: 0, workSeconds: 10, attempts: 0, experiments: 2 };
  });
  await runController(store); assert.equal(store.state.outcome, 'inconclusive');
  assert.equal(store.state.finalists!.length, 1); assert.equal(budgetView(store.state).spent.attempts, 1);
  assert.equal(store.state.status, 'completed');
});

test('held-out check constraints are deferred until final assessment', async t => {
  const { store } = setup(t, 'repair', c => {
    c.task.evaluators.push({ ...c.task.evaluators[0]!, id: 'final', split: 'held_out' });
    c.task.constraints.push({ id: 'held-out-addition', kind: 'check', evaluatorId: 'final', check: 'addition' });
    c.budget.finalizationReserve = { tokens: 0, workSeconds: 10, attempts: 0, experiments: 2 };
  });
  await runController(store);
  assert.equal(store.state.outcome, 'goal_met'); assert.equal(store.state.finalists!.length, 1);
  assert.equal(store.state.evaluations.filter(e => e.split === 'held_out').length, 2);
});

test('optimization may improve an over-target baseline, but held-out metric violations fail final assessment', async t => {
  const { store } = setup(t, 'optimization', (c, root) => {
    c.task.constraints.push({ id: 'read-limit', kind: 'metric', metric: 'input_reads', unit: 'reads', op: 'lte', value: 1000 });
    writeFileSync(join(root, 'evaluators/unique-heldout.mjs'), 'console.log(JSON.stringify({validity:"pass",metrics:[{name:"input_reads",unit:"reads",value:1001}]}));');
  });
  await runController(store);
  assert.equal(budgetView(store.state).spent.attempts, 3);
  assert.equal(store.state.finalists!.length, 2);
  assert.equal(store.state.outcome, 'inconclusive');
});

test('a missing objective measurement cannot be selected as a measured optimum', async t => {
  const { store } = setup(t, 'optimization', (_c, root) => {
    writeFileSync(join(root, 'evaluators/unique-benchmark.mjs'), 'console.log(JSON.stringify({validity:"pass"}));');
  });
  await runController(store);
  assert.equal(store.state.outcome, 'inconclusive'); assert.equal(store.state.status, 'failed');
  assert.equal(budgetView(store.state).spent.attempts, 0);
});

test('frozen evaluator seed is supplied to every repetition', async t => {
  const { store } = setup(t, 'repair', (_c, root) => {
    writeFileSync(join(root, 'evaluators/repair.json'), JSON.stringify({ schemaVersion: 1, script: 'repair.mjs', seed: 72 }));
    writeFileSync(join(root, 'evaluators/repair.mjs'), 'console.log(JSON.stringify({validity:"pass",checks:[{id:"addition",outcome:"pass"}],metrics:[{name:"seed",unit:"seed",value:Number(process.env.BRANCHPILOT_SEED)}]}));');
  });
  await runController(store);
  assert.ok(store.state.evaluations.every(e => e.metrics[0]!.estimate === 72));
});

test('human rubric pauses, records explicit provenance, and continues without duplicates', async t => {
  const { store } = setup(t, 'ideas', (c, root) => {
    c.strategy = { name: 'direct' };
    c.task.evaluators = [{ id: 'human', kind: 'human_preference', split: 'development', role: 'rubric', definition: { path: join(root, 'evaluators/human-rubric.json') }, dependsOn: [], repetitions: 1, warmups: 0, timeoutSeconds: 60 }];
  });
  await runController(store); assert.equal(store.state.status, 'paused'); assert.ok(store.state.pending);
  const scheduler = new Scheduler(store, new AbortController().signal);
  scheduler.assess(outputSchema.parse({ validity: 'pass', feedback: 'Baseline assessed' }), 'Test reviewer');
  await runController(store); assert.equal(store.state.status, 'paused');
  scheduler.assess(outputSchema.parse({ validity: 'pass', feedback: 'Candidate assessed' }), 'Test reviewer');
  await runController(store); assert.equal(store.state.status, 'completed');
  assert.equal(budgetView(store.state).spent.attempts, 1); assert.equal(store.state.evaluations.length, 2);
  assert.match(store.get(store.state.evaluations[0]!.evidence[0]!).toString(), /Test reviewer/);
});

test('checksummed log rejects corruption but quarantines only an incomplete tail', async t => {
  const { store } = setup(t); await runController(store, { pauseAfter: 0 }); const seq = store.sequence;
  const dir = store.dir; store.close(); appendFileSync(join(dir, 'events.jsonl'), '{"incomplete":');
  const recovered = new RunStore(dir, true); t.after(() => recovered.close());
  recovered.repairTail(); assert.equal(recovered.sequence, seq + 1);
  recovered.close();
  const text = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  writeFileSync(join(dir, 'events.jsonl'), text.replace('repair-addition', 'tampered-task'));
  assert.throws(() => new RunStore(dir), /Corrupt event log/);
});

test('active writer lock prevents competing controllers', t => {
  const { store } = setup(t); assert.throws(() => new RunStore(store.dir, true), /active writer/);
  assert.ok(existsSync(join(store.dir, 'writer.lock')));
});

test('snapshots and fixture edits reject traversal and symlinks', t => {
  const { store, root } = setup(t);
  assert.throws(() => contained(root, '../outside'), /Unsafe/);
  assert.throws(() => contained(root, '/outside'), /Unsafe/);
  const path = join(root, 'symlink-test'); mkdirSync(path); symlinkSync('/private/tmp', join(path, 'link'));
  assert.throws(() => capture(store, path), /symlinks/);
  const alias = join(root, 'input-alias'); symlinkSync(join(root, 'input'), alias);
  assert.throws(() => rejectNestedStorage(join(root, 'input'), join(alias, 'runs/new-run')), /outside/);
  const empty = join(root, 'empty'); mkdirSync(empty); const target = join(root, 'export-link'); symlinkSync(empty, target);
  assert.throws(() => materialize(store, store.state.manifest.initialSnapshot, target), /symlink/);
  symlinkSync(join(root, 'missing'), join(root, 'dangling'));
  assert.throws(() => contained(root, 'dangling/child'), /Symlink/);
});

test('schema rejects unsupported knobs and cyclic/cross-split dependencies', () => {
  const config = loadConfig(resolve('examples/repair.json'));
  assert.equal(configSchema.safeParse({ ...config, unknown: 123 }).success, false);
  config.task.evaluators[0]!.dependsOn = [config.task.evaluators[0]!.id];
  assert.equal(configSchema.safeParse(config).success, false);
  assert.equal(compatibilitySchema.safeParse({ sdkVersion: '1.4.13', verifiedAt: null }).success, false);
});

test('Pareto comparison refuses incompatible evidence and preserves missing measurements', () => {
  const config = loadConfig(resolve('examples/optimization.json'));
  const a: Evaluation = { id: 'a', workId: 'a', revisionId: 'a', evaluatorId: 'reads', split: 'development', kind: 'executable', definitionDigest: 'same', environmentDigest: 'same', validity: 'pass', checks: [], metrics: [{ name: 'input_reads', unit: 'reads', samples: [3, 3], estimate: 3, uncertainty: { kind: 'range', low: 3, high: 3 } }], feedback: '', findings: [], evidence: [] };
  const b = structuredClone(a); b.id = 'b'; b.metrics[0]!.samples = [20, 20]; b.metrics[0]!.estimate = 20;
  assert.equal(dominates(config, [a], [b]), true);
  b.environmentDigest = 'different'; assert.equal(dominates(config, [a], [b]), false);
  assert.equal(dominates(config, [a], []), false);
});

test('idea reports preserve hypotheses and do not claim demonstrated success', async t => {
  const { store } = setup(t, 'ideas'); await runController(store);
  assert.equal(store.state.revisions[1]!.hypotheses.length, 1);
  assert.notEqual(store.state.outcome, 'goal_met');
  assert.match(renderReport(store), /Scientific validity remains untested/);
  assert.match(renderReport(store), /Replay fixed trace; reject if hits below 20%/);
});
