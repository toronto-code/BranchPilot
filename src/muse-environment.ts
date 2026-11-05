import { join } from 'node:path';

/** macOS cannot nest Seatbelt. Only callers that actually wrap the entire host
 * in BranchPilot's OS profile may select the outer authority. Approvals remain
 * enabled in Muse; this flag changes only its redundant inner OS boundary. */
export function museLaunchArguments(authority: 'muse' | 'branchpilot-sandbox-exec' = 'muse'): string[] {
  return ['serve', '--contributor-mode', 'off', ...(authority === 'branchpilot-sandbox-exec' ? ['--disable-sandbox'] : [])];
}

/** Verified against Muse 1.4.14's effective toolset and reminder roster. */
export function museBenchmarkSettings(gatewayUrl: string) {
  const endpoint = new URL(gatewayUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw Error('Benchmark gateway must be a plain loopback endpoint');
  return { schema_version: 1, endpoint_transport: { base_url: gatewayUrl, auth: 'bearer' },
    agents: { execution_capacity: 1 }, run: { toolset: ['read_file', 'search', 'write_file', 'edit_file', 'bash', 'bash_input'] },
    runtime_capabilities: Object.fromEntries(['memory-reminder', 'skill-reminder', 'todo-reminder', 'goal-reminder', 'verify-reminder', 'scope-reminder'].flatMap(id => [
      [`plugin:tbh-reminders:reminder:${id}`, { enabled: false }], [`plugin:${id}:reminder:${id}`, { enabled: false }],
    ])),
  };
}

/** Explicit child environment: ambient XDG paths and unrelated secrets never leak in. */
export function museEnvironment(runtimeHome: string, scratch: string, apiKeyEnv?: 'META_API_KEY', source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: source.PATH, HOME: runtimeHome, XDG_CONFIG_HOME: join(runtimeHome, '.config'), XDG_DATA_HOME: join(runtimeHome, '.local', 'share'), TMPDIR: scratch };
  if (apiKeyEnv) {
    if (!source[apiKeyEnv]?.trim()) throw Error('META_API_KEY is required by this Muse configuration; its value is never stored in the run config');
    env.META_API_KEY = source[apiKeyEnv];
  }
  return env;
}
