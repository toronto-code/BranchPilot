import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './support.js';
import { createRun, runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { protocolExpectation, SimulatedMuseHost } from './muse-host.js';
import { recordEvaluationExposure, evaluationKey } from '../src/evaluation-history.js';
import { renderReport } from '../src/report.js';
import { RunStore } from '../src/store.js';
import { initializeProject, listRuns, verifyRun } from '../src/project.js';
import { loadConfig } from '../src/config.js';

test('active SDK usage cancels at allocation and accounts for the complete overrun', async t => {
  const { store } = setup(t);
  const host = new SimulatedMuseHost({ onTurn: h => { h.usage(1400); }, onCancel: h => { h.usage(1500); h.complete('cancelled'); } });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  assert.equal(host.frames.filter(f => f.method === 'turn/cancel').length, 1);
  assert.equal(budgetView(store.state).spent.tokens, 1500);
  assert.equal(store.state.revisions.length, 1);
  assert.match(readFileSync(join(store.dir, 'events.jsonl'), 'utf8'), /budget.token_limit/);
});

test('token cancellation without a terminal retains liability and never repeats execution', async t => {
  const { store } = setup(t, 'repair', c => { c.budget.cancellationGraceSeconds = 0.02; });
  const host = new SimulatedMuseHost({ onTurn: h => { h.usage(1400); }, onCancel: () => undefined });
  const backend = { execute: (request: Parameters<typeof executeMuseProtocol>[0]) => executeMuseProtocol(request, protocolExpectation, host.factory) };
  await runController(store, { backend }); await runController(store, { backend });
  assert.equal(store.state.status, 'needs_attention');
  assert.equal(budgetView(store.state).unknown.tokens, 1400);
  assert.equal(host.frames.filter(f => f.method === 'turn/start').length, 1);
});

test('observe policy records streaming usage without cancelling the turn', async t => {
  const { store } = setup(t, 'repair', c => { c.budget.tokenLimitPolicy = 'observe'; });
  const host = new SimulatedMuseHost({ onTurn: h => { h.usage(1400); setTimeout(() => h.complete(), 150); } });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  assert.equal(host.frames.some(f => f.method === 'turn/cancel'), false);
  assert.equal(budgetView(store.state).spent.tokens, 1400);
});

test('invalid latest SDK usage keeps earlier tokens as a lower bound instead of final spend', async t => {
  const { store } = setup(t);
  const host = new SimulatedMuseHost({ onTurn: h => { h.usage(450); setTimeout(() => { h.usage('invalid'); h.complete(); }, 150); } });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  assert.equal(work.actual!.tokens, null); assert.equal(work.observedTokens, 450);
  assert.equal(store.state.status, 'needs_attention');
});

test('streamed usage survives backend failure and remains durable after replay', async t => {
  const { store } = setup(t);
  await runController(store, { backend: { execute: async request => { request.reportUsage!(1700); throw Error('Connection lost after usage'); } } });
  assert.equal(budgetView(store.state).unknown.tokens, 1700);
  const replay = new RunStore(store.dir);
  assert.equal(budgetView(replay.state).unknown.tokens, 1700);
});

test('evaluation history discloses held-out reuse across runs and survives replay', async t => {
  const { store, config, root } = setup(t, 'optimization');
  await runController(store);
  const next = createRun(config, join(root, 'runs')); t.after(() => next.close());
  await runController(next);
  const held = next.state.evaluationExposures!.find(e => e.split === 'held_out')!;
  assert.equal(held.prior!.runId, store.state.id);
  assert.match(renderReport(next), /not independent held-out evidence/);
  assert.deepEqual(new RunStore(next.dir).state.evaluationExposures, next.state.evaluationExposures);
});

test('reject policy blocks previously exposed holdout before starting a new search', async t => {
  const { store, config, root } = setup(t, 'optimization'); await runController(store);
  config.evaluationHistory = { reuse: 'reject' };
  assert.throws(() => createRun(config, join(root, 'runs')), /already exposed/);
});

test('holdout claims close the race between two strict runs created before exposure', t => {
  const { store, config, root } = setup(t, 'optimization', c => { c.evaluationHistory = { reuse: 'reject' }; });
  const second = createRun(config, join(root, 'runs')); t.after(() => second.close());
  const held = store.state.manifest.evaluators.find(e => e.spec.split === 'held_out')!;
  recordEvaluationExposure(store, held);
  assert.throws(() => recordEvaluationExposure(second, held), /already exposed/);
  assert.doesNotThrow(() => recordEvaluationExposure(store, held));
  assert.equal(store.state.evaluationExposures!.length, 1);
});

test('explicit dataset IDs detect reuse even after evaluator code changes', t => {
  const { store, config, root } = setup(t, 'optimization', c => {
    c.task.evaluators.find(e => e.split === 'held_out')!.datasetId = 'test-corpus-v1';
    c.evaluationHistory = { reuse: 'reject' };
  });
  recordEvaluationExposure(store, store.state.manifest.evaluators.find(e => e.spec.split === 'held_out')!);
  writeFileSync(join(root, 'evaluators/unique-heldout.mjs'), 'console.log(JSON.stringify({validity:"pass"}));');
  assert.throws(() => createRun(config, join(root, 'runs')), /already exposed/);
});

test('strict holdout rejects data also named by development, and registry corruption fails closed', t => {
  const { store, config, root } = setup(t, 'optimization');
  config.evaluationHistory = { reuse: 'reject' };
  config.task.evaluators[0]!.datasetId = 'shared'; config.task.evaluators.at(-1)!.datasetId = 'shared';
  assert.throws(() => createRun(config, join(root, 'runs')), /shares held-out data/);
  const held = store.state.manifest.evaluators.find(e => e.spec.split === 'held_out')!;
  recordEvaluationExposure(store, held);
  const directory = join(store.state.manifest.evaluationHistory!.directory, evaluationKey(held));
  writeFileSync(join(directory, 'first.json'), '{broken');
  delete config.task.evaluators[0]!.datasetId; delete config.task.evaluators.at(-1)!.datasetId;
  assert.throws(() => createRun(config, join(root, 'runs')));
  assert.equal(readdirSync(directory).filter(file => file.endsWith('.tmp')).length, 0);
});

test('starter projects run without the source examples and cannot overwrite existing files', async t => {
  const { root } = setup(t);
  const directory = join(root, 'starter'); initializeProject(directory, 'code');
  const config = loadConfig(join(directory, 'config.json'));
  const store = createRun(config, join(directory, 'runs')); t.after(() => store.close());
  await runController(store); assert.equal(store.state.outcome, 'goal_met');
  assert.throws(() => initializeProject(directory, 'idea'), /EEXIST/);
  assert.match(readFileSync(join(directory, 'config.json'), 'utf8'), /repair-addition/);
  const listed = listRuns(join(directory, 'runs')) as { id: string; status: string }[];
  assert.equal(listed.length, 1); assert.equal(listed[0]!.id, store.state.id);
  assert.equal(listed[0]!.status, 'completed');
});

test('read-only integrity verification checks artifacts and references without needing workspaces', async t => {
  const { store } = setup(t); await runController(store); store.close();
  rmSync(join(store.dir, 'workspaces'), { recursive: true });
  const verified = verifyRun(new RunStore(store.dir));
  assert.ok(verified.artifacts > 0); assert.equal(verified.sequence, store.sequence);
  const snapshot = store.getJSON<{ files: { blob: string }[] }>(store.state.revisions[1]!.snapshot);
  rmSync(join(store.dir, 'artifacts', snapshot.files[0]!.blob));
  assert.throws(() => verifyRun(new RunStore(store.dir)), /ENOENT/);
});

test('integrity verification refuses active writers, corrupt artifacts, and incomplete log tails', async t => {
  const { store } = setup(t); await runController(store);
  assert.throws(() => verifyRun(new RunStore(store.dir)), /writer/); store.close();
  const path = join(store.dir, 'artifacts', store.state.manifest.configDigest);
  const original = readFileSync(path); writeFileSync(path, 'corrupt');
  assert.throws(() => verifyRun(new RunStore(store.dir)), /checksum/);
  writeFileSync(path, original); appendFileSync(join(store.dir, 'events.jsonl'), '{partial');
  assert.throws(() => verifyRun(new RunStore(store.dir)), /Incomplete/);
});
