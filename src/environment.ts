import { arch, cpus, platform, release } from 'node:os';
import type { Config } from './types.js';

/** Keep the same identity for creation and every subsequent executable dispatch. */
export function executionEnvironment(config: Config) {
  return { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, seed: 1, execution: config.execution };
}
