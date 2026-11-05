import type { TestContext } from 'node:test';
import { basename, join, resolve } from 'node:path';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import type { Config } from '../src/types.js';
import { createRun } from '../src/controller.js';

export function setup(t: TestContext, example = 'repair', modify: (config: Config, root: string) => void = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-review-'));
  const config = loadConfig(resolve(`examples/${example}.json`));
  const input = join(root, 'input'); cpSync(config.task.inputs[0]!.path, input, { recursive: true }); config.task.inputs[0]!.path = input;
  const evaluators = join(root, 'evaluators'); cpSync(resolve('examples/evaluators'), evaluators, { recursive: true });
  for (const spec of config.task.evaluators) spec.definition.path = join(evaluators, basename(spec.definition.path));
  modify(config, root);
  const store = createRun(config, join(root, 'runs'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store };
}
