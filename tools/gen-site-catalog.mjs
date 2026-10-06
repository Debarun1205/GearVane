/**
 * Generate site/assets/catalog-data.js from the app's model catalog.
 *
 *   node tools/gen-site-catalog.mjs           # write the file
 *   node tools/gen-site-catalog.mjs --check   # fail if it is out of date
 *
 * The site has no build step by design: it deploys by copying a directory.
 * That rule and a table generated from source are not in conflict, because the
 * generated file is committed. `--check` is what keeps it honest, so a stale
 * table fails CI rather than quietly lying to visitors.
 *
 * ## Why the tier comes from defaults.ts and not from a size rule
 *
 * The obvious implementation labels each weight by its download size. That is
 * wrong, and measurably so: the default router puts qwen3-8b (4.7 GiB) in the
 * frontier tier and eleven sub-2 GB models in mid. A size band would therefore
 * have disagreed with the app on 13 of the 36 routed weights, and the site
 * would have described a classification GearVane does not perform.
 *
 * So the tier is read from the router's own configuration, which is the only
 * definition that means anything to a user. What the sizes *do* explain is the
 * band boundaries, and the page labels them as provisional for that reason.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CATALOG = join(REPO, 'apps', 'desktop', 'src', 'models.json');
const DEFAULTS = join(REPO, 'packages', 'core', 'src', 'defaults.ts');
const TARGET = join(REPO, 'site', 'assets', 'catalog-data.js');

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));

/**
 * Tier each catalog weight by the router's own default configuration.
 *
 * Parses defaults.ts rather than importing it: this script runs before any
 * build, and the site has no toolchain. That is fragile, so it fails loudly
 * rather than emitting a wrong tier.
 */
function tiersFromDefaults(source) {
  // Strip CR: the file is checked out with CRLF on Windows, and a trailing
  // \r defeats an end-of-line anchor. This is why the first version of this
  // script found no tiers at all and looked like the config had none.
  const lines = source.replace(/\r/g, '').split('\n');
  const tierOf = {};

  for (let i = 0; i < lines.length; i += 1) {
    if (!/name: 'embedded',/.test(lines[i])) continue;

    // Scan backwards for the tier key this provider sits under.
    let tier = null;
    for (let j = i; j >= 0 && j > i - 200; j -= 1) {
      const m = /^ {6}(local|mid|frontier): \{$/.exec(lines[j]);
      if (m) {
        tier = m[1];
        break;
      }
    }
    if (!tier) throw new Error(`no tier found above ${lines[i].trim()} at line ${i + 1}`);

    // Then forward for the model list belonging to this provider.
    const ids = [];
    let found = false;
    for (let j = i + 1; j < lines.length && j < i + 40; j += 1) {
      const start = /models: \[/.exec(lines[j]);
      if (!start) continue;
      for (let k = j; k < lines.length; k += 1) {
        const id = /'([a-z0-9._-]+)'/.exec(lines[k]);
        if (id) ids.push(id[1]);
        if (/\],/.test(lines[k])) {
          found = true;
          break;
        }
      }
      break;
    }
    if (!found) throw new Error(`no model list found for ${tier} embedded at line ${i + 1}`);

    for (const id of ids) tierOf[id] = tier;
  }

  if (Object.keys(tierOf).length === 0) {
    throw new Error('found no embedded providers in defaults.ts');
  }
  return tierOf;
}

const tierOf = tiersFromDefaults(readFileSync(DEFAULTS, 'utf8'));

const problems = [];
const rows = catalog.map((entry) => {
  if (!entry.license) problems.push(`${entry.id}: no license`);
  if (!entry.licenseUrl) problems.push(`${entry.id}: no licenseUrl`);
  if (typeof entry.bytes !== 'number') problems.push(`${entry.id}: bad bytes`);
  return {
    id: entry.id,
    bytes: entry.bytes,
    use: entry.use,
    bundled: entry.bundled === true,
    license: entry.license,
    licenseUrl: entry.licenseUrl,
    // Null means the default tiers do not name this weight. It is still
    // downloadable and still selectable by hand, so the site shows it as
    // "on request" rather than inventing a tier.
    tier: tierOf[entry.id] ?? null,
  };
});

if (problems.length > 0) {
  console.error('catalog is incomplete:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const body =
  `/**
 * GENERATED FILE - do not edit.
 *
 * Produced by tools/gen-site-catalog.mjs from apps/desktop/src/models.json
 * and packages/core/src/defaults.ts. Run that script to refresh it, or
 * \`--check\` to verify it is current.
 *
 * ${rows.length} weights. \`tier\` is the router's own assignment, not a size
 * band: a null tier means the default tiers do not name that weight.
 *
 * Licences were verified against each model's Hugging Face card; see
 * THIRD_PARTY_NOTICES.md for the full mapping.
 */

export const MODELS = ${JSON.stringify(rows, null, 2)};
`;

if (process.argv.includes('--check')) {
  // Normalised before comparison: git checks text out with the platform's line
  // endings, so on Windows the committed file arrives as CRLF while this
  // generator writes LF, and a byte-exact comparison fails forever on a file
  // that is current in every meaningful sense.
  const current = readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n');
  if (current !== body) {
    console.error(
      'site/assets/catalog-data.js is out of date.\n' +
        'Run: node tools/gen-site-catalog.mjs',
    );
    process.exit(1);
  }
  const tiers = rows.reduce((acc, r) => {
    const key = r.tier ?? 'unassigned';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`catalog-data.js is current: ${JSON.stringify(tiers)}`);
} else {
  writeFileSync(TARGET, body);
  const counts = rows.reduce((acc, r) => {
    const key = r.tier ?? 'unassigned';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`wrote catalog-data.js: ${JSON.stringify(counts)}`);
}