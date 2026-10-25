#!/usr/bin/env node
/**
 * Print one version's section of CHANGELOG.md.
 *
 *   node tools/release-notes.mjs 0.4.2 > notes.md
 *
 * The release workflow uses this for the GitHub release body, so the notes a
 * user reads are the ones written alongside the work rather than whatever
 * GitHub generates from commit titles. It fails when the section is missing or
 * empty, which turns "forgot the changelog" into a red build instead of a
 * release with blank notes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node tools/release-notes.mjs X.Y.Z');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);

const prefix = `## [${version}]`;
const start = lines.findIndex((line) => line.startsWith(prefix));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}

let end = lines.findIndex((line, index) => index > start && line.startsWith('## ['));
if (end === -1) end = lines.length;

const body = lines.slice(start + 1, end).join('\n').trim();
if (body === '') {
  console.error(`The "## [${version}]" section of CHANGELOG.md is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
