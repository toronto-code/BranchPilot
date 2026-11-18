import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runOfficialSuite, evaluatorEntry } from './polyglot-grader.mjs';

export const REVISION = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f';
export const SEED = 'branchpilot-polyglot-js-2026-11-05-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export const MAX_CASES = 14; // 240 seconds per case, with headroom under the one-hour arm ceiling.
const nonCorrectnessTasks = { ledger: 'Upstream requires refactoring an implementation that already passes the full suite.' };

export function selectPolyglotTasks(pool, { seed = SEED, count = 12, excluded = [] } = {}) {
  if (typeof seed !== 'string' || !seed.trim()) throw Error('A nonempty selection seed is required');
  if (!Number.isInteger(count) || count < 1 || count > MAX_CASES) throw Error(`Count must be between 1 and ${MAX_CASES}`);
  const eligible = new Set(pool);
  for (const id of excluded) if (!eligible.delete(id)) throw Error(`Unknown or duplicate excluded task: ${id}`);
  if (eligible.size < count) throw Error('The eligible pool is too small for the requested count');
  return [...eligible].sort((a, b) => digest(`${seed}:${a}`).localeCompare(digest(`${seed}:${b}`))).slice(0, count);
}

export async function preparePolyglot({ dataset, runtime, out, seed = SEED, count = 12, excludePrepared = [] }) {
  dataset = resolve(dataset); runtime = resolve(runtime); out = resolve(out);
  if (existsSync(out)) throw Error('Use a new preparation directory');
  const git = spawnSync('git', ['-C', dataset, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0 || git.stdout.trim() !== REVISION) throw Error('Dataset does not match the pinned public revision');
  const status = spawnSync('git', ['-C', dataset, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) throw Error('Dataset checkout must be unchanged');
  const root = join(dataset, 'javascript/exercises/practice'); const pool = readdirSync(root).sort();
  const excluded = new Set(Object.keys(nonCorrectnessTasks));
  for (const prepared of excludePrepared) {
    const previous = JSON.parse(readFileSync(join(prepared, 'manifest.json'), 'utf8'));
    if (previous.revision !== REVISION || !previous.validated || !Array.isArray(previous.selected)) throw Error('Exclusions require a validated preparation of the same dataset revision');
    for (const id of previous.selected) excluded.add(id);
  }
  const excludedTasks = [...excluded].sort();
  const selected = selectPolyglotTasks(pool, { seed, count, excluded: excludedTasks });
  mkdirSync(out, { recursive: true });
  const manifest = { schemaVersion: 1, source: 'https://github.com/Aider-AI/polyglot-benchmark', revision: REVISION, seed, pool, excluded: excludedTasks, selected,
    taskExclusions: nonCorrectnessTasks,
    runtimeDigest: digest(readFileSync(runtime)), testTransformation: 'Only xtest( becomes test(, matching upstream npm-test.sh; existing test.skip remains skipped.',
    timezone: 'UTC',
    split: 'Development gets the first 60% of unique full test names ordered by SHA-256(seed:task:name); final grading runs the entire official suite.',
    cases: [], validated: false };
  json(join(out, 'manifest.json'), manifest);
  for (const name of selected) {
    const source = join(root, name); const metadata = JSON.parse(readFileSync(join(source, '.meta/config.json'), 'utf8'));
    const solutions = metadata.files.solution; const tests = metadata.files.test; const examples = metadata.files.example;
    const dataDir = join(source, 'data');
    const fixtures = existsSync(dataDir) ? readdirSync(dataDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => relative(source, join(entry.parentPath, entry.name))).sort() : [];
    if (solutions.length !== 1 || examples.length !== 1) throw Error(`Unsupported reference layout: ${name}; keep task in the recorded selection`);
    for (const p of [...solutions, ...tests]) if (p.startsWith('/') || p.split('/').includes('..')) throw Error('Unsafe source path');
    const task = join(out, 'tasks', name); const input = join(task, 'input'); const assets = join(task, 'assets');
    mkdirSync(input, { recursive: true }); mkdirSync(join(assets, 'tests'), { recursive: true });
    for (const p of solutions) { mkdirSync(dirname(join(input, p)), { recursive: true }); copyFileSync(join(source, p), join(input, p)); }
    const instructions = ['introduction.md', 'instructions.md', 'instructions.append.md'].filter(f => existsSync(join(source, '.docs', f))).map(f => readFileSync(join(source, '.docs', f), 'utf8')).join('\n\n');
    const goal = `${instructions}\n\nImplement these solution files: ${solutions.join(', ')}. Fixed tests are run by the controller. You may create test.mjs for your own checks and run node test.mjs. Preserve the public interface. Do not alter tests or download solutions.`;
    writeFileSync(join(input, 'README.md'), goal + '\n\nAllowed shell commands: pwd, ls, ls -la, pwd; ls -la, node test.mjs. Use the file tools for other reads/edits.\n');
    // The upstream grep exercise launches its CommonJS CLI as a Node process.
    writeFileSync(join(input, 'package.json'), JSON.stringify({ private: true, type: name === 'grep' ? 'commonjs' : 'module' }));
    copyFileSync(join(source, 'LICENSE'), join(input, 'LICENSE'));
    for (const p of tests) { mkdirSync(dirname(join(assets, 'tests', p)), { recursive: true }); writeFileSync(join(assets, 'tests', p), readFileSync(join(source, p), 'utf8').replace(/\bxtest\(/g, 'test(')); }
    for (const p of fixtures) for (const destination of [join(assets, 'fixtures'), input]) {
      mkdirSync(dirname(join(destination, p)), { recursive: true });
      copyFileSync(join(source, p), join(destination, p));
    }
    copyFileSync(runtime, join(assets, 'runtime.tgz'));
    copyFileSync(new URL('./polyglot-grader.mjs', import.meta.url), join(assets, 'grader.mjs'));
    const caseData = { name, solutions, tests, fixtures };
    json(join(assets, 'case.json'), caseData);
    const reference = join(task, 'reference'); mkdirSync(reference);
    copyFileSync(join(source, examples[0]), join(reference, solutions[0]));
    const run = (workspace, split, label) => {
      const scratch = join(task, 'preflight', label); mkdirSync(scratch, { recursive: true });
      return runOfficialSuite({ workspace, assets, split, scratch });
    };
    const full = run(reference, 'held_out', 'reference-full');
    if (full.output.validity !== 'pass') throw Error(`Official reference failed ${name}: ${full.output.feedback}`);
    const names = [...new Set(full.names)].sort((a, b) => digest(`${seed}:${name}:${a}`).localeCompare(digest(`${seed}:${name}:${b}`)));
    if (names.length < 2) throw Error(`Cannot partition ${name} without reusing all final tests`);
    const chosen = new Set(names.slice(0, Math.max(1, Math.min(names.length - 1, Math.ceil(names.length * 0.6)))));
    caseData.all = full.names; caseData.development = full.names.filter(n => chosen.has(n));
    json(join(assets, 'case.json'), caseData);
    const development = run(reference, 'development', 'reference-development');
    const stub = run(input, 'held_out', 'stub-full'); const stubDev = run(input, 'development', 'stub-development');
    if (development.output.validity !== 'pass' || stub.output.validity !== 'fail' || stubDev.output.validity !== 'fail') {
      throw Error(`Reference/starter discrimination failed for ${name}: development reference ${development.output.validity}; starter full ${stub.output.validity}, development ${stubDev.output.validity}`);
    }
    const files = ['case.json', 'grader.mjs', 'runtime.tgz', ...tests.map(p => 'tests/' + p), ...fixtures.map(p => 'fixtures/' + p)];
    for (const split of ['development', 'held_out']) {
      writeFileSync(join(assets, `${split}.mjs`), evaluatorEntry(split));
      json(join(assets, `${split}.json`), { schemaVersion: 1, script: `${split}.mjs`, files });
    }
    const entry = { id: name, input, assets, goal, tests: full.names.length, developmentTests: caseData.development.length, hiddenOnlyTests: full.names.length - caseData.development.length,
      skipped: full.skipped, preflight: { referenceFull: full.output.validity, referenceDevelopment: development.output.validity, starterFull: stub.output.validity, starterDevelopment: stubDev.output.validity, referenceSeconds: full.seconds },
      sourceDigests: Object.fromEntries([...solutions, ...tests, ...fixtures, '.meta/config.json', ...examples].map(p => [p, digest(readFileSync(join(source, p)))])) };
    manifest.cases.push(entry); json(join(out, 'manifest.json'), manifest);
    console.log(`${name}: reference passed ${full.names.length} tests, starter failed; ${entry.developmentTests} development / ${entry.hiddenOnlyTests} additional final checks.`);
  }
  manifest.validated = true; json(join(out, 'manifest.json'), manifest); return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dataset: { type: 'string' }, runtime: { type: 'string' }, out: { type: 'string' },
    seed: { type: 'string' }, count: { type: 'string' }, 'exclude-prepared': { type: 'string', multiple: true } } });
  if (!values.dataset || !values.runtime || !values.out) throw Error('Supply --dataset, --runtime, and --out');
  await preparePolyglot({ ...values, count: values.count === undefined ? undefined : Number(values.count), excludePrepared: values['exclude-prepared'] });
}
