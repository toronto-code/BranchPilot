import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sandboxCommand, runProcess } from '../dist/src/process.js';
import { hash } from '../dist/src/store.js';

const { values } = parseArgs({ options: { prepared: { type: 'string' } } });
if (!values.prepared) throw Error('--prepared is required');
const root = resolve(values.prepared), file = join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(file, 'utf8'));
if (!manifest.validated || manifest.sandboxPreflight) throw Error('Require prepared data without a previous sandbox preflight');
manifest.sandboxPreflight = { passed: false, checks: [] }; writeFileSync(file, JSON.stringify(manifest, null, 2));
for (const task of manifest.cases) {
  // Refresh the adapter before freezing it; test data and reference code stay fixed.
  copyFileSync(new URL('./polyglot-grader.mjs', import.meta.url), join(task.assets, 'grader.mjs'));
  for (const [kind, split, expected] of [['reference', 'development', 'pass'], ['reference', 'held_out', 'pass'], ['input', 'held_out', 'fail']]) {
    const input = join(root, 'tasks', task.id, kind); const scratch = join(root, 'sandbox-checks', task.id, `${kind}-${split}`);
    mkdirSync(scratch, { recursive: true });
    const [command, args] = sandboxCommand(process.execPath, [join(task.assets, `${split}.mjs`), input], [input, task.assets], [scratch]);
    const result = await runProcess(command, args, { cwd: scratch, timeoutMs: 20000, graceMs: 3000, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch } });
    writeFileSync(join(scratch, 'execution.json'), JSON.stringify(result, null, 2));
    let output; try { output = JSON.parse(result.stdout); } catch { /* Refuse malformed results. */ }
    const passed = result.code === 0 && result.stopped && !result.timedOut && !result.truncated && output?.validity === expected;
    manifest.sandboxPreflight.checks.push({ task: task.id, kind, split, expected, observed: output?.validity, passed, seconds: result.seconds });
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    if (!passed) throw Error(`Isolated grader failed ${task.id}/${kind}/${split}: ${result.stderr.slice(-3000)} ${result.stdout.slice(-1500)}`);
  }
  const files = readdirSync(task.assets, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(task.assets, join(entry.parentPath, entry.name))).sort();
  task.assetDigests = Object.fromEntries(files.map(p => [p, hash(readFileSync(join(task.assets, p)))]));
  console.log(`${task.id}: real OS-isolated reference/development/final checks passed.`);
}
manifest.sandboxPreflight.passed = true; writeFileSync(file, JSON.stringify(manifest, null, 2));
