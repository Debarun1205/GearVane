/**
 * Copy the preload bridge into dist/.
 *
 * `tsc` compiles TypeScript and copies nothing else, and the preload is
 * plain CommonJS that Electron must load from beside main.js. Without this
 * step the packaged app starts with a missing preload script, the host
 * bridge is never injected, and the IDE, terminal, builder, and agent all
 * silently degrade to chat-only - which is exactly how v0.3.0 shipped.
 *
 * Kept as a file rather than an inline `node -e` so it is readable,
 * cross-platform, and pinned by a test.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const source = join(appRoot, 'src', 'preload.cjs');
const target = join(appRoot, 'dist', 'preload.cjs');

if (!existsSync(source)) {
  console.error(`copy-preload: missing source ${source}`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log('copy-preload: src/preload.cjs -> dist/preload.cjs');
