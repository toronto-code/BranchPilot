import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
copyFileSync('src/calculator.mjs', 'dist/calculator.mjs');
