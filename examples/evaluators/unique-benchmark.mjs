import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { unique } = await import(pathToFileURL(join(process.argv[2], 'unique.mjs')).href);
let reads = 0;
const input = Array.from({ length: 500 }, (_, i) => i % 127);
const observed = new Proxy(input, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
const output = unique(observed);
if (JSON.stringify(output) !== JSON.stringify([...new Set(input)])) throw Error('Benchmark output is wrong');
console.log(JSON.stringify({ validity: 'pass', metrics: [{ name: 'input_reads', unit: 'reads', value: reads }], feedback: 'Actual indexed input reads counted on a fixed 500-element synthetic workload; this is not a wall-time benchmark.' }));
