import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startMuseGateway } from '../dist/src/muse-gateway.js';
import { museBenchmarkSettings } from '../dist/src/muse-environment.js';
import { prepareComparison, runComparisonArm, writeComparisonReport } from '../dist/src/comparison.js';
import { installedMuseSDK } from '../dist/src/muse.js';
import { hash } from '../dist/src/store.js';
import { evaluatorSource } from './pilot-tasks.mjs';

const { values: args } = parseArgs({ options: { binary: { type: 'string' }, home: { type: 'string' }, out: { type: 'string' }, ledger: { type: 'string' }, evidence: { type: 'string' }, 'key-file': { type: 'string' }, 'allow-provider-cost': { type: 'boolean' }, suite: { type: 'string', default: 'original' } } });
if (!['original', 'confirmation'].includes(args.suite)) throw Error('--suite must be original or confirmation');
const taskModule = new URL(args.suite === 'confirmation' ? './confirmation-tasks.mjs' : './pilot-tasks.mjs', import.meta.url);
const { pilotTasks } = await import(taskModule.href);
for (const key of ['binary', 'home', 'out', 'ledger', 'evidence']) if (!args[key]) throw Error(`--${key} is required`);
if (!args['allow-provider-cost']) throw Error('Live pilot requires --allow-provider-cost');
const binary = resolve(args.binary), home = resolve(args.home), out = resolve(args.out), evidence = resolve(args.evidence);
const key = args['key-file'] ? readFileSync(resolve(args['key-file']), 'utf8').trim() : process.env.META_API_KEY;
if (!key) throw Error('Supply META_API_KEY or --key-file');
if (existsSync(out)) throw Error('Use a fresh output directory; started comparisons are never replayed');

// Require actual edit/usage/stop evidence, not a manually flipped lock template.
const envelope = JSON.parse(readFileSync(join(evidence, 'plan.json'), 'utf8'));
if (envelope.digest !== hash(JSON.stringify(envelope.plan))) throw Error('Smoke evidence plan hash mismatch');
const plan = envelope.plan;
const completion = JSON.parse(readFileSync(join(evidence, 'completion/result.json'), 'utf8'));
const isolation = JSON.parse(readFileSync(join(evidence, 'isolation/result.json'), 'utf8'));
if (isolation.mode !== 'live' || isolation.result?.code !== 0 || !['EPERM', 'EACCES'].includes(isolation.observation?.read) || !['EPERM', 'EACCES'].includes(isolation.observation?.write)) throw Error('A real outside-file isolation probe is required');
if (plan.binaryDigest !== hash(readFileSync(binary)) || JSON.stringify(plan.sdk) !== JSON.stringify(installedMuseSDK())) throw Error('Smoke evidence belongs to a different runtime pair');
if (completion.mode !== 'live' || !completion.facts.expectedEditObserved || !completion.facts.terminalAndHostStopObserved || !completion.facts.settingsReadbackAccepted || !(completion.facts.reportedTokens > 0)) throw Error('A successful live completion probe is required');
const smokeEvents = readdirSync(join(evidence, 'completion')).filter(f => /^event-\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(evidence, 'completion', f), 'utf8')));
if (smokeEvents.some(e => e.kind === 'muse.untracked_work')) throw Error('Smoke evidence contains untracked work');
const initialized = smokeEvents.find(e => e.kind === 'muse.initialized')?.data;
if (initialized?.serverInfo.version !== plan.spec.binaryVersion || initialized?.schema.fingerprint !== plan.spec.schemaFingerprint) throw Error('Observed runtime handshake differs from smoke plan');
const sessionId = smokeEvents.find(e => e.kind === 'muse.session')?.data.sessionId;
if (!/^[a-f0-9-]+$/.test(sessionId ?? '')) throw Error('Missing observed smoke session identity');
const sessionRoot = join(home, '.local/share/muse/sessions');
const sessionLog = readdirSync(sessionRoot, { recursive: true }).find(p => typeof p === 'string' && p.endsWith(`/${sessionId}/session.jsonl`));
if (!sessionLog) throw Error('Missing native runtime configuration evidence');
const configured = readFileSync(join(sessionRoot, sessionLog), 'utf8').trim().split('\n').map(line => JSON.parse(line)?.payload?.event).filter(e => e?.kind === 'model_request_configured');
const expectedTools = museBenchmarkSettings('http://127.0.0.1:1').run.toolset;
if (!configured.length || configured.some(e => e.reminder_roster != null || e.delegation_posture?.state !== 'inactive' || JSON.stringify(e.toolset?.active_tools) !== JSON.stringify(expectedTools))) throw Error('Observed native tool/worker configuration differs from the benchmark profile');

mkdirSync(out);
const gateway = await startMuseGateway({ key, ledgerFile: resolve(args.ledger), limitUsd: 40 });
const settingsFile = join(home, '.config/muse/settings.json'); mkdirSync(join(home, '.config/muse'), { recursive: true });
const oldSettings = existsSync(settingsFile) ? readFileSync(settingsFile) : undefined;
const oldKey = process.env.META_API_KEY;
const controller = new AbortController(); const stop = () => controller.abort(Error('Pilot interrupted'));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const catalog = await fetch(gateway.url + '/muse-code/models', { headers: { authorization: `Bearer ${gateway.token}` } }); await catalog.arrayBuffer();
  if (!gateway.catalogReady()) throw Error('Current provider prices/limits have not been verified');
  writeFileSync(settingsFile, JSON.stringify(museBenchmarkSettings(gateway.url)));
  process.env.META_API_KEY = gateway.token;
  const lockFile = join(out, 'compatibility.json');
  writeFileSync(lockFile, JSON.stringify({ sdkVersion: plan.sdk.version, binaryVersion: plan.spec.binaryVersion, binaryDigest: plan.binaryDigest,
    schemaFingerprint: plan.spec.schemaFingerprint, verifiedAt: new Date().toISOString(), runtimeHome: home,
    permissionProfile: ':ask-me', approvalMode: 'promptUnmatched', shellCommands: ['pwd', 'ls', 'ls -la', 'pwd; ls -la', 'node test.mjs'], isolationAuthority: 'branchpilot-sandbox-exec',
    isolateSessionHomes: true, runtimeSettingsDigest: hash(readFileSync(settingsFile)),
    isolationVerified: true, untrackedWorkersDisabled: true, usageIncludesAllWork: true,
    questionContinuationVerified: false, hostReconciliationVerified: false, concurrentIsolationVerified: false }, null, 2));
  const template = JSON.parse(readFileSync(new URL('../examples/muse.template.json', import.meta.url), 'utf8'));
  const cases = [];
  const evaluations = join(out, 'evaluators'); mkdirSync(evaluations);
  for (const task of pilotTasks) {
    const folder = join(out, 'tasks', task.id); const input = join(folder, 'input'); mkdirSync(input, { recursive: true });
    writeFileSync(join(input, 'index.mjs'), task.stub);
    writeFileSync(join(input, 'README.md'), task.goal + '\n\nRun the visible checks with `node test.mjs`. Hidden checks cover the same stated contract. Shell commands allowed here: pwd, ls, ls -la, pwd; ls -la, node test.mjs. Use read_file/search and write_file/edit_file for file operations.\n');
    writeFileSync(join(input, 'test.mjs'), `import assert from 'node:assert/strict';import * as m from './index.mjs';${task.development}\nconsole.log('Development tests passed');\n`);
    const config = structuredClone(template); config.task.key = task.id; config.task.goal = task.goal;
    config.task.inputs = [{ path: input }]; config.task.objectives = [];
    config.task.baseline = { mode: 'initial_artifacts', description: 'Fixed incomplete implementation' };
    config.task.evaluators = ['development', 'held_out'].map(split => {
      const name = `${task.id}-${split}`;
      writeFileSync(join(evaluations, `${name}.mjs`), evaluatorSource(task[split === 'development' ? 'development' : 'heldOut']));
      writeFileSync(join(evaluations, `${name}.json`), JSON.stringify({ schemaVersion: 1, script: `${name}.mjs` }));
      return { id: split, kind: 'executable', split, role: 'correctness', definition: { path: join(evaluations, `${name}.json`) }, timeoutSeconds: 3 };
    });
    config.task.constraints = ['development', 'held_out'].map(id => ({ id, kind: 'check', evaluatorId: id, check: 'correct' }));
    config.backend = { kind: 'muse', binary, compatibilityLock: lockFile, apiKeyEnv: 'META_API_KEY' };
    config.agent = { model: { kind: 'explicit', providerId: 'meta', modelId: 'muse-wonder-1.0' }, effort: { kind: 'explicit', value: 'max' } };
    config.budget.total = { tokens: 360000, attempts: 3, experiments: 10, workSeconds: 240 };
    config.budget.wallSeconds = 240; config.budget.maxConcurrency = 1;
    config.budget.perAttempt = { tokenReservation: 120000, timeoutSeconds: 65 };
    config.budget.finalizationReserve = { tokens: 0, attempts: 0, experiments: 2, workSeconds: 6 };
    config.budget.cancellationGraceSeconds = 3;
    const configFile = join(folder, 'config.json'); writeFileSync(configFile, JSON.stringify(config, null, 2));
    cases.push({ id: task.id, config: configFile });
  }
  const spec = { schemaVersion: 1, dataset: `branchpilot-${args.suite}-coding-pilot`, datasetRevision: hash(readFileSync(taskModule)), armSeconds: 3600, taskSeconds: 240, taskTokens: 360000, searchAttempts: 3, cases };
  const specFile = join(out, 'suite.json'); writeFileSync(specFile, JSON.stringify(spec, null, 2));
  const comparison = join(out, 'comparison'); prepareComparison(specFile, comparison);
  for (const arm of ['default', 'new']) {
    controller.signal.throwIfAborted(); console.log(`Starting ${arm}: four frozen tasks, Muse Wonder max, one-hour ceiling.`);
    await runComparisonArm(comparison, arm, { signal: controller.signal, allowLive: true, allowProviderCost: true });
    const report = writeComparisonReport(comparison);
    console.log(JSON.stringify({ arm, outcomes: report.outcomes, totals: report.totals, reasons: report.qualityReasons }));
    if (gateway.ledger.snapshot().entries.some(e => e.state !== 'settled')) throw Error('Unsettled provider request; stopping the campaign');
    const job = JSON.parse(readFileSync(join(comparison, arm, 'job.json'), 'utf8'));
    if (job.trials.some(trial => trial.error)) throw Error(`${arm} encountered an execution failure; inspect the saved evidence before spending on another version`);
  }
} finally {
  await gateway.close();
  writeFileSync(join(out, 'gateway.json'), JSON.stringify({ events: gateway.events, ledger: gateway.ledger.snapshot() }, null, 2));
  if (oldSettings) writeFileSync(settingsFile, oldSettings); else if (existsSync(settingsFile)) unlinkSync(settingsFile);
  if (oldKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = oldKey;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
