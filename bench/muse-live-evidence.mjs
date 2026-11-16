import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { installedMuseSDK } from '../dist/src/muse.js';
import { hash } from '../dist/src/store.js';
import { museBenchmarkSettings } from '../dist/src/muse-environment.js';

/** The same live evidence gate used by the initial installation pilot. */
export function verifyLiveMuseEvidence({ evidence, binary, home }) {
  const envelope = JSON.parse(readFileSync(join(evidence, 'plan.json'), 'utf8'));
  if (envelope.digest !== hash(JSON.stringify(envelope.plan))) throw Error('Smoke plan hash mismatch');
  const plan = envelope.plan;
  const completion = JSON.parse(readFileSync(join(evidence, 'completion/result.json'), 'utf8'));
  const isolation = JSON.parse(readFileSync(join(evidence, 'isolation/result.json'), 'utf8'));
  if (isolation.mode !== 'live' || isolation.result?.code !== 0 || !['EPERM', 'EACCES'].includes(isolation.observation?.read) || !['EPERM', 'EACCES'].includes(isolation.observation?.write)) throw Error('A real isolation probe is required');
  if (plan.binaryDigest !== hash(readFileSync(binary)) || JSON.stringify(plan.sdk) !== JSON.stringify(installedMuseSDK())) throw Error('Evidence belongs to a different runtime pair');
  if (completion.mode !== 'live' || !completion.facts.expectedEditObserved || !completion.facts.terminalAndHostStopObserved || !completion.facts.settingsReadbackAccepted || !(completion.facts.reportedTokens > 0)) throw Error('A successful live completion probe is required');
  const events = readdirSync(join(evidence, 'completion')).filter(f => /^event-\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(evidence, 'completion', f), 'utf8')));
  if (events.some(e => e.kind === 'muse.untracked_work')) throw Error('Evidence contains untracked work');
  const initialized = events.find(e => e.kind === 'muse.initialized')?.data;
  if (initialized?.serverInfo.version !== plan.spec.binaryVersion || initialized?.schema.fingerprint !== plan.spec.schemaFingerprint) throw Error('Runtime handshake differs from smoke plan');
  const sessionId = events.find(e => e.kind === 'muse.session')?.data.sessionId;
  if (!/^[a-f0-9-]+$/.test(sessionId ?? '')) throw Error('Missing observed session identity');
  const root = join(home, '.local/share/muse/sessions');
  const log = readdirSync(root, { recursive: true }).find(p => typeof p === 'string' && p.endsWith(`/${sessionId}/session.jsonl`));
  if (!log) throw Error('Missing native runtime configuration evidence');
  const configured = readFileSync(join(root, log), 'utf8').trim().split('\n').map(line => JSON.parse(line)?.payload?.event).filter(e => e?.kind === 'model_request_configured');
  const tools = museBenchmarkSettings('http://127.0.0.1:1').run.toolset;
  if (!configured.length || configured.some(e => e.reminder_roster != null || e.delegation_posture?.state !== 'inactive' || JSON.stringify(e.toolset?.active_tools) !== JSON.stringify(tools))) throw Error('Native tool/worker settings differ');
  return plan;
}
