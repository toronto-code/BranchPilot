import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comparisonConfig, comparisonSchema, pairedOutcomeSummary, prepareComparison, runComparisonArm, writeComparisonReport } from '../src/comparison.js';
import type { ComparisonSpec } from '../src/comparison.js';
import type { Config } from '../src/types.js';
import { RunStore, hash } from '../src/store.js';
import { runCli } from '../src/cli.js';
import { setup } from './support.js';

function planFor(t: TestContext, modify: (config: Config) => void = () => undefined) {
  const { root, config } = setup(t, 'retry', modify);
  const configFile = join(root, 'config.json'); writeFileSync(configFile, JSON.stringify(config));
  const spec: ComparisonSpec = { schemaVersion: 1, dataset: 'offline-test', datasetRevision: 'fixture-v1', armSeconds: 90, taskSeconds: 60, taskTokens: 3000, searchAttempts: 3, cases: [{ id: 'repair', config: configFile }] };
  const file = join(root, 'suite.json'); writeFileSync(file, JSON.stringify(spec));
  const directory = join(root, 'comparison');
  return { root, config, configFile, spec, file, directory };
}

test('comparison versions share total allowances and differ in how attempts use them', t => {
  const { config, spec } = planFor(t);
  const baseline = comparisonConfig(config, spec, 'default'); const candidate = comparisonConfig(config, spec, 'new');
  assert.deepEqual(baseline.budget.total, candidate.budget.total);
  assert.equal(baseline.budget.wallSeconds, candidate.budget.wallSeconds);
  assert.deepEqual(baseline.agent.model, candidate.agent.model); assert.deepEqual(baseline.agent.effort, candidate.agent.effort);
  assert.equal(baseline.policy.mode, 'fixed'); assert.equal(candidate.policy.mode, 'auto');
  assert.equal(baseline.agent.promptProfile, 'basic'); assert.equal(candidate.agent.promptProfile, 'evidence');
  assert.equal(baseline.budget.perAttempt.tokenReservation, 3000); assert.equal(candidate.budget.perAttempt.tokenReservation, 1000);
  assert.ok(baseline.budget.perAttempt.timeoutSeconds > candidate.budget.perAttempt.timeoutSeconds);
});
test('comparison schemas leave one-hour defaults and support an explicit five-minute pilot', () => {
  const base = { schemaVersion: 1, dataset: 'fixed', datasetRevision: 'commit', cases: [{ id: 'one', config: 'one.json' }] };
  assert.equal(comparisonSchema.parse(base).armSeconds, 3600);
  assert.equal(comparisonSchema.parse(base).taskSeconds, 240);
  assert.equal(comparisonSchema.parse(base).searchAttempts, 3);
  assert.equal(comparisonSchema.parse({ ...base, armSeconds: 300, searchAttempts: 2 }).armSeconds, 300);
  assert.throws(() => comparisonSchema.parse({ ...base, armSeconds: 10 }), /exceed/);
  assert.throws(() => comparisonSchema.parse({ ...base, cases: [base.cases[0], base.cases[0]] }), /unique/);
  assert.throws(() => comparisonSchema.parse({ ...base, taskTokens: 3, searchAttempts: 6 }), /reservations/);
});
test('planning fingerprints sources without launching a backend or evaluator', t => {
  const { configFile, config, file, directory } = planFor(t);
  config.backend = { kind: 'muse', binary: '/must-not-launch', compatibilityLock: '/not-required-for-planning' };
  config.execution.isolationProfile = 'sandbox-exec';
  config.agent = { model: { kind: 'explicit', providerId: 'unverified-provider', modelId: 'unverified-model' }, effort: { kind: 'explicit', value: 'high' } };
  writeFileSync(configFile, JSON.stringify(config));
  prepareComparison(file, directory);
  const summary = writeComparisonReport(directory);
  assert.equal(summary.comparable, false); assert.equal(summary.modelQualityImproved, false);
  assert.equal(existsSync(join(directory, 'default')), false);
});
test('live execution requires explicit flags and a verified lock before a job starts', async t => {
  const { configFile, config, file, directory } = planFor(t);
  config.backend = { kind: 'muse', binary: '/must-not-launch', compatibilityLock: '/not-a-lock' };
  config.execution.isolationProfile = 'sandbox-exec';
  config.agent = { model: { kind: 'explicit', providerId: 'unverified', modelId: 'unverified' }, effort: { kind: 'explicit', value: 'high' } };
  writeFileSync(configFile, JSON.stringify(config)); prepareComparison(file, directory);
  await assert.rejects(runComparisonArm(directory, 'default'), /allow-live/);
  await assert.rejects(runComparisonArm(directory, 'default', { allowLive: true, allowProviderCost: true }));
  assert.equal(existsSync(join(directory, 'default', 'job.json')), false);
});
test('Muse comparisons reject host defaults and model preferences before creating a plan', t => {
  const { configFile, config, file, directory } = planFor(t);
  config.backend = { kind: 'muse', binary: '/not-launched', compatibilityLock: '/not-read' }; config.execution.isolationProfile = 'sandbox-exec';
  writeFileSync(configFile, JSON.stringify(config));
  assert.throws(() => prepareComparison(file, directory), /exact same explicit/); assert.equal(existsSync(directory), false);
});
test('repeated task content cannot inflate paired sample counts', t => {
  const { spec, file, directory } = planFor(t);
  spec.armSeconds = 180; spec.cases.push({ ...spec.cases[0]!, id: 'same-task-renamed' }); writeFileSync(file, JSON.stringify(spec));
  assert.throws(() => prepareComparison(file, directory), /independent comparison cases/);
});
test('planning rejects output inside inputs or trusted evaluators without changing them', t => {
  const { config, file } = planFor(t);
  for (const directory of [join(config.task.inputs[0]!.path, 'comparison'), join(config.task.evaluators[0]!.definition.path, '..', 'comparison')]) {
    assert.throws(() => prepareComparison(file, directory), /outside the input/); assert.equal(existsSync(directory), false);
  }
});
test('fixture comparison runs both versions but cannot certify a model-quality gain', async t => {
  const { file, directory } = planFor(t); prepareComparison(file, directory);
  await runComparisonArm(directory, 'default');
  assert.equal(writeComparisonReport(directory).modelQualityImproved, false);
  await runComparisonArm(directory, 'new');
  const summary = writeComparisonReport(directory);
  assert.equal(summary.comparable, true); assert.equal(summary.outcomes.wins, 1); assert.equal(summary.outcomes.losses, 0);
  assert.equal(summary.outcomes.baselineSolved, 0); assert.equal(summary.outcomes.candidateSolved, 1);
  assert.equal(summary.modelQualityImproved, false); assert.match(summary.qualityReasons.join(' '), /Fixture/);
  assert.equal(summary.totals.baseline!.tokens, 90); assert.equal(summary.totals.candidate!.tokens, 210);
  const baselineJob = JSON.parse(readFileSync(join(directory, 'default/job.json'), 'utf8'));
  const baseline = new RunStore(baselineJob.trials[0].runDirectory);
  assert.equal(Object.values(baseline.state.works).filter(w => w.kind === 'attempt').length, 1);
});
test('a started version cannot replay after completion or an interrupted task record', async t => {
  const { file, directory } = planFor(t); prepareComparison(file, directory);
  await runComparisonArm(directory, 'default');
  const jobFile = join(directory, 'default/job.json'); const before = readFileSync(jobFile, 'utf8');
  await assert.rejects(runComparisonArm(directory, 'default'), /never replay/); assert.equal(readFileSync(jobFile, 'utf8'), before);
  const job = JSON.parse(before); delete job.finishedAt; delete job.trials[0].seconds; writeFileSync(jobFile, JSON.stringify(job));
  await assert.rejects(runComparisonArm(directory, 'default'), /never replay/);
  assert.equal(writeComparisonReport(directory).comparable, false);
});
test('source drift and already-cancelled jobs fail before submitting work', async t => {
  const { config, file, directory } = planFor(t); prepareComparison(file, directory);
  await assert.rejects(runComparisonArm(directory, 'default', { signal: AbortSignal.abort() }));
  assert.equal(existsSync(join(directory, 'default/job.json')), false);
  writeFileSync(join(config.task.inputs[0]!.path, 'calculator.mjs'), 'changed after selection');
  await assert.rejects(runComparisonArm(directory, 'default'), /Source or environment changed/);
  assert.equal(existsSync(join(directory, 'default/job.json')), false);
});
test('a changed controller implementation cannot be mixed into the frozen comparison', async t => {
  const { file, directory } = planFor(t); prepareComparison(file, directory);
  const path = join(directory, 'plan.json'); const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.plan.implementation = 'old-build'; envelope.digest = hash(JSON.stringify(envelope.plan)); writeFileSync(path, JSON.stringify(envelope));
  await assert.rejects(runComparisonArm(directory, 'default'), /Implementation changed/);
});
test('unknown usage blocks comparison validity and is not averaged into zero tokens', async t => {
  const { file, directory } = planFor(t, config => { if (config.backend.kind === 'fixture') config.backend.plans[0]!.tokens = null; });
  prepareComparison(file, directory); await runComparisonArm(directory, 'default'); await runComparisonArm(directory, 'new');
  const summary = writeComparisonReport(directory);
  assert.equal(summary.comparable, false); assert.equal(summary.modelQualityImproved, false);
  assert.equal(summary.totals.baseline!.tokens, null); assert.equal(summary.totals.candidate!.tokens, null);
  assert.match(summary.qualityReasons.join(' '), /Unresolved/);
});
test('paired statistics use task-level discordant outcomes and do not certify a tiny win', () => {
  assert.equal(pairedOutcomeSummary([{ baseline: false, candidate: true }]).exactTwoSidedP, 1);
  const six = pairedOutcomeSummary(Array.from({ length: 6 }, () => ({ baseline: false, candidate: true })));
  assert.equal(six.exactTwoSidedP, 0.03125); assert.equal(six.deltaPercentagePoints, 100);
  const tied = pairedOutcomeSummary([{ baseline: true, candidate: false }, { baseline: false, candidate: true }]);
  assert.equal(tied.exactTwoSidedP, 1); assert.equal(tied.deltaPercentagePoints, 0);
  assert.equal(pairedOutcomeSummary([]).exactTwoSidedP, 1);
});
test('comparison CLI rejects unsupported version names and extra options before execution', async t => {
  const { file, directory } = planFor(t);
  await assert.rejects(runCli(['compare-plan', file]), /Provide --out/);
  await assert.rejects(runCli(['compare-run', directory, 'fast']), /Choose default or new/);
  await assert.rejects(runCli(['compare-report', directory, '--allow-live']), /Unknown option/);
  assert.equal(existsSync(directory), false);
});
