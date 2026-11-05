import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Snapshot } from './types.js';
import { RunStore } from './store.js';

const excluded = new Set(['.git', '.branchpilot', '.branchpilot-tmp', 'node_modules', '.env', '.aws', '.codex', '.agents']);
/** Bound reads even if a file changes after stat; never block on a FIFO or follow a final symlink. */
export function readRegularText(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw Error(`Expected a regular file of at most ${limit} bytes`);
    const chunks: Buffer[] = []; let bytes = 0;
    while (bytes <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - bytes));
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) return Buffer.concat(chunks).toString('utf8');
      bytes += length; chunks.push(chunk.subarray(0, length));
    }
    throw Error(`File exceeds ${limit} bytes`);
  } finally { closeSync(fd); }
}
export function rejectEvaluatorInsideInput(input: string, file: string): void {
  const rel = relative(realpathSync(input), realpathSync(file));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw Error('Trusted evaluator definitions and assets must be outside the input directory');
}
export function contained(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => p === '..' || p === '' || p === '.')) throw Error(`Unsafe relative path: ${path}`);
  const full = resolve(root, path); const rel = relative(root, full);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw Error(`Path escapes workspace: ${path}`);
  let cursor = root;
  for (const part of path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error(`Symlink prohibited: ${cursor}`); }
  return full;
}
export function capture(store: RunStore, root: string): string {
  const files: Snapshot['files'] = []; let size = 0;
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir).sort()) {
      if (excluded.has(name) || name.startsWith('.env.')) continue;
      const path = prefix ? `${prefix}/${name}` : name; const full = join(dir, name); const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw Error(`Snapshots reject symlinks: ${path}`);
      if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) {
        size += stat.size;
        if (size > 64 * 1024 * 1024 || files.length >= 10000) throw Error('Snapshot exceeds 64 MiB / 10,000 file limit');
        files.push({ path, blob: store.put(readFileSync(full)), executable: Boolean(stat.mode & 0o111) });
      } else throw Error(`Unsupported file type: ${path}`);
    }
  }
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('Input must be a real directory');
  walk(root, ''); return store.putJSON({ files } satisfies Snapshot);
}
export function materialize(store: RunStore, digest: string, root: string): void {
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('Materialization target cannot be a symlink');
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length !== 0) throw Error(`Materialization target must be empty: ${root}`);
  const snapshot = store.getJSON<Snapshot>(digest); const seen = new Set<string>();
  for (const file of snapshot.files) {
    if (seen.has(file.path)) throw Error('Duplicate snapshot path'); seen.add(file.path);
    const path = contained(root, file.path);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, store.get(file.blob), { flag: 'wx' }); chmodSync(path, file.executable ? 0o700 : 0o600);
  }
}
export function rejectNestedStorage(input: string, output: string): void {
  const root = realpathSync(input);
  // Resolve an existing ancestor so /var aliases and symlinked parents cannot
  // disguise storage inside the source tree before the run directory exists.
  let ancestor = resolve(output);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const resolvedOutput = resolve(realpathSync(ancestor), relative(ancestor, resolve(output)));
  const rel = relative(root, resolvedOutput);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw Error('Run storage must be outside the input directory');
}
