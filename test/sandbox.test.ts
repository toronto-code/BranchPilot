import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, sandboxCommand } from '../src/process.js';

test('macOS isolation profile compiles, permits workspace edits, and denies outside access', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'branchpilot-isolation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); mkdirSync(workspace); const canary = join(root, 'private.txt'); writeFileSync(canary, 'private');
  const script = `const fs=require('node:fs');fs.writeFileSync('allowed.txt','ok');const r={};for(const [name,fn] of [['read',()=>fs.readFileSync(${JSON.stringify(canary)})],['write',()=>fs.writeFileSync(${JSON.stringify(join(root, 'forbidden.txt'))},'bad')]]){try{fn();r[name]='allowed'}catch(e){r[name]=e.code}}console.log(JSON.stringify(r));`;
  const [command, args] = sandboxCommand(process.execPath, ['-e', script], [workspace], [workspace]);
  const result = await runProcess(command, args, { cwd: workspace, timeoutMs: 5000, graceMs: 200, env: { PATH: process.env.PATH, HOME: workspace, TMPDIR: workspace } });
  assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.stopped, true);
  assert.equal(readFileSync(join(workspace, 'allowed.txt'), 'utf8'), 'ok');
  const observed = JSON.parse(result.stdout); assert.match(observed.read, /EPERM|EACCES/); assert.match(observed.write, /EPERM|EACCES/);
  assert.equal(existsSync(join(root, 'forbidden.txt')), false);
});
