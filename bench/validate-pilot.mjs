import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluatorSource } from './pilot-tasks.mjs';
const folder = mkdtempSync(join(tmpdir(), 'branchpilot-graders-'));
try {
  for (const module of ['./pilot-tasks.mjs', './confirmation-tasks.mjs']) {
    const { pilotTasks } = await import(module);
    for (const task of pilotTasks) for (const split of ['development', 'heldOut']) for (const implementation of ['stub', 'reference']) {
      writeFileSync(join(folder, 'index.mjs'), task[implementation]);
      writeFileSync(join(folder, 'grader.mjs'), evaluatorSource(task[split]));
      const result = spawnSync(process.execPath, [join(folder, 'grader.mjs'), folder], { encoding: 'utf8', timeout: 3000 });
      const expected = implementation === 'reference' ? 'pass' : 'fail';
      if (result.status !== 0 || JSON.parse(result.stdout).validity !== expected) throw Error(`${task.id}/${split}/${implementation}: ${result.stdout} ${result.stderr}`);
    }
    console.log(`${module}: all starting implementations fail, all independent references pass both graders.`);
  }
} finally { rmSync(folder, { recursive: true, force: true }); }
