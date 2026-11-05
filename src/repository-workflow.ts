import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import { hash } from './store.js';

const relativePath = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Expected a safe repository-relative path');
export const workflowSchema = z.object({
  install: z.literal('npm-ci-offline').optional(),
  build: z.array(z.object({ script: relativePath, args: z.array(z.string()).max(100).default([]) }).strict()).max(20).default([]),
}).strict();
export const executableDefinitionSchema = z.object({
  schemaVersion: z.literal(1), script: z.string().min(1), files: z.array(z.string()).default([]), seed: z.number().int().safe().default(1), workflow: workflowSchema.optional(),
}).strict();
export type RepositoryWorkflow = z.infer<typeof workflowSchema>;

export function npmTool(): { path: string; digest: string; version: string; packageDigest: string } {
  const executable = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm')).find(path => existsSync(path));
  if (!executable || process.platform === 'win32') throw Error('Offline npm setup requires an installed npm CLI on macOS or Linux');
  const path = realpathSync(executable);
  // Run npm's JavaScript entry point with the same Node runtime, without a shell.
  if (!readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node')) throw Error('npm must resolve to its Node.js CLI entry point');
  const manifest = readFileSync(join(dirname(dirname(path)), 'package.json'));
  const pkg = z.object({ name: z.literal('npm'), version: z.string().min(1) }).passthrough().parse(JSON.parse(manifest.toString('utf8')));
  return { path, digest: hash(readFileSync(path)), version: pkg.version, packageDigest: hash(manifest) };
}
