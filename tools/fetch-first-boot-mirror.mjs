#!/usr/bin/env node
/**
 * Populate a local mirror with the first-boot weights, verified.
 *
 * The first-boot weights total 9.04 GiB, which is too much for a test to
 * download on every run. So they are fetched once, into tmp/first-boot-mirror,
 * and verified against the catalog's sha256 as they arrive. After that,
 * tools/check-first-boot.mjs runs entirely against the mirror.
 *
 * The mirror is gitignored and disposable. If it is missing, the check says so
 * and names this script rather than reporting a pass it did not achieve.
 *
 * Usage:
 *   node tools/fetch-first-boot-mirror.mjs
 *   node tools/fetch-first-boot-mirror.mjs --only qwen3-8b.q4_k_m
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIRROR = join(ROOT, 'tmp', 'first-boot-mirror');

// Declared before use. A `const` arrow at the bottom of the module is in its
// temporal dead zone while the top-level code above it runs, so `gib(...)` threw
// ReferenceError rather than doing anything.
const gib = (bytes) => `${(bytes / 1073741824).toFixed(2)} GiB`;

function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const only = arg('only');

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/src/models.json'), 'utf8'),
);
const wanted = catalog
  .filter((e) => e.provision === 'first-boot')
  .filter((e) => !only || e.id === only);

if (wanted.length === 0) {
  process.stderr.write(only ? `no first-boot weight ${only}\n` : 'nothing flagged first-boot\n');
  process.exit(1);
}

mkdirSync(MIRROR, { recursive: true });

for (const entry of wanted) {
  const target = join(MIRROR, entry.file);

  // Already there and already right: skip. Re-downloading 9 GiB because a
  // check was run twice is not acceptable.
  if (existsSync(target) && statSync(target).size === entry.bytes) {
    const digest = await sha256Of(target);
    if (digest === entry.sha256) {
      process.stdout.write(`  present ${entry.file} (${gib(entry.bytes)})\n`);
      continue;
    }
    process.stdout.write(`  stale   ${entry.file}: hash differs, refetching\n`);
    rmSync(target, { force: true });
  }

  process.stdout.write(
    `  fetching ${entry.file} (${gib(entry.bytes)}) from revision ${entry.revision.slice(0, 12)}\n`,
  );

  const partial = `${target}.part`;
  const response = await fetch(entry.url);
  if (!response.ok || !response.body) {
    process.stderr.write(`  HTTP ${response.status} for ${entry.file}\n`);
    rmSync(partial, { force: true });
    process.exit(1);
  }

  let done = 0;
  let last = 0;
  const source = Readable.fromWeb(response.body).on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - last > 1000) {
      last = now;
      process.stdout.write(
        `\r    ${((done / entry.bytes) * 100).toFixed(0)}% ${gib(done)}/${gib(entry.bytes)}   `,
      );
    }
  });
  await pipeline(source, createWriteStream(partial));
  process.stdout.write('\r\x1b[K');

  // Verified here as well as in the check, so a mirror is either the real weight
  // or nothing. A mirror holding a corrupt file would make every later run
  // report a transfer failure that has nothing to do with the app.
  const digest = await sha256Of(partial);
  if (digest !== entry.sha256) {
    rmSync(partial, { force: true });
    process.stderr.write(
      `  ${entry.file}: sha256 mismatch\n    got      ${digest}\n    expected ${entry.sha256}\n`,
    );
    process.exit(1);
  }

  renameSync(partial, target);
  process.stdout.write(`  verified ${entry.file} (${gib(entry.bytes)})\n`);
}

process.stdout.write(`\nmirror ready at ${MIRROR}\n`);
