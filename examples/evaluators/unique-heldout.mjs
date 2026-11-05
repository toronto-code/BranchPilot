import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { unique } = await import(pathToFileURL(join(process.argv[2], 'unique.mjs')).href);
const cases = [[99, 7, 99, 0, 7, -25], Array.from({ length: 997 }, (_, i) => (i * 31) % 53)];
const pass = cases.every(input => JSON.stringify(unique([...input])) === JSON.stringify([...new Set(input)]));
console.log(JSON.stringify({ validity: pass ? 'pass' : 'fail', checks: [{ id: 'heldout-equivalence', outcome: pass ? 'pass' : 'fail' }], feedback: 'Final assessment on different synthetic inputs.' }));
