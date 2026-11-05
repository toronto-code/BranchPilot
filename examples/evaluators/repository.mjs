import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = process.env.BRANCHPILOT_BUILD_DIRECTORY;
if (!directory) throw Error('Missing disposable build directory');
const { add } = await import(pathToFileURL(join(directory, 'dist/calculator.mjs')).href);
const pass = [[2, 3], [-1, 4], [0, 0], [1.5, 0.25]].every(([a, b]) => add(a, b) === a + b);
if (existsSync(join(directory, 'UNEXPECTED_INSTALL_SCRIPT'))) throw Error('Dependency install ran a lifecycle script');
console.log(JSON.stringify({ validity: pass ? 'pass' : 'fail', checks: [{ id: 'addition', outcome: pass ? 'pass' : 'fail' }], feedback: 'Installed a frozen local dependency offline, built a disposable copy, and tested the compiled export.' }));
