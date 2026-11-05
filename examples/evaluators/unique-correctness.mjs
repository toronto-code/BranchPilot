import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { unique } = await import(pathToFileURL(join(process.argv[2], 'unique.mjs')).href);
const cases = [[], [2, 1, 2, 3, 1], [7, 7, 7], [-1, 0, -1, 5]];
const pass = cases.every(input => JSON.stringify(unique([...input])) === JSON.stringify([...new Set(input)]));
console.log(JSON.stringify({ validity: pass ? 'pass' : 'fail', checks: [{ id: 'stable-unique', outcome: pass ? 'pass' : 'fail' }], feedback: pass ? 'Preserves first occurrence order and removes duplicates.' : 'Incorrect deduplication or changed order.' }));
