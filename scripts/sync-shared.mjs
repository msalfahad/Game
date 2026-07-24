// Copies the single-source shared game logic (src/shared/*.ts) into the server
// tree (server/src/shared/*.ts) so the standalone server build compiles the
// SAME files the client does. Run before the server build (see render.yaml and
// package.json "sync:shared"). The server copies are generated — never edit
// them by hand; edit src/shared/ instead.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src', 'shared');
const outDir = join(root, 'server', 'src', 'shared');

const HEADER =
  '// ===========================================================================\n' +
  '// GENERATED FILE — DO NOT EDIT. Source of truth: src/shared/<name>.ts\n' +
  '// Regenerate with `npm run sync:shared`. Edits here are overwritten at build.\n' +
  '// ===========================================================================\n\n';

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let n = 0;
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith('.ts')) continue;
  const body = readFileSync(join(srcDir, name), 'utf8');
  writeFileSync(join(outDir, name), HEADER + body);
  n++;
}
console.log(`sync-shared: copied ${n} file(s) from src/shared -> server/src/shared`);
