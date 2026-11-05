import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aggregate, dominates, feasible, outputSchema } from '../src/evaluation.js';
import { configSchema, loadConfig } from '../src/config.js';
import { createRun, runController } from '../src/controller.js';
import { budgetView } from '../src/budget.js';
import { runCli } from '../src/cli.js';
import { RunStore } from '../src/store.js';
import type { Evaluation } from '../src/types.js';
import { setup } from './support.js';

const cli = resolve('dist/src/cli.js');

test('not-applicable repetitions cannot turn a partial assessment into a pass', () => {
  const pass = outputSchema.parse({ validity: 'pass' }); const na = outputSchema.parse({ validity: 'not_applicable' });
  assert.equal(aggregate([pass, na]).validity, 'inconclusive');
  assert.equal(aggregate([na, na]).validity, 'not_applicable');
});

test('all configured development evidence must pass before a candidate is feasible', () => {
  const config = loadConfig(resolve('examples/repair.json'));
  config.task.constraints = []; config.task.evaluators[0]!.role = 'rubric';
  const evaluation: Evaluation = { id: 'e', workId: 'w', revisionId: 'r', evaluatorId: config.task.evaluators[0]!.id, split: 'development', kind: 'executable', definitionDigest: 'd', environmentDigest: 'env', validity: 'not_applicable', checks: [], metrics: [], feedback: '', findings: [], evidence: [] };
  assert.equal(feasible(config, [evaluation]), false);
  evaluation.validity = 'pass'; assert.equal(feasible(config, [evaluation]), true);
  config.task.evaluators.push({ ...config.task.evaluators[0]!, id: 'missing-rubric' });
  assert.equal(feasible(config, [evaluation]), false);
});

test('Pareto improvement cannot spend tolerance as permission to worsen another objective', () => {
  const config = loadConfig(resolve('examples/optimization.json'));
  config.task.objectives = ['x', 'y'].map(metric => ({ metric, direction: 'minimize', unit: 'u', minMeaningfulChange: 1, evidenceKind: 'executable' }));
  const evidence = (id: string, x: number, y: number): Evaluation => ({ id, workId: id, revisionId: id, evaluatorId: 'measure', split: 'development', kind: 'executable', definitionDigest: 'same', environmentDigest: 'same', validity: 'pass', checks: [], metrics: [{ name: 'x', unit: 'u', samples: [x], estimate: x, uncertainty: { kind: 'unknown' } }, { name: 'y', unit: 'u', samples: [y], estimate: y, uncertainty: { kind: 'unknown' } }], feedback: '', findings: [], evidence: [] });
  assert.equal(dominates(config, [evidence('a', 1, 11)], [evidence('b', 10, 10)]), false);
});

test('CLI rejects misspelled, repeated and invalid options before creating run storage', async t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-cli-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['--pause-aftr', '1'], ['--pause-after', '-1'], ['--pause-after', '0.5'], ['--pause-after', '1', '--pause-after', '2'], ['extra-positional']]) {
    const output = join(root, 'runs');
    await assert.rejects(runCli(['run', 'examples/repair.json', '--out', output, ...args]));
    assert.equal(existsSync(output), false);
  }
});

test('CLI failure releases signal handlers when opening a run fails', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  await assert.rejects(runCli(['run', '/nonexistent/branchpilot-config.json']));
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('CLI entry point works when Node is invoked through a package-bin symlink', t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-bin-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, 'branchpilot.mjs'); symlinkSync(cli, link);
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /BranchPilot/);
});

test('a failed rebuildable projection cannot invalidate a committed work result', async t => {
  const { store } = setup(t);
  rmSync(join(store.dir, 'state.json')); mkdirSync(join(store.dir, 'state.json'));
  await runController(store);
  assert.equal(store.state.outcome, 'goal_met');
  assert.equal(budgetView(store.state).spent.attempts, 1);
  assert.deepEqual(new RunStore(store.dir).state, store.state);
  assert.equal(readdirSync(store.dir).some(path => path.startsWith('state.json.') && path.endsWith('.tmp')), false);
  assert.match(readFileSync(join(store.dir, 'report.md'), 'utf8'), /projection|cache/i);
});

test('failed writable-store setup does not leave a writer lock behind', t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-store-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'artifacts'), 'file conflicts with required directory');
  assert.throws(() => new RunStore(root, true));
  assert.equal(existsSync(join(root, 'writer.lock')), false);
});

test('trusted evaluator definitions cannot be hidden inside input through a directory alias', t => {
  const { root, config } = setup(t);
  const definitions = join(root, 'input', 'private-evaluators'); mkdirSync(definitions);
  writeFileSync(join(definitions, 'definition.json'), JSON.stringify({ schemaVersion: 1, script: 'check.mjs' }));
  writeFileSync(join(definitions, 'check.mjs'), 'console.log(JSON.stringify({validity:"pass"}));');
  const alias = join(root, 'definition-alias'); symlinkSync(definitions, alias);
  config.task.evaluators[0]!.definition.path = join(alias, 'definition.json');
  assert.throws(() => createRun(config, join(root, 'separate-runs')), /outside.*input|inside.*input/i);
});

test('pre-dispatch evaluator setup failure releases its reservation', async t => {
  const { store } = setup(t);
  const snapshot = store.getJSON<{ files: { blob: string }[] }>(store.state.manifest.initialSnapshot);
  rmSync(join(store.dir, 'artifacts', snapshot.files[0]!.blob));
  await runController(store);
  assert.equal(Object.values(store.state.works).some(work => work.state === 'running' || work.state === 'reserved'), false);
  assert.equal(budgetView(store.state).reserved.experiments, 0);
  assert.equal(budgetView(store.state).spent.experiments, 0);
});

test('operator-settled failed attempts release development evaluation escrow', async t => {
  const { store, root } = setup(t);
  await runController(store, { backend: { execute: async () => ({ outcome: 'unknown', tokens: 100, stopped: false, proposal: '', hypotheses: [], receipt: {} }) } });
  const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  const dir = store.dir; store.close(); const evidence = join(root, 'resolution.txt'); writeFileSync(evidence, 'Protocol simulation: stopped');
  await runCli(['resolve', dir, work.id, '--tokens', '100', '--seconds', String(work.actual!.workSeconds + 1), '--evidence', evidence, '--stopped']);
  const resolved = new RunStore(dir);
  assert.equal(budgetView(resolved.state).reserved.experiments, 0);
});

test('configuration rejects unsafe counts and ambiguous evaluator metadata', () => {
  const original = loadConfig(resolve('examples/repair.json'));
  for (const edit of [ (c: typeof original) => { c.budget.total.tokens = Number.MAX_SAFE_INTEGER + 1; }, (c: typeof original) => { c.task.constraints.push({ ...c.task.constraints[0]! }); }, (c: typeof original) => { c.task.evaluators[0]!.resourceGroup = ''; } ]) {
    const config = structuredClone(original); edit(config); assert.equal(configSchema.safeParse(config).success, false);
  }
});

test('worker output preserves UTF-8 characters split across pipe chunks', async t => {
  const { root } = setup(t);
  const { runProcess } = await import('../src/process.js');
  const script = `process.stdout.write('{"feedback":"'); process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>{process.stdout.write(Buffer.from([0x98,0x80]));process.stdout.write('"}');},100);`;
  const result = await runProcess(process.execPath, ['-e', script], { cwd: root, timeoutMs: 5000, graceMs: 100 });
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { feedback: '😀' });
});

test('worker output limits count bytes rather than UTF-16 characters', async t => {
  const { root } = setup(t); const { runProcess } = await import('../src/process.js');
  const result = await runProcess(process.execPath, ['-e', `process.stdout.write('é'.repeat(700000));`], { cwd: root, timeoutMs: 5000, graceMs: 100 });
  assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1024 * 1024);
});

test('an already-cancelled worker request never attempts to spawn its executable', async t => {
  const { root } = setup(t); const { runProcess } = await import('../src/process.js');
  const abort = new AbortController(); abort.abort();
  const result = await runProcess('/nonexistent/no-spawn-after-cancellation', [], { cwd: root, timeoutMs: 100, graceMs: 10, signal: abort.signal });
  assert.equal(result.cancelled, true); assert.equal(result.stopped, true);
});

test('exhausted tree search examines existing depths instead of looping to an enormous configured limit', () => {
  const script = `import {nextPlan} from './dist/src/search.js'; import {loadConfig} from './dist/src/config.js'; const state={config:loadConfig('./examples/repair.json'), strategy:{name:'tree',width:1,maxDepth:Number.MAX_SAFE_INTEGER,maxChildren:1}, baselineId:'base', revisions:[{id:'base',depth:0}], evaluations:[], works:{attempt:{kind:'attempt',state:'settled',revisionId:'base'}}}; process.stdout.write(String(nextPlan(state)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, String(result.error ?? result.stderr)); assert.equal(result.stdout, 'undefined');
});
