// Controller benchmarks only. No Muse host, provider, or model-quality measurement.
import assert from 'node:assert/strict';
import { cpus, release, platform, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const accepted = new Set(['--implementation', '--repetitions', '--suite', '--out']);
const seen = new Set();
for (let i = 0; i < args.length; i += 2) {
  if (!accepted.has(args[i]) || seen.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Usage: performance.mjs [--suite overhead|reuse] [--repetitions 1–20] [--out NEW_DIRECTORY] [--implementation COMPILED_SRC_DIRECTORY]');
  seen.add(args[i]);
}
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const implementation = resolve(option('--implementation', join(repository, 'dist/src')));
const repetitions = Number(option('--repetitions', '3'));
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw Error('Use 1–20 repetitions');
const suite = option('--suite', 'overhead');
if (!['overhead', 'reuse'].includes(suite)) throw Error('Use --suite overhead or --suite reuse');
const output = resolve(option('--out', join(repository, '.branchpilot/performance', `run-${Date.now()}`)));
const { RunStore, hash } = await import(pathToFileURL(join(implementation, 'store.js')));
const { loadConfig } = await import(pathToFileURL(join(implementation, 'config.js')));
const { createRun, runController } = await import(pathToFileURL(join(implementation, 'controller.js')));
const { frontier } = await import(pathToFileURL(join(implementation, 'evaluation.js')));
const { budgetView } = await import(pathToFileURL(join(implementation, 'budget.js')));
const { FixtureBackend } = await import(pathToFileURL(join(implementation, 'backend.js')));
const { rejectNestedStorage } = await import(pathToFileURL(join(implementation, 'workspaces.js')));
const config = () => {
  const c = loadConfig(join(repository, 'examples/repair.json'));
  if (c.backend.kind !== 'fixture' || c.task.evaluators.some(e => e.kind !== 'executable')) throw Error('Performance benchmarks require offline fixtures and executable evaluators; Muse and human checkpoints are not supported');
  return c;
};
for (const input of config().task.inputs) rejectNestedStorage(input.path, output);
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output); // Never overwrite an earlier measurement.
const implementationDigest = hash(JSON.stringify(readdirSync(implementation).filter(name => name.endsWith('.js')).sort().map(name => [name, hash(readFileSync(join(implementation, name)))])));
const scratch = mkdtempSync(join(tmpdir(), 'branchpilot-performance-'));
const samples = [];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function syntheticArchive(count) {
  const c = config(); c.task.type = 'optimization'; c.task.constraints = [];
  c.task.objectives = [
    { metric: 'time', unit: 'ms', direction: 'minimize', minMeaningfulChange: 0, evidenceKind: 'executable' },
    { metric: 'memory', unit: 'bytes', direction: 'minimize', minMeaningfulChange: 0, evidenceKind: 'executable' },
  ];
  const artifact = 'a'.repeat(64);
  const state = { id: 'synthetic-archive', config: c, manifest: { configDigest: artifact, initialSnapshot: artifact, evaluators: [], environment: artifact, backend: { kind: 'fixture', simulated: true } }, startedAt: '2026-01-01T00:00:00.000Z', deadline: '2099-01-01T00:00:00.000Z', status: 'active', phase: 'search', strategy: { name: 'best-of-n', n: count }, epoch: 0, epochStartAttempts: 0, revisions: [], works: {}, evaluations: [], decisions: [], baselineId: 'revision-0' };
  for (let i = 0; i < count; i++) {
    const revisionId = `revision-${i}`;
    state.revisions.push({ id: revisionId, candidateId: `candidate-${i}`, parentIds: i ? ['revision-0'] : [], snapshot: artifact, proposal: `Synthetic archive record ${i}. `.repeat(20), hypotheses: [], depth: i ? 1 : 0, createdAt: state.startedAt });
    state.evaluations.push({ id: `evaluation-${i}`, workId: `work-${i}`, revisionId, evaluatorId: c.task.evaluators[0].id, split: 'development', kind: 'executable', definitionDigest: artifact, environmentDigest: artifact, validity: 'pass', checks: [], metrics: [{ name: 'time', unit: 'ms', samples: [i + 1, i + 1], estimate: i + 1, uncertainty: { kind: 'range', low: i + 1, high: i + 1 } }, { name: 'memory', unit: 'bytes', samples: [count - i, count - i], estimate: count - i, uncertainty: { kind: 'range', low: count - i, high: count - i } }], feedback: 'Synthetic tradeoff for controller benchmarking, not measured candidate performance.', findings: [], evidence: [] });
  }
  return state;
}
async function measure(name, repetition, execute) {
  const cpu = process.cpuUsage(); const started = performance.now();
  const evidence = await execute();
  const elapsedMs = performance.now() - started; const usage = process.cpuUsage(cpu);
  samples.push({ name, repetition, elapsedMs, cpuMs: (usage.user + usage.system) / 1000, evidence });
  console.log(`${name}: ${elapsedMs.toFixed(1)} ms`);
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
function save() {
  const summary = [...new Set(samples.map(s => s.name))].map(name => {
    const rows = samples.filter(s => s.name === name); const times = rows.map(s => s.elapsedMs);
    return { name, repetitions: rows.length, medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), medianCpuMs: median(rows.map(s => s.cpuMs)), evidence: rows[0].evidence };
  });
  writeFileSync(join(output, 'results.json'), JSON.stringify({ schemaVersion: 1, suite, node: process.version, platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, implementationDigest, implementation, simulated: true, summary, samples }, null, 2));
}
try {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    if (suite === 'reuse') {
      // Alternate ordering; both cases get the same plans, input and budget.
      for (const reuse of repetition % 2 ? [true, false] : [false, true]) {
        await measure(`repair-8-${reuse ? 'reuse' : 'fresh'}-checks`, repetition, async () => {
          const c = config(); c.strategy = { name: 'best-of-n', n: 8 }; c.budget.maxConcurrency = 2;
          c.task.evaluators[0].reuseIdentical = reuse;
          c.backend.plans = Array.from({ length: 8 }, () => structuredClone(c.backend.plans[0]));
          const run = createRun(c, join(scratch, `reuse-${reuse}-${repetition}`));
          try {
            const state = await runController(run); const budget = budgetView(state);
            assert.equal(state.outcome, 'goal_met');
            assert.equal(budget.spent.attempts, 8); assert.equal(budget.spent.tokens, 960);
            assert.equal(budget.spent.experiments, reuse ? 2 : 9);
            const reused = state.evaluations.filter(e => e.reusedFrom).length;
            assert.equal(reused, reuse ? 7 : 0);
            assert.equal(budget.reserved.experiments, 0);
            return { outcome: state.outcome, attempts: 8, experiments: budget.spent.experiments, tokens: budget.spent.tokens, reusedChecks: reused };
          } finally { run.close(); }
        });
      }
      save(); continue;
    }
    const archive = syntheticArchive(250);
    await measure('frontier-250-tradeoffs-x3', repetition, () => {
      let result;
      for (let iteration = 0; iteration < 3; iteration++) result = frontier(archive);
      assert.deepEqual(result.map(r => r.id), archive.revisions.map(r => r.id));
      return { candidates: 250, queries: 3, resultDigest: digest(result.map(r => r.id)) };
    });
    const directory = join(scratch, `events-${repetition}`);
    const store = new RunStore(directory, true); store.append({ type: 'run.created', state: archive });
    await measure('durable-stream-1000-events', repetition, () => {
      const artifact = store.putJSON({ simulated: true, text: 'Stream event body' });
      for (let i = 0; i < 1000; i++) store.append({ type: 'backend.event', workId: 'simulated-work', kind: 'muse.item', artifact });
      store.close();
      assert.deepEqual(new RunStore(directory).state, store.state);
      return { events: 1000, sequence: store.sequence, replayMatches: true };
    });
    const updates = new RunStore(directory, true);
    await measure('durable-decisions-250', repetition, () => {
      for (let i = 0; i < 250; i++) updates.append({ type: 'decision.recorded', decision: { id: `decision-${i}`, epoch: 0, reason: 'Synthetic allocation decision', action: 'develop', evidenceIds: [`evaluation-${i}`] } });
      updates.close();
      assert.deepEqual(new RunStore(directory).state, updates.state);
      return { decisions: 250, replayMatches: true };
    });
    await measure('repair-8-alternatives', repetition, async () => {
      const c = config(); c.strategy = { name: 'best-of-n', n: 8 }; c.budget.maxConcurrency = 2;
      c.backend.plans = Array.from({ length: 8 }, () => structuredClone(c.backend.plans[0]));
      const run = createRun(c, join(scratch, `repair-${repetition}`));
      try {
        const state = await runController(run);
        assert.equal(state.outcome, 'goal_met');
        assert.equal(budgetView(state).spent.attempts, 8);
        assert.equal(budgetView(state).spent.experiments, 9); assert.equal(budgetView(state).spent.tokens, 960);
        return { outcome: state.outcome, attempts: 8, experiments: budgetView(state).spent.experiments, tokens: budgetView(state).spent.tokens };
      } finally { run.close(); }
    });
    await measure('streaming-repair-500-items', repetition, async () => {
      const c = config(); c.budget.perAttempt.timeoutSeconds = 60;
      const run = createRun(c, join(scratch, `streaming-${repetition}`)); const fixture = new FixtureBackend();
      try {
        const state = await runController(run, { backend: { execute: async request => {
          for (let i = 0; i < 500; i++) request.record('muse.item', { simulated: true, revision: i, text: 'Synthetic stream output '.repeat(20) });
          return fixture.execute(request);
        } } });
        assert.equal(state.outcome, 'goal_met');
        return { outcome: state.outcome, items: 500, tokens: budgetView(state).spent.tokens };
      } finally { run.close(); }
    });
    save();
  }
} finally { save(); rmSync(scratch, { recursive: true, force: true }); }
console.log(`Results: ${join(output, 'results.json')}`);
