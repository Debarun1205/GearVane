/**
 * Bundle @gearvane/core for the site's router playground.
 *
 *   node tools/build-site-engine.mjs           # write the file
 *   node tools/build-site-engine.mjs --check   # fail if it is out of date
 *
 * The playground runs the real classifier rather than a reimplementation of
 * it, because a marketing page that decides tiers with its own logic would
 * prove nothing about the product. The engine is dependency-free TypeScript
 * that runs in a browser, so this only has to compile it.
 *
 * The site keeps its no-build-step rule, so the output is committed and
 * `--check` is what keeps it honest - the same arrangement as the catalog
 * data. A stale playground would show decisions the app no longer makes,
 * which is worse than not having one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ENTRY = join(REPO, 'site', 'assets', 'engine-entry.ts');
const TARGET = join(REPO, 'site', 'assets', 'engine.js');
const BANNER = [
  '/**',
  ' * GENERATED FILE - do not edit.',
  ' *',
  ' * Produced by tools/build-site-engine.mjs from packages/core. Run that',
  ' * script to refresh it, or `--check` to verify it is current.',
  ' *',
  ' * This is the real router: the same TaskClassifier the CLI, the app, and',
  ' * the VS Code extension use. It routes only; it never runs a model.',
  ' */',
].join('\n');

if (!existsSync(join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'))) {
  console.error('esbuild is not installed; run npm install at the repo root first');
  process.exit(1);
}

const output = execFileSync(
  process.execPath,
  [
    join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    ENTRY,
    '--bundle',
    '--format=esm',
    '--target=es2022',
    '--platform=browser',
    '--minify',
    '--legal-comments=none',
  ],
  { cwd: REPO, encoding: 'buffer' },
);

const body = `${BANNER}\nexport ${output.toString('utf8').trim()}\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  if (current !== body) {
    console.error(
      'site/assets/engine.js is out of date.\n' +
        'Run: node tools/build-site-engine.mjs',
    );
    process.exit(1);
  }
  console.log(`engine.js is current (${Math.round(body.length / 1024)} KiB)`);
} else {
  writeFileSync(TARGET, body);
  console.log(`wrote engine.js: ${Math.round(body.length / 1024)} KiB`);
}