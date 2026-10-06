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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild's JS API, not its command line.
//
// The previous version ran `node node_modules/esbuild/bin/esbuild`. That path is
// a JavaScript shim on Windows and a native executable on Linux and macOS, so
// node tried to parse an ELF header as JavaScript and CI failed on both:
// "SyntaxError: Invalid or unexpected token". Which of the two you get depends
// on the platform and the esbuild version, which is exactly the sort of
// assumption a committed build artifact cannot rest on.
import { build } from 'esbuild';

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

// Normalised before comparison. Git checks text files out with the platform's
// line endings, so on Windows the committed artifact arrives as CRLF while
// esbuild emits LF - and a byte-exact comparison then fails forever on a
// platform where the file is, in every meaningful sense, current. The
// generator writes LF; .gitattributes keeps it that way in the repository; this
// comparison tolerates the checkout rather than requiring it.
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

const buildOptions = {
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  write: false,
  absWorkingDir: REPO,
};

let output;
try {
  const result = await build(buildOptions);
  output = result.outputFiles?.[0]?.text ?? '';
} catch (error) {
  // esbuild throws a rich Error with its own message. Printing it beats a
  // stack trace pointing at this file.
  const message = error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error);
  console.error(`bundling failed: ${message}`);
  process.exit(1);
}

const body = `${BANNER}\nexport ${output.trim()}\n`;

if (process.argv.includes('--check')) {
  const current = normalizeEol(readFileSync(TARGET, 'utf8'));
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