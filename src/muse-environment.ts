import { join } from 'node:path';

/** Explicit child environment: ambient XDG paths and unrelated secrets never leak in. */
export function museEnvironment(runtimeHome: string, scratch: string, apiKeyEnv?: 'META_API_KEY', source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: source.PATH, HOME: runtimeHome, XDG_CONFIG_HOME: join(runtimeHome, '.config'), XDG_DATA_HOME: join(runtimeHome, '.local', 'share'), TMPDIR: scratch };
  if (apiKeyEnv) {
    if (!source[apiKeyEnv]?.trim()) throw Error('META_API_KEY is required by this Muse configuration; its value is never stored in the run config');
    env.META_API_KEY = source[apiKeyEnv];
  }
  return env;
}
