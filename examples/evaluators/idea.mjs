import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const text = readFileSync(join(process.argv[2], 'proposal.md'), 'utf8');
const required = ['Assumption', 'Prediction', 'Experiment'];
const checks = required.map(id => ({ id, outcome: text.includes(id) ? 'pass' : 'fail' }));
console.log(JSON.stringify({ validity: checks.every(c => c.outcome === 'pass') ? 'pass' : 'fail', checks, feedback: 'This checks only whether a proposal states an assumption, prediction and experiment. It does not test whether the idea works.', findings: ['Scientific validity remains untested until the proposed experiment is run.'] }));
