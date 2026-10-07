#!/usr/bin/env node
/**
 * Check that every catalogued weight is pinned to an immutable revision and
 * carries a content hash.
 *
 * All fifty URLs used to read `.../resolve/main/<file>`. `main` moves, so the
 * bytes behind a given URL can change under an installed app: a re-uploaded
 * file, a re-quantised one, a renamed one. Nothing in the app could detect
 * that, because nothing recorded what it expected to receive.
 *
 * Two fields close it:
 *
 *   revision  the commit sha the URL resolves against, so the URL cannot drift
 *   sha256    the LFS content hash, so a fetched file can be verified at all
 *
 * This is a local check: it reads models.json and asserts the shape. It does
 * not make network calls, so it gates every PR rather than a schedule. The
 * values themselves came from the Hugging Face API and are verified by
 * tools/verify-requirements.mjs, which does call out.
 *
 * Usage: node tools/check-catalog-pins.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(HERE, '..', 'apps', 'desktop', 'src', 'models.json');

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const json = process.argv.includes('--json');

/** A commit sha, not a branch. 40 hex characters. */
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const problems = [];

if (catalog.length !== 50) {
  problems.push(`catalog has ${catalog.length} entries, expected 50`);
}

const ids = new Set();
const files = new Set();

for (const entry of catalog) {
  const where = entry.id ?? '(no id)';

  if (ids.has(entry.id)) problems.push(`${where}: duplicate id`);
  ids.add(entry.id);
  if (files.has(entry.file)) problems.push(`${where}: duplicate file`);
  files.add(entry.file);

  if (!entry.revision || !SHA.test(entry.revision)) {
    problems.push(`${where}: no pinned revision`);
  } else if (!entry.url.includes(`/resolve/${entry.revision}/`)) {
    problems.push(`${where}: url does not resolve at its pinned revision`);
  }

  if (!entry.sha256 || !SHA256.test(entry.sha256)) {
    problems.push(`${where}: no sha256`);
  }

  if (!/^https:\/\/huggingface\.co\//.test(entry.url ?? '')) {
    problems.push(`${where}: url is not an https Hugging Face URL`);
  }

  if (/\/resolve\/main\//.test(entry.url ?? '')) {
    problems.push(`${where}: url points at a moving ref (main)`);
  }

  if (!(entry.bytes > 0)) {
    problems.push(`${where}: no positive byte count`);
  }

  if (!entry.license || !/^https:\/\//.test(entry.licenseUrl ?? '')) {
    problems.push(`${where}: licence or licence URL missing`);
  }
}

if (json) {
  process.stdout.write(
    `${JSON.stringify({ entries: catalog.length, problems }, null, 2)}\n`,
  );
} else if (problems.length === 0) {
  process.stdout.write(
    `catalog pins OK: ${catalog.length} weights, all at a commit revision with a sha256\n`,
  );
} else {
  process.stdout.write(`${problems.length} problem(s):\n`);
  for (const p of problems) process.stdout.write(`  ${p}\n`);
  process.stdout.write('\nRun node tools/check-catalog-pins.mjs --json for detail.\n');
}

process.exit(problems.length === 0 ? 0 : 1);
