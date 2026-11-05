import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { add } = await import(pathToFileURL(join(process.argv[2], 'calculator.mjs')).href);
const cases = [[2, 3, 5], [-4, 7, 3], [0, 0, 0], [1.25, 0.5, 1.75]];
const failed = cases.filter(([a, b, expected]) => add(a, b) !== expected);
console.log(JSON.stringify({
  validity: failed.length ? 'fail' : 'pass',
  checks: [{ id: 'addition', outcome: failed.length ? 'fail' : 'pass' }],
  feedback: failed.length ? `Addition failed ${failed.length}/${cases.length} cases: ${JSON.stringify(failed)}` : 'All addition cases passed.',
  findings: failed.length ? ['The current implementation does not satisfy addition semantics.'] : [],
}));
