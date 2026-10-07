/**
 * Generate the data-driven tables inside README.md.
 *
 *   node tools/gen-readme-tables.mjs           # rewrite the tables
 *   node tools/gen-readme-tables.mjs --check   # fail if they are stale
 *
 * Content between `<!-- BEGIN name -->` and `<!-- END name -->` is owned by
 * this script. A fifty-row model table typed into prose is a table that
 * quietly lies the first time someone adds a weight, so the catalog one is
 * generated and the check runs in CI.
 *
 * The counters in the "Development" section are deliberately NOT generated.
 * Test counts change with every commit that adds one, so quoting them makes
 * the README a thing that must be edited in the same commit as the tests -
 * and a reviewer skimming a diff will not notice a stale number. The README
 * points at CI instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(REPO, 'README.md');
const CATALOG = join(REPO, 'apps', 'desktop', 'src', 'models.json');
const DEFAULTS = join(REPO, 'packages', 'core', 'src', 'defaults.ts');

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));

/** Tier per weight, read from the router's own defaults. */
function tiersFromDefaults(source) {
  // Strip CR: the file checks out with CRLF on Windows and a trailing \r
  // defeats an end-of-line anchor.
  const lines = source.replace(/\r/g, '').split('\n');
  const tierOf = {};

  for (let i = 0; i < lines.length; i += 1) {
    if (!/name: 'embedded',/.test(lines[i])) continue;

    let tier = null;
    for (let j = i; j >= 0 && j > i - 200; j -= 1) {
      const m = /^ {6}(local|mid|frontier): \{$/.exec(lines[j]);
      if (m) {
        tier = m[1];
        break;
      }
    }
    if (!tier) throw new Error(`no tier above ${lines[i].trim()} at line ${i + 1}`);

    const ids = [];
    for (let j = i + 1; j < lines.length && j < i + 40; j += 1) {
      if (!/models: \[/.test(lines[j])) continue;
      for (let k = j; k < lines.length; k += 1) {
        const id = /'([a-z0-9._-]+)'/.exec(lines[k]);
        if (id) ids.push(id[1]);
        if (/\],/.test(lines[k])) break;
      }
      break;
    }
    for (const id of ids) tierOf[id] = tier;
  }

  if (Object.keys(tierOf).length === 0) {
    throw new Error('found no embedded providers in defaults.ts');
  }
  return tierOf;
}

const tierOf = tiersFromDefaults(readFileSync(DEFAULTS, 'utf8'));

function gib(bytes) {
  const value = bytes / 1073741824;
  return value >= 10 ? `${Math.round(value)} GiB` : `${value.toFixed(1)} GiB`;
}

function shortLicense(license) {
  if (license === 'Apache-2.0' || license === 'MIT') return license;
  return 'custom';
}

/** The model catalog table, one row per weight. */
function catalogTable() {
  const rows = catalog.map((entry) => {
    const tier = tierOf[entry.id];
    const where = tier ? `\`${tier}\`` : 'on request';
    const license = shortLicense(entry.license);
    const bundled = entry.bundled === true ? 'yes' : '';
    return `| \`${entry.id}\` | ${where} | ${gib(entry.bytes)} | ${license} | ${bundled} |`;
  });

  const header = [
    '| Model | Tier | Size | Licence | In installer |',
    '| --- | --- | --- | --- | --- |',
  ];
  return [...header, ...rows].join('\n');
}

/** A short summary of what the catalog contains. */
function catalogSummary() {
  const bundled = catalog.filter((m) => m.bundled === true);
  const total = catalog.reduce((sum, m) => sum + m.bytes, 0);
  const routed = catalog.filter((m) => tierOf[m.id]).length;
  // Derived, never written out. This line used to say "Four" while listing
  // whatever was flagged bundled, so the count and the list disagreed the
  // moment the bundle was cut down to one model.
  const ships =
    bundled.length === 1
      ? 'One ships'
      : `${bundled.length} ship`;
  return [
    `**${catalog.length} weights, ${routed} of them in the default tiers.**`,
    '',
    `${ships} in the installer (${bundled
      .map((m) => `\`${m.id}\``)
      .join(', ')}) and work${bundled.length === 1 ? 's' : ''} offline at first`,
    `launch. The rest are one click away. Every one is a downloadable file you`,
    `run on your own machine, so a local run costs nothing and needs no`,
    `account. The catalog as a whole is`,
    `${(total / 1073741824).toFixed(1)} GiB if you wanted all of it; nobody does.`,
  ].join('\n');
}

const GENERATED = {
  'catalog-summary': catalogSummary,
  'catalog-table': catalogTable,
};

function applyBlocks(markdown) {
  let result = markdown;
  for (const [name, build] of Object.entries(GENERATED)) {
    const begin = `<!-- BEGIN ${name} -->`;
    const end = `<!-- END ${name} -->`;
    const start = result.indexOf(begin);
    const stop = result.indexOf(end);
    if (start === -1 || stop === -1) {
      console.error(`README.md is missing the ${name} markers`);
      process.exit(1);
    }
    const body = `${begin}\n${build()}\n${end}`;
    result = result.slice(0, start) + body + result.slice(stop + end.length);
  }
  return result;
}

// Read with CRLF collapsed, so the generated blocks cannot reintroduce mixed
// line endings into a file that had none.
//
// This matters more than it looks. Git checks the README out with the
// platform's line endings, and the generator emits LF. Splicing LF blocks into
// a CRLF file leaves the file with both, so re-running the generator after a
// Windows checkout makes the README dirty without changing a single word - and
// the drift check then fails on a file that is textually identical.
const current = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
const updated = applyBlocks(current);

if (process.argv.includes('--check')) {
  if (current !== updated) {
    console.error(
      'README.md has stale generated tables.\n' +
        'Run: node tools/gen-readme-tables.mjs',
    );
    process.exit(1);
  }
  console.log('README tables are current');
} else {
  writeFileSync(README, updated);
  console.log(`README tables regenerated (${catalog.length} models)`);
}