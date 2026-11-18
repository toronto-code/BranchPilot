import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { readMuseSpendLedger, startMuseGateway } from '../dist/src/muse-gateway.js';
import { assertMuseCadAdmission, loadMuseCadBudget } from '../dist/src/campaign-budget.js';
import { museBenchmarkSettings } from '../dist/src/muse-environment.js';
import { prepareComparison, runComparisonArm, writeComparisonReport } from '../dist/src/comparison.js';
import { hash } from '../dist/src/store.js';
import { verifyLiveMuseEvidence } from './muse-live-evidence.mjs';
import { REVISION, selectPolyglotTasks } from './prepare-polyglot.mjs';
import { MuseBackend } from '../dist/src/muse.js';
import { withMuseProviderUsage } from '../dist/src/muse-provider-usage.js';

const { values: args } = parseArgs({ options: Object.fromEntries(['binary', 'home', 'prepared', 'evidence', 'out', 'ledger', 'budget', 'key-file'].map(k => [k, { type: 'string' }]).concat([['allow-provider-cost', { type: 'boolean' }]])) });
for (const k of ['binary', 'home', 'prepared', 'evidence', 'out', 'ledger', 'budget']) if (!args[k]) throw Error(`--${k} is required`);
if (!args['allow-provider-cost']) throw Error('Explicit --allow-provider-cost is required');
const cadBudget = loadMuseCadBudget(resolve(args.budget), resolve(args.ledger));
assertMuseCadAdmission(cadBudget, readMuseSpendLedger(resolve(args.ledger)).entries);
const binary = resolve(args.binary), home = resolve(args.home), evidence = resolve(args.evidence), out = resolve(args.out);
if (existsSync(out)) throw Error('Use a fresh output directory; started jobs are never replayed');
const manifestFile = join(resolve(args.prepared), 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (!manifest.validated || !manifest.sandboxPreflight?.passed || manifest.revision !== REVISION || !manifest.seed) throw Error('Prepare and validate a frozen Polyglot suite first');
const selection = selectPolyglotTasks(manifest.pool, { seed: manifest.seed, count: manifest.cases.length, excluded: manifest.excluded });
if (JSON.stringify(selection) !== JSON.stringify(manifest.selected) || JSON.stringify(selection) !== JSON.stringify(manifest.cases.map(c => c.id))) throw Error('Case selection changed');
const codeFiles = ['muse-public-benchmark.mjs', 'muse-live-evidence.mjs', 'prepare-polyglot.mjs', 'polyglot-grader.mjs'];
const codeDigests = Object.fromEntries(codeFiles.map(p => [p, hash(readFileSync(new URL(p, import.meta.url)))]));
for (const task of manifest.cases) for (const [path, digest] of Object.entries(task.assetDigests ?? {})) if (hash(readFileSync(join(task.assets, path))) !== digest) throw Error(`Prepared asset changed: ${task.id}/${path}`);
if (manifest.cases.some(t => !Object.keys(t.assetDigests ?? {}).length)) throw Error('Missing frozen asset digests');
const plan = verifyLiveMuseEvidence({ evidence, binary, home });
const key = args['key-file'] ? readFileSync(resolve(args['key-file']), 'utf8').trim() : process.env.META_API_KEY;
if (!key) throw Error('Supply META_API_KEY or --key-file');
const settingsFile = join(home, '.config/muse/settings.json'); const priorSettings = existsSync(settingsFile) ? readFileSync(settingsFile) : undefined;
const priorKey = process.env.META_API_KEY;
const preparationDigest = hash(readFileSync(manifestFile));
mkdirSync(out);
const controller = new AbortController(); const stop = () => controller.abort(Error('Benchmark interrupted by process signal'));
const gateway = await startMuseGateway({ key, ledgerFile: resolve(args.ledger), limitUsd: readMuseSpendLedger(resolve(args.ledger)).limitUsd, cadBudget, recoverResponses: true, signal: controller.signal,
  onUnknown: id => controller.abort(Error(`Provider request ${id} has unknown billing; campaign stopped`)) });
const beforeCampaign = gateway.ledger.snapshot();
const backend = withMuseProviderUsage(new MuseBackend(), gateway);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
let awake; let closing = false;
const accounting = { beforeCampaign, cadBudget, arms: {}, preparation: manifestFile, preparationDigest, codeDigests };
const settle = async () => {
  const end = Date.now() + 185000;
  while (gateway.ledger.blockingUnsettled().length > 0) {
    if (gateway.ledger.blockingUnsettled().some(e => e.state === 'unknown') || Date.now() > end) throw Error('Unsettled billing stops the campaign');
    await delay(100);
  }
};
try {
  if (gateway.ledger.blockingUnsettled().length > 0) throw Error('Unsettled billing blocks campaign startup');
  if (process.platform === 'darwin') {
    // Prevent idle sleep while this process lives. Forced/lid sleep can still
    // occur; absolute deadlines invalidate and stop the arm after resume.
    awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { awake.once('spawn', resolve); awake.once('error', reject); });
    awake.once('exit', () => { if (!closing) controller.abort(Error('Benchmark sleep inhibitor exited')); });
  }
  const catalog = await fetch(gateway.url + '/muse-code/models', { headers: { authorization: `Bearer ${gateway.token}` } }); await catalog.arrayBuffer();
  if (!gateway.catalogReady()) throw Error('Provider prices/limits were not verified');
  writeFileSync(settingsFile, JSON.stringify(museBenchmarkSettings(gateway.url))); process.env.META_API_KEY = gateway.token;
  const lockFile = join(out, 'compatibility.json');
  writeFileSync(lockFile, JSON.stringify({ sdkVersion: plan.sdk.version, binaryVersion: plan.spec.binaryVersion, binaryDigest: plan.binaryDigest,
    schemaFingerprint: plan.spec.schemaFingerprint, verifiedAt: new Date().toISOString(), runtimeHome: home,
    permissionProfile: ':ask-me', approvalMode: 'promptUnmatched', shellCommands: ['pwd', 'ls', 'ls -la', 'pwd; ls -la', 'node test.mjs'], isolationAuthority: 'branchpilot-sandbox-exec',
    isolateSessionHomes: true, runtimeSettingsDigest: hash(readFileSync(settingsFile)), isolationVerified: true, untrackedWorkersDisabled: true, usageIncludesAllWork: true,
    questionContinuationVerified: false, hostReconciliationVerified: false, concurrentIsolationVerified: false }, null, 2));
  mkdirSync(join(out, 'configs')); const cases = [];
  for (const task of manifest.cases) {
    const config = JSON.parse(readFileSync(new URL('../examples/muse.template.json', import.meta.url), 'utf8'));
    config.task.key = task.id; config.task.goal = task.goal; config.task.inputs = [{ path: task.input }]; config.task.objectives = [];
    config.task.baseline = { mode: 'initial_artifacts', description: `Original Aider/Exercism ${task.id} starter at ${REVISION}` };
    config.task.evaluators = ['development', 'held_out'].map(split => ({ id: split, kind: 'executable', split, role: 'correctness', definition: { path: join(task.assets, `${split}.json`) }, timeoutSeconds: 20 }));
    config.task.constraints = ['development', 'held_out'].map(id => ({ id, kind: 'check', evaluatorId: id, check: 'correct' }));
    config.backend = { kind: 'muse', binary, compatibilityLock: lockFile, apiKeyEnv: 'META_API_KEY' };
    config.agent = { model: { kind: 'explicit', providerId: 'meta', modelId: 'muse-wonder-1.0' }, effort: { kind: 'explicit', value: 'max' } };
    config.budget.total = { tokens: 360000, attempts: 3, experiments: 8, workSeconds: 240 };
    config.budget.wallSeconds = 240;
    config.budget.finalizationReserve = { tokens: 0, attempts: 0, experiments: 2, workSeconds: 40 };
    config.budget.cancellationGraceSeconds = 3;
    const file = join(out, 'configs', task.id + '.json'); writeFileSync(file, JSON.stringify(config, null, 2)); cases.push({ id: task.id, config: file });
  }
  const spec = { schemaVersion: 1, dataset: `aider-polyglot-javascript-${cases.length}`, datasetRevision: `${REVISION}:${manifest.seed}`, armSeconds: 3600, taskSeconds: 240, taskTokens: 360000, searchAttempts: 3, candidatePrompt: 'code-verification', cases };
  const specFile = join(out, 'suite.json'); writeFileSync(specFile, JSON.stringify(spec, null, 2));
  const comparison = join(out, 'comparison'); prepareComparison(specFile, comparison);
  writeFileSync(join(out, 'accounting.json'), JSON.stringify(accounting, null, 2));
  for (const arm of ['default', 'new']) {
    controller.signal.throwIfAborted();
    for (const [p, digest] of Object.entries(codeDigests)) if (hash(readFileSync(new URL(p, import.meta.url))) !== digest) throw Error('Benchmark adapter changed during the comparison');
    const firstEntry = gateway.ledger.snapshot().entries.length;
    console.log(`Starting ${arm}: ${cases.length} frozen Aider Polyglot JavaScript tasks; Wonder max; one-hour ceiling.`);
    await runComparisonArm(comparison, arm, { signal: controller.signal, allowLive: true, allowProviderCost: true, backend });
    await settle();
    const report = writeComparisonReport(comparison); const job = JSON.parse(readFileSync(join(comparison, arm, 'job.json'), 'utf8'));
    const entries = gateway.ledger.snapshot().entries.slice(firstEntry);
    const billing = { firstEntry: firstEntry + 1, requests: entries.length, conservativeUsd: entries.reduce((n, e) => n + e.chargedUsd, 0), inputTokens: entries.reduce((n, e) => n + e.inputTokens, 0), outputTokens: entries.reduce((n, e) => n + e.outputTokens, 0) };
    accounting.arms[arm] = billing; writeFileSync(join(out, 'accounting.json'), JSON.stringify(accounting, null, 2));
    console.log(JSON.stringify({ arm, outcomes: report.outcomes, totals: report.totals, billing, reasons: report.qualityReasons }));
    if (job.trials.some(t => t.error)) throw Error(`${arm} had an execution failure; preserve evidence before any further paid work`);
    const tokens = report.totals[arm === 'default' ? 'baseline' : 'candidate'].tokens;
    if (tokens !== billing.inputTokens + billing.outputTokens) throw Error('Host and provider usage differ; no further paid work');
  }
} finally {
  try { await gateway.close(); }
  finally {
    try { writeFileSync(join(out, 'gateway.json'), JSON.stringify({ events: gateway.events, ledger: gateway.ledger.snapshot() }, null, 2)); }
    finally {
      try { if (priorSettings) writeFileSync(settingsFile, priorSettings); else if (existsSync(settingsFile)) unlinkSync(settingsFile); }
      finally {
        if (priorKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = priorKey;
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        closing = true; awake?.kill();
      }
    }
  }
}
