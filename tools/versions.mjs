#!/usr/bin/env node
/**
 * Keep every version string in the repository in step.
 *
 *   node tools/versions.mjs check [--tag v0.4.2]   exit 1 if anything disagrees
 *   node tools/versions.mjs set 0.4.2              rewrite every one of them
 *
 * Why this exists: v0.4.0 was tagged and released while every manifest still
 * said 0.3.0. electron-builder names an installer from package.json, so the
 * release would have carried files called "... 0.3.0 ..." under a v0.4.0 tag,
 * and nothing noticed because no check compared the tag with the manifests.
 *
 * The version lives in more places than package.json: the TypeScript VERSION
 * constants, the Python package, the exact `@gearvane/*` dependency pins between
 * workspaces, the lockfile's record of each workspace, and the VSIX file name in
 * the README's install snippet. `check` reads all of them; `set` rewrites all of
 * them, so a bump is one command rather than a search.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = (...parts) => join(ROOT, ...parts);

/** Workspace manifests, relative to the repository root. */
const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/harness/package.json',
  'packages/cli/package.json',
  'apps/app-core/package.json',
  'apps/desktop/package.json',
  'apps/vscode-extension/package.json',
];

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const isOurs = (name) => name.startsWith('@gearvane/');

/** Source files that hold the version as a literal: [file, pattern, template]. */
const LITERALS = [
  ['packages/core/src/index.ts', /export const VERSION = '([^']+)';/, (v) => `export const VERSION = '${v}';`],
  ['apps/app-core/src/index.ts', /export const APP_VERSION = '([^']+)';/, (v) => `export const APP_VERSION = '${v}';`],
  ['setup.py', /version="([^"]+)",/, (v) => `version="${v}",`],
  ['gearvane/__init__.py', /__version__ = "([^"]+)"/, (v) => `__version__ = "${v}"`],
  ['README.md', /gearvane-(\d+\.\d+\.\d+)\.vsix/, (v) => `gearvane-${v}.vsix`],
];

const readJson = (file) => JSON.parse(readFileSync(path(file), 'utf8'));
const writeJson = (file, value) =>
  writeFileSync(path(file), `${JSON.stringify(value, null, 2)}\n`);

/** Every version found, as [where, version] pairs. */
function collect() {
  const found = [];

  for (const file of MANIFESTS) {
    const manifest = readJson(file);
    found.push([`${file} version`, manifest.version]);
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (isOurs(name)) found.push([`${file} ${field}.${name}`, range]);
      }
    }
  }

  const lock = readJson('package-lock.json');
  found.push(['package-lock.json version', lock.version]);
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const workspace = key === '' || MANIFESTS.some((file) => file === `${key}/package.json`);
    if (!workspace) continue;
    found.push([`package-lock.json packages["${key}"] version`, entry.version]);
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(entry[field] ?? {})) {
        if (isOurs(name)) found.push([`package-lock.json packages["${key}"].${field}.${name}`, range]);
      }
    }
  }

  for (const [file, pattern] of LITERALS) {
    const match = pattern.exec(readFileSync(path(file), 'utf8'));
    found.push([file, match ? match[1] : undefined]);
  }

  return found;
}

function check(tag) {
  const found = collect();
  const expected = tag ? tag.replace(/^v/, '') : found[0][1];
  const wrong = found.filter(([, version]) => version !== expected);

  if (wrong.length > 0) {
    console.error(`Version mismatch: expected ${expected}${tag ? ` (from tag ${tag})` : ''}.`);
    for (const [where, version] of wrong) {
      console.error(`  ${where}: ${version === undefined ? 'not found' : version}`);
    }
    console.error('\nRun `node tools/versions.mjs set <version>` to bring them together.');
    process.exitCode = 1;
    return;
  }
  console.log(`All ${found.length} version strings are ${expected}.`);
}

function set(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('Usage: node tools/versions.mjs set X.Y.Z');
    process.exitCode = 2;
    return;
  }

  for (const file of MANIFESTS) {
    const manifest = readJson(file);
    manifest.version = version;
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (isOurs(name)) manifest[field][name] = version;
      }
    }
    writeJson(file, manifest);
  }

  const lock = readJson('package-lock.json');
  lock.version = version;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const workspace = key === '' || MANIFESTS.some((file) => file === `${key}/package.json`);
    if (!workspace) continue;
    entry.version = version;
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(entry[field] ?? {})) {
        if (isOurs(name)) entry[field][name] = version;
      }
    }
  }
  writeJson('package-lock.json', lock);

  for (const [file, pattern, template] of LITERALS) {
    const text = readFileSync(path(file), 'utf8');
    if (!pattern.test(text)) {
      console.error(`could not find the version in ${file}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(path(file), text.replace(pattern, template(version)));
  }

  console.log(`Set every version to ${version}.`);
  check();
}

const [command, argument, extra] = process.argv.slice(2);
if (command === 'check') {
  check(argument === '--tag' ? extra : undefined);
} else if (command === 'set') {
  set(argument);
} else {
  console.error('Usage: node tools/versions.mjs check [--tag vX.Y.Z] | set X.Y.Z');
  process.exitCode = 2;
}
