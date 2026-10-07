#!/usr/bin/env node
/**
 * Fetch the first-boot weights from a local mirror, through the app's own
 * transfer code.
 *
 * This is what makes `tools/check-first-boot.mjs` able to prove the whole path
 * -- resolve, stream, hash, compare, rename -- without a 9 GiB network transfer.
 * It imports `downloadModel` from the built app rather than reimplementing it:
 * a check that reimplements what it is checking passes while the app's version
 * does the opposite.
 *
 * The mirror holds real bytes, verified against the catalog when it was
 * populated by `tools/fetch-first-boot-mirror.mjs`. Only the URL is
 * substituted; the revision and the expected sha256 are exactly what the
 * catalog has, which is the point.
 *
 * Usage:
 *   node tools/first-boot-fetch.mjs --mirror DIR --into DIR [--only ID]
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mirror = resolvePath(arg('mirror', join(ROOT, 'tmp/first-boot-mirror')));
const into = resolvePath(arg('into'));
const only = arg('only');

if (!into) {
  process.stderr.write('--into DIR is required\n');
  process.exit(2);
}

// Built, not src/: this is the code the app ships, and a check against src/
// would not prove the shipped path.
const dist = join(ROOT, 'apps/desktop/dist/model-download.js');
if (!existsSync(dist)) {
  process.stderr.write(
    `${dist} is missing. Run: npm run build --workspace gearvane-app\n`,
  );
  process.exit(1);
}

const { downloadModel } = await import(pathToFileURL(dist).href);

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/src/models.json'), 'utf8'),
);

const candidates = catalog
  .filter((e) => e.provision === 'first-boot')
  .filter((e) => !only || e.id === only);

if (candidates.length === 0) {
  process.stderr.write(
    only ? `no first-boot weight with id ${only}\n` : 'nothing flagged first-boot\n',
  );
  process.exit(1);
}

for (const entry of candidates) {
  const source = join(mirror, entry.file);
  if (!existsSync(source)) {
    process.stderr.write(
      `${entry.file} is not in the mirror at ${mirror}.\n` +
        'Run: node tools/fetch-first-boot-mirror.mjs\n',
    );
    process.exit(1);
  }
}

mkdirSync(into, { recursive: true });

let failures = 0;
for (const entry of candidates) {
  try {
    // The catalog is rewritten to point at the mirror and nothing else: the id,
    // the revision and the expected sha256 all stay as the app would see them.
    // `confirmed: true` because these are exactly the weights the app
    // provisions without asking; both are above 500 MiB, so without it the host
    // would refuse and the check would be testing the refusal.
    const result = await downloadModel(into, entry.id, {
      confirmed: true,
      fetchImpl: mirrorFetch(mirror),
      onProgress: () => {},
    });

    const landed = statSync(join(into, entry.file));
    if (landed.size !== entry.bytes) {
      throw new Error(`landed ${landed.size} bytes, catalog says ${entry.bytes}`);
    }
    process.stdout.write(
      `  fetched ${entry.id} (${(result.bytes / 1073741824).toFixed(2)} GiB)\n`,
    );
  } catch (error) {
    failures += 1;
    process.stderr.write(`  ${entry.id}: ${error.message}\n`);
  }
}

process.exit(failures === 0 ? 0 : 1);

/**
 * A fetch that serves from the mirror by file name.
 *
 * The catalog's URL points at Hugging Face; this ignores it and reads the local
 * file whose name is the tail of the catalog's path. Everything downstream of
 * the response -- streaming, hashing, comparing, renaming -- is the app's own
 * code, which is what the check is for.
 */
function mirrorFetch(dir) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const path = join(dir, file);
    if (!existsSync(path)) {
      return new Response(null, { status: 404 });
    }
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(path);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.byteLength),
      },
    });
  };
}
