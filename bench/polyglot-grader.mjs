import { lstatSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Runs the real Jest suite with only the upstream xtest -> test change.
 * Candidate configuration and tests are never copied into the trusted runner.
 * All runtime bytes and tests are frozen evaluator assets; no network/install.
 */
export function runOfficialSuite({ workspace, assets, split, scratch }) {
  const task = JSON.parse(readFileSync(join(assets, 'case.json'), 'utf8'));
  const expected = split === 'development' ? task.development : task.all;
  if (split === 'development' && (!Array.isArray(expected) || !expected.length)) throw Error('Missing development test selection');
  const missing = task.solutions.filter(path => !lstatSync(join(workspace, path), { throwIfNoEntry: false })?.isFile());
  if (missing.length) return { output: { validity: 'fail', checks: [{ id: 'correct', outcome: 'fail' }],
    feedback: `Expected a solution file at: ${missing.join(', ')}`, findings: [] },
    names: [], assertions: [], seconds: 0, exitCode: null, complete: false, skipped: [] };
  // Jest discovers canonical paths. Its absolute testMatch must use the same
  // spelling even when the system temp directory is a symlink (e.g. /var).
  mkdirSync(scratch, { recursive: true });
  scratch = realpathSync(scratch);
  const runtime = join(scratch, 'runtime'); const project = join(scratch, 'project');
  mkdirSync(runtime, { recursive: true }); mkdirSync(project, { recursive: true });
  const extract = spawnSync('/usr/bin/tar', ['-xzf', join(assets, 'runtime.tgz'), '-C', runtime], { encoding: 'utf8', timeout: 12000 });
  if (extract.status !== 0) throw Error(`Frozen test runtime could not be unpacked: ${extract.stderr}`);
  for (const path of task.solutions) { const dest = join(project, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(workspace, path), dest); }
  for (const path of task.tests) { const dest = join(project, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(assets, 'tests', path), dest); }
  for (const path of task.fixtures ?? []) { const dest = join(project, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(assets, 'fixtures', path), dest); }
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }));
  const modules = join(runtime, 'node_modules');
  const config = { rootDir: project, testMatch: task.tests.map(p => join(project, p)), testEnvironment: 'node', watchman: false,
    cacheDirectory: join(scratch, 'cache'), transform: { '^.+\\.js$': [join(modules, 'babel-jest'), { babelrc: false, configFile: false, presets: [join(modules, '@exercism/babel-preset-javascript')] }] } };
  const configPath = join(scratch, 'jest.json'); const reportPath = join(scratch, 'jest-results.json');
  writeFileSync(configPath, JSON.stringify(config));
  const pattern = expected?.length ? `^(?:${expected.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$` : undefined;
  const args = [join(modules, 'jest/bin/jest.js'), '--config', configPath, '--runInBand', '--no-cache', '--json', '--outputFile', reportPath,
    ...(split === 'development' && pattern ? ['--testNamePattern', pattern] : [])];
  const began = performance.now();
  const execution = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CI: 'true', FORCE_COLOR: '0', TZ: 'UTC' } });
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* Syntax/timeout failures remain failed attempts. */ }
  const assertions = report?.testResults?.flatMap(s => s.assertionResults) ?? [];
  const ran = assertions.filter(t => t.status !== 'pending' && t.status !== 'todo');
  const names = ran.map(t => t.fullName);
  const complete = !expected || JSON.stringify([...names].sort()) === JSON.stringify([...expected].sort());
  const passed = execution.status === 0 && report?.success === true && ran.length > 0 && complete && ran.every(t => t.status === 'passed');
  // Jest's source frames can include neighboring, withheld test cases.
  // Return assertion diagnostics, but never stack traces or source excerpts.
  const diagnostic = text => text.replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(line => !/^\s*(?:>\s*)?\d+\s*\|/.test(line) && !/^\s*\|/.test(line) && !/^\s+at\s/.test(line)).join('\n');
  const checks = [{ id: 'correct', outcome: passed ? 'pass' : 'fail' }];
  const development = split === 'development' ? new Set(task.development) : undefined;
  if (development && complete) {
    // Jest can report duplicate full names. Every occurrence must pass.
    const outcomes = new Map();
    for (const assertion of ran) outcomes.set(assertion.fullName, outcomes.get(assertion.fullName) !== false && assertion.status === 'passed');
    for (const name of development) checks.push({ id: `test: ${name}`, outcome: outcomes.get(name) ? 'pass' : 'fail' });
  }
  const failures = ran.filter(t => t.status === 'failed' && (!development || development.has(t.fullName)))
    .map(t => `${t.fullName}: ${diagnostic((t.failureMessages ?? []).join('\n'))}`);
  const fallback = development ? 'Jest did not produce a complete passing development report. Check that the solution loads and exports the required API.'
    : String(execution.error ?? execution.stderr ?? 'Test execution failed').slice(-12000);
  const feedback = passed ? `${ran.length} official assertions passed.` : failures.join('\n').slice(0, 12000) || fallback;
  rmSync(runtime, { recursive: true, force: true });
  return { output: { validity: passed ? 'pass' : 'fail', checks, feedback, findings: [] },
    names, assertions: assertions.map(t => ({ name: t.fullName, status: t.status })), seconds: (performance.now() - began) / 1000,
    exitCode: execution.status, complete, skipped: assertions.filter(t => t.status === 'pending').map(t => t.fullName) };
}

export function evaluatorEntry(split) {
  return `import {dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {runOfficialSuite} from './grader.mjs';\nconst result=runOfficialSuite({workspace:process.argv[2],assets:dirname(fileURLToPath(import.meta.url)),scratch:process.cwd(),split:${JSON.stringify(split)}});console.log(JSON.stringify(result.output));\n`;
}
