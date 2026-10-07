#!/usr/bin/env node
/**
 * Fetch the weights the desktop app ships and provisions.
 *
 * Three modes, and the distinction matters more than it looks:
 *
 *   (default)     the weights that go inside the installer. The two low-tier
 *                 models, 0.65 GiB together, which is what makes a fresh
 *                 install answer the local tier offline.
 *   --first-boot  the weights the app downloads on first launch, in the
 *                 background: one mid and one high, 9.04 GiB. Not for the
 *                 app's own boot path.
 *   --all         every weight in the catalog. A developer convenience for
 *                 populating a machine; 450 GiB, so it must never be reachable
 *                 from anything the app runs.
 *
 * `--first-run` used to mean --all. It was never wired to the app, but a flag
 * named "first run" in a build script is one refactor away from downloading
 * every weight on a user's first launch, so it is now --first-boot and means
 * only the two the app provisions.
 *
 * Downloads are verified against the catalog's sha256, resumed when the server
 * supports it, and one at a time so two transfers cannot fight over the disk.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, '..', 'resources', 'models');
const catalog = JSON.parse(
  readFileSync(join(HERE, '..', 'src', 'models.json'), 'utf8'),
);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const force = flag('--force');

/** Reject the old name rather than silently meaning something else now. */
if (flag('--first-run')) {
  console.error(
    '--first-run has been renamed. It used to download every model in the\n' +
      'catalog (450 GiB) and must never be an app boot path. Use:\n' +
      '  --first-boot  the two models the app provisions on first launch\n' +
      '  --all         every model, for development only',
  );
  process.exit(2);
}

const all = flag('--all');
const firstBoot = flag('--first-boot');

let models;
let what;
if (all) {
  models = catalog;
  what = 'every weight in the catalog';
} else if (firstBoot) {
  models = catalog.filter((entry) => entry.provision === 'first-boot');
  what = 'the first-boot provisioned weights';
} else {
  models = catalog.filter((entry) => entry.bundled === true);
  what = 'the installer weights';
}

if (models.length === 0) {
  console.error(`models.json flags nothing to fetch for: ${what}`);
  process.exit(1);
}

mkdirSync(MODELS_DIR, { recursive: true });

/** True when the file on disk already matches the catalog. */
function isGood(entry) {
  const target = join(MODELS_DIR, entry.file);
  if (!existsSync(target)) return false;
  if (!entry.bytes || statSync(target).size !== entry.bytes) return false;
  if (!entry.sha256) return true; // nothing to check against
  return sha256Of(target) === entry.sha256;
}

function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Fetch one weight, resuming from a .part when there is one.
 *
 * The catalog pins every URL to a commit revision, so a resumed transfer
 * cannot pick up a different file halfway through: the bytes behind the URL
 * cannot change.
 */
async function fetchOne(entry) {
  const target = join(MODELS_DIR, entry.file);
  if (!force && isGood(entry)) {
    console.log(`  present  ${entry.file} (${mb(entry.bytes)})`);
    return;
  }
  // A stale part file from a previous run must not survive into this one: its
  // offset would be appended to and the result would be two weights' worth of
  // bytes in one file.
  const stalePart = `${target}.part`;
  if (!existsSync(target) && existsSync(stalePart)) {
    const partSize = statSync(stalePart).size;
    if (entry.bytes && partSize > entry.bytes) rmSync(stalePart, { force: true });
  }
  if (existsSync(target)) {
    // Present but wrong size or wrong hash: do not keep it.
    rmSync(target, { force: true });
  }

  const part = `${target}.part`;
  const from = existsSync(part) ? statSync(part).size : 0;
  if (entry.bytes && from > entry.bytes) {
    rmSync(part, { force: true });
    return fetchOne({ ...entry, bytes: entry.bytes });
  }

  const headers = {};
  if (from > 0) headers.Range = `bytes=${from}-`;

  const response = await fetch(entry.url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`download failed: HTTP ${response.status} for ${entry.file}`);
  }
  // A server that ignores Range restarts the file, so the partial must go.
  const resuming = response.status === 206 && from > 0;
  if (!resuming && existsSync(part)) rmSync(part, { force: true });

  const total = Number(response.headers.get('content-length') ?? 0) + from;
  let done = from;
  let lastReport = 0;

  await pipeline(
    Readable.fromWeb(response.body).on('data', (chunk) => {
      done += chunk.length;
      const now = Date.now();
      // Every half second, not every chunk: progress output on a fast link
      // costs more than the download.
      if (now - lastReport > 500) {
        lastReport = now;
        const pct = total > 0 ? ` ${((done / total) * 100).toFixed(0)}%` : '';
        process.stdout.write(`\r  ${entry.file}${pct} ${mb(done)}/${mb(total)}   `);
      }
    }),
    createWriteStream(part, { flags: resuming ? 'a' : 'w' }),
  );

  process.stdout.write('\r\x1b[K');

  if (entry.bytes && statSync(part).size !== entry.bytes) {
    rmSync(part, { force: true });
    throw new Error(
      `size mismatch for ${entry.file}: got ${statSync(part).size}, expected ${entry.bytes}`,
    );
  }
  if (entry.sha256) {
    const digest = await sha256Of(part);
    if (digest !== entry.sha256) {
      rmSync(part, { force: true });
      throw new Error(
        `sha256 mismatch for ${entry.file}: got ${digest}, expected ${entry.sha256}`,
      );
    }
  }

  // Rename last: a half-written weight must never sit at the path the app
  // serves from.
  renameSync(part, target);
  console.log(`  fetched  ${entry.file} (${mb(entry.bytes)})`);
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

console.log(`fetching ${models.length} weight(s): ${what}`);
for (const entry of models) {
  // One at a time, sequentially: two multi-gigabyte transfers to the same
  // directory help neither.
  await fetchOne(entry);
}
console.log('done');
