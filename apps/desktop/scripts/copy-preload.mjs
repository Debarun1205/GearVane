/**
 * Copy static assets into dist/.
 *
 * `tsc` compiles TypeScript and copies nothing else. Two files need to
 * travel with main.js: the preload bridge (plain CommonJS that Electron
 * must load from beside main.js) and the model catalog (imported as JSON,
 * which `tsc` types but never emits). Without the preload, the host
 * bridge is never injected and the IDE, terminal, builder, and agent all
 * silently degrade to chat-only - which is exactly how v0.3.0 shipped.
 * Without the catalog, the Models dialog has nothing to list.
 *
 * Kept as a file rather than inline `node -e` so it is readable,
 * cross-platform, and pinned by a test.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

const COPIES = [
  ['src/preload.cjs', 'dist/preload.cjs'],
  ['src/models.json', 'dist/models.json'],
];

for (const [from, to] of COPIES) {
  const source = join(appRoot, from);
  const target = join(appRoot, to);
  if (!existsSync(source)) {
    console.error(`copy-assets: missing source ${source}`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`copy-assets: ${from} -> ${to}`);
}
