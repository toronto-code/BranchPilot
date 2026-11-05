import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { runController } from '../src/controller.js';
import { setup } from './support.js';

const cli = resolve('dist/src/cli.js');
function command(args: string[], status = 0): string {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
}

test('CLI pauses, switches, resumes, inspects, reports and exports a real fixture result', t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = command(['run', 'examples/retry.json', '--out', join(root, 'runs'), '--pause-after', '1']);
  const dir = /^Run directory: (.+)$/m.exec(output)![1]!;
  const before = JSON.parse(command(['inspect', dir]));
  assert.equal(before.status, 'paused');
  command(['switch', dir, '{"name":"retry","maxAttemptsPerCandidate":3}']);
  assert.match(command(['resume', dir]), /completed: goal_met/);
  const after = JSON.parse(command(['inspect', dir]));
  assert.equal(after.runId, before.runId); assert.equal(after.budget.spent.attempts, 2);
  assert.match(command(['report', dir]), /SIMULATION/);
  command(['export', dir, after.finalists[0], join(root, 'export')]);
  assert.match(readFileSync(join(root, 'export/calculator.mjs'), 'utf8'), /a \+ b/);
  const seq = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  command(['resume', dir]);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), seq);
  command(['not-a-command', join(root, 'must-not-exist')], 1);
  assert.equal(existsSync(join(root, 'must-not-exist')), false);
});

test('CLI validates runnable examples and a human assessment can resume its pending checkpoint', t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['repair', 'retry', 'auto', 'optimization', 'ideas', 'tree', 'human-review']) command(['validate', `examples/${name}.json`]);
  const output = command(['run', 'examples/human-review.json', '--out', join(root, 'runs')]);
  const dir = /^Run directory: (.+)$/m.exec(output)![1]!;
  assert.equal(JSON.parse(command(['inspect', dir])).pending.evaluatorId, 'human-review');
  const assessment = join(root, 'assessment.json');
  writeFileSync(assessment, JSON.stringify({ validity: 'pass', feedback: 'Synthetic assessment for CLI integration testing only.' }));
  command(['assess', dir, assessment, '--rater', 'Integration test fixture']);
  command(['resume', dir]);
  assert.equal(JSON.parse(command(['inspect', dir])).pending.evaluatorId, 'human-review');
  command(['assess', dir, assessment, '--rater', 'Integration test fixture']);
  command(['resume', dir]);
  assert.equal(JSON.parse(command(['inspect', dir])).status, 'completed');
});

test('invalid Muse lock blocks run and doctor without invoking the configured binary', t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'executed'); const binary = join(root, 'not-muse');
  writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const config = loadConfig(resolve('examples/repair.json'));
  config.backend = { kind: 'muse', binary, compatibilityLock: resolve('examples/muse-lock.template.json') };
  config.execution.isolationProfile = 'sandbox-exec';
  const path = join(root, 'muse.json'); writeFileSync(path, JSON.stringify(config));
  command(['validate', path]);
  command(['doctor', path], 1); command(['run', path, '--out', join(root, 'runs')], 1);
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(root, 'runs')), false);
});

test('CLI resolution cannot erase observed usage from uncertain work', async t => {
  const { store, root } = setup(t);
  await runController(store, { backend: { execute: async () => ({ outcome: 'unknown', tokens: 2500, stopped: false, proposal: '', hypotheses: [], receipt: { simulated: true } }) } });
  const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  const seconds = work.actual!.workSeconds + 1;
  const sequence = store.sequence; const dir = store.dir; store.close();
  const evidence = join(root, 'resolution.json'); writeFileSync(evidence, JSON.stringify({ simulated: true, stopped: true }));
  command(['resolve', dir, work.id, '--tokens', '2499', '--seconds', String(seconds), '--evidence', evidence, '--stopped'], 1);
  assert.equal(JSON.parse(command(['inspect', dir])).budget.unknown.tokens, 2500);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, sequence);
  command(['resolve', dir, work.id, '--tokens', '2600', '--seconds', String(seconds), '--evidence', evidence, '--stopped']);
  const resolved = JSON.parse(command(['inspect', dir]));
  assert.equal(resolved.budget.spent.tokens, 2600); assert.equal(resolved.budget.unknown.tokens, 0);
});
