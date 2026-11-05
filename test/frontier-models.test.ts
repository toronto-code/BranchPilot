import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema, loadConfig } from '../src/config.js';
import type { Config } from '../src/types.js';
import { resolveMuseSettings } from '../src/muse-models.js';
import type { CatalogModel } from '../src/muse-models.js';
import { executeMuseProtocol } from '../src/muse-protocol.js';
import { runController } from '../src/controller.js';
import { RunStore } from '../src/store.js';
import { budgetView } from '../src/budget.js';
import { renderReport } from '../src/report.js';
import { protocolExpectation, SimulatedMuseHost } from './muse-host.js';
import { setup } from './support.js';

const agent: Config['agent'] = {
  model: { kind: 'preference', choices: [{ displayLabel: 'Muse Wonder Full' }, { modelId: 'muse-wonder-1.0' }] },
  effort: { kind: 'highest', minimum: 'high' },
};
const row = (modelId: string, label: string, variants: CatalogModel['variants'] = ['high', 'max', 'xhigh']): CatalogModel => ({ providerId: 'synthetic-provider', modelId, displayLabel: label, variants, isActive: false, isDefault: false });
const full = row('synthetic-full-id', 'Muse Wonder Full');
const wonder = row('muse-wonder-1.0', 'Muse Wonder');
const spark = { ...row('muse-spark-1.3', 'Muse Spark'), isActive: true, isDefault: true };

test('quality preference selects the advertised Full row over the default, without guessing its ID', () => {
  const resolved = resolveMuseSettings(agent, [spark, wonder, full]);
  assert.equal(resolved.model!.modelId, 'synthetic-full-id'); assert.equal(resolved.effort, 'max'); assert.equal(resolved.setModel, true);
});
test('an allowed Wonder fallback is explicit and its reason is recorded', () => {
  const resolved = resolveMuseSettings(agent, [spark, wonder]);
  assert.equal(resolved.model!.modelId, wonder.modelId); assert.match(resolved.reason, /1 earlier choices absent/);
});
test('missing frontier models never fall back to a cheaper active model', () => {
  assert.throws(() => resolveMuseSettings(agent, [spark]), /refusing to fall back/);
  assert.throws(() => resolveMuseSettings(agent, []), /No preferred model/);
  const strict: Config['agent'] = { ...agent, model: { kind: 'preference', choices: [{ displayLabel: 'Muse Wonder Full' }] } };
  assert.throws(() => resolveMuseSettings(strict, [wonder]), /No preferred model/);
});
test('ambiguous providers and labels require an exact selector', () => {
  assert.throws(() => resolveMuseSettings(agent, [full, { ...full, providerId: 'second-provider' }]), /ambiguous/);
  const exact: Config['agent'] = { ...agent, model: { kind: 'preference', choices: [{ providerId: full.providerId, modelId: full.modelId }] } };
  assert.equal(resolveMuseSettings(exact, [full, { ...full, providerId: 'second-provider' }]).model!.providerId, full.providerId);
  assert.throws(() => resolveMuseSettings(agent, [{ ...full, displayLabel: 'Muse Wonder Full Preview' }]), /No preferred/);
});
test('highest effort uses known strengths and never assumes an unadvertised tier', () => {
  assert.equal(resolveMuseSettings(agent, [{ ...full, variants: ['xhigh', 'low', 'high'] }]).effort, 'xhigh');
  for (const variants of [undefined, 'unknown', [], ['low'], ['future-ultra']] as CatalogModel['variants'][]) {
    assert.throws(() => resolveMuseSettings(agent, [{ ...full, variants }, wonder]), /at least high/);
  }
  assert.throws(() => resolveMuseSettings({ ...agent, effort: { kind: 'highest', minimum: 'max' } }, [{ ...full, variants: ['high'] }]), /at least max/);
});
test('preference configuration validates selectors and effort policy without launching Muse', () => {
  const config = loadConfig('examples/repair.json');
  assert.deepEqual(configSchema.parse({ ...config, agent }).agent, agent);
  for (const model of [{ kind: 'preference', choices: [] }, { kind: 'preference', choices: [{}] }, { kind: 'preference', choices: [{ modelId: 'x', displayLabel: 'y' }] }]) {
    assert.throws(() => configSchema.parse({ ...config, agent: { ...agent, model } }));
  }
});
test('SDK simulation confirms frontier settings before a turn and retains them through replay and reports', async t => {
  const { store } = setup(t, 'repair', config => { config.agent = agent; });
  const host = new SimulatedMuseHost({ models: [spark, full, wonder], settingsDelayMs: 10 });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  const work = Object.values(store.state.works).find(w => w.kind === 'attempt')!;
  assert.equal(work.agentSettings!.modelId, full.modelId); assert.equal(work.agentSettings!.effort, 'max');
  const frames = host.frames.map(f => f.method);
  assert.ok(frames.lastIndexOf('session/read') < frames.indexOf('turn/start'));
  assert.match(renderReport(store), /synthetic-full-id/); assert.match(renderReport(store), /highest advertised known effort: max/);
  store.close(); rmSync(join(store.dir, 'state.json'));
  assert.deepEqual(new RunStore(store.dir).state.works[work.id]!.agentSettings, work.agentSettings);
});
test('SDK rejects unavailable frontier selection before a paid turn', async t => {
  const { store } = setup(t, 'repair', config => { config.agent = agent; });
  const host = new SimulatedMuseHost({ models: [spark] });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  assert.equal(host.frames.some(f => f.method === 'turn/start'), false); assert.equal(budgetView(store.state).spent.tokens, 0);
});
test('SDK rejects a preference whose final model readback differs', async t => {
  const { store } = setup(t, 'repair', config => { config.agent = agent; config.budget.perAttempt.timeoutSeconds = 0.3; });
  const host = new SimulatedMuseHost({ models: [full], readbackModel: 'sim-model' });
  await runController(store, { backend: { execute: request => executeMuseProtocol(request, protocolExpectation, host.factory) } });
  assert.equal(host.frames.some(f => f.method === 'turn/start'), false);
});
