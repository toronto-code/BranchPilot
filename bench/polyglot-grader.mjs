import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Runs the real Jest suite with only the upstream xtest -> test change.
 * Candidate configuration and tests are never copied into the trusted runner.
 * All runtime bytes and tests are frozen evaluator assets; no network/install.
 */
export function runOfficialSuite({ workspace, assets, split, scratch }) {
  const task = JSON.parse(readFileSync(join(assets, 'case.json'), 'utf8'));
  const runtime = join(scratch, 'runtime'); const project = join(scratch, 'project');
  mkdirSync(runtime, { recursive: true }); mkdirSync(project, { recursive: true });
  const extract = spawnSync('/usr/bin/tar', ['-xzf', join(assets, 'runtime.tgz'), '-C', runtime], { encoding: 'utf8', timeout: 12000 });
  if (extract.status !== 0) throw Error(`Frozen test runtime could not be unpacked: ${extract.stderr}`);
  for (const path of task.solutions) { const dest = join(project, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(workspace, path), dest); }
  for (const path of task.tests) { const dest = join(project, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(assets, 'tests', path), dest); }
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }));
  const modules = join(runtime, 'node_modules');
  const config = { rootDir: project, testMatch: task.tests.map(p => join(project, p)), testEnvironment: 'node', watchman: false,
    cacheDirectory: join(scratch, 'cache'), transform: { '^.+\\.js$': [join(modules, 'babel-jest'), { babelrc: false, configFile: false, presets: [join(modules, '@exercism/babel-preset-javascript')] }] } };
  const configPath = join(scratch, 'jest.json'); const reportPath = join(scratch, 'jest-results.json');
  writeFileSync(configPath, JSON.stringify(config));
  const expected = split === 'development' ? task.development : task.all;
  const pattern = expected?.length ? `^(?:${expected.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$` : undefined;
  const args = [join(modules, 'jest/bin/jest.js'), '--config', configPath, '--runInBand', '--no-cache', '--json', '--outputFile', reportPath,
    ...(split === 'development' && pattern ? ['--testNamePattern', pattern] : [])];
  const began = performance.now();
  const execution = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CI: 'true', FORCE_COLOR: '0' } });
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
  const failures = assertions.filter(t => t.status === 'failed').map(t => `${t.fullName}: ${diagnostic((t.failureMessages ?? []).join('\n'))}`);
  const feedback = passed ? `${ran.length} official assertions passed.` : (failures.join('\n').slice(0, 12000) || String(execution.error ?? execution.stderr ?? 'Test execution failed').slice(-12000));
  rmSync(runtime, { recursive: true, force: true });
  return { output: { validity: passed ? 'pass' : 'fail', checks: [{ id: 'correct', outcome: passed ? 'pass' : 'fail' }], feedback, findings: [] },
    names, assertions: assertions.map(t => ({ name: t.fullName, status: t.status })), seconds: (performance.now() - began) / 1000,
    exitCode: execution.status, complete, skipped: assertions.filter(t => t.status === 'pending').map(t => t.fullName) };
}

export function evaluatorEntry(split) {
  return `import {dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {runOfficialSuite} from './grader.mjs';\nconst result=runOfficialSuite({workspace:process.argv[2],assets:dirname(fileURLToPath(import.meta.url)),scratch:process.cwd(),split:${JSON.stringify(split)}});console.log(JSON.stringify(result.output));\n`;
}
