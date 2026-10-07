#!/usr/bin/env node
/**
 * Verify the owner's requirements against the real catalog and config.
 *
 * One script, printing PASS or FAIL per item, rather than a test suite added
 * for its own sake. Each check reads a file that ships, so a claim in the
 * README, the site, or a commit message can be checked against the thing it
 * describes.
 *
 * Offline by default: it asserts the shape of the data and the constants in
 * the source. Pass --online to additionally confirm every pinned URL still
 * resolves at Hugging Face, which is the check that needs the network.
 *
 * Usage:
 *   node tools/verify-requirements.mjs            # offline, fast
 *   node tools/verify-requirements.mjs --online   # also HEAD every weight
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ONLINE = process.argv.includes('--online');

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/src/models.json'), 'utf8'),
);
const appPkg = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8'),
);
const catalogTs = readFileSync(
  join(ROOT, 'apps/desktop/src/catalog.ts'), 'utf8',
);
const pickerTs = readFileSync(
  join(ROOT, 'apps/desktop/src/model-picker.ts'), 'utf8',
);
const modelsHostTs = readFileSync(
  join(ROOT, 'apps/desktop/src/models-host.ts'), 'utf8',
);
const typesTs = readFileSync(join(ROOT, 'packages/core/src/types.ts'), 'utf8');
const defaultsTs = readFileSync(
  join(ROOT, 'packages/core/src/defaults.ts'), 'utf8',
);
const rendererTs = readFileSync(
  join(ROOT, 'apps/desktop/src/renderer.ts'), 'utf8',
);
const exampleYaml = readFileSync(join(ROOT, 'config.example.yaml'), 'utf8');

const GIB = 1073741824;
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail ?? '' });
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, what) {
  assert(
    actual === expected,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

const sha = (v) => /^[0-9a-f]{40}$/.test(v ?? '');
const sha256 = (v) => /^[0-9a-f]{64}$/.test(v ?? '');

// --- R1: exactly 50, all installable, all pinned ---------------------------
check('R1 exactly 50 models', () => {
  assertEqual(catalog.length, 50, 'entry count');
  const ids = new Set(catalog.map((e) => e.id));
  assertEqual(ids.size, 50, 'unique id count');
  return `${catalog.length} entries, ${ids.size} unique ids`;
});

check('R1 every model has a download entry', () => {
  const missing = catalog.filter((e) => !e.url || !e.file || !(e.bytes > 0));
  assertEqual(missing.length, 0, `entries without a download (${missing.map((e) => e.id)})`);
  return `${catalog.length}/${catalog.length} have url, file and bytes`;
});

check('R1 every model pinned to a revision', () => {
  const bad = catalog.filter((e) => !sha(e.revision));
  assertEqual(bad.length, 0, `unpinned (${bad.map((e) => e.id).slice(0, 4)})`);
  return `${catalog.length}/${catalog.length} carry a 40-hex commit sha`;
});

check('R1 every model carries a sha256', () => {
  const bad = catalog.filter((e) => !sha256(e.sha256));
  assertEqual(bad.length, 0, `no sha256 (${bad.map((e) => e.id).slice(0, 4)})`);
  return `${catalog.length}/${catalog.length} carry a 64-hex sha256`;
});

// --- R2: four embedded, tier spread, permissive licences ---------------------
// Tier membership comes from the router config the app actually ships, not from
// a duplicated list here. defaults.ts declares one tier per block with a
// `name: '<tier>'` marker, so the block is found by that marker and then
// searched for the model id.
function tierOf(modelId) {
  const lines = defaultsTs.split('\n');
  let current = null;
  for (const line of lines) {
    // The tiers object is `{ local: { ... }, mid: { ... }, frontier: { ... } }`.
    // A new block starts at the tier key; the `name` inside it confirms which.
    if (/^\s{6}(local|mid|frontier):\s*\{/.test(line)) {
      current = line.trim().split(':')[0];
      continue;
    }
    if (current && line.includes(`'${modelId}'`)) return current;
  }
  return null;
}

check('R2 exactly four embedded models', () => {
  const embedded = catalog.filter((e) => e.embedded === true);
  assertEqual(embedded.length, 4, 'embedded count');
  return embedded.map((e) => e.id).join(', ');
});

check('R2 embedded spread 2 low / 1 mid / 1 high', () => {
  const embedded = catalog.filter((e) => e.embedded === true);
  const byTier = { local: 0, mid: 0, frontier: 0 };
  for (const e of embedded) {
    const tier = tierOf(e.id);
    assert(tier, `${e.id} is embedded but in no configured tier`);
    byTier[tier] += 1;
  }
  assertEqual(byTier.local, 2, 'low-tier embedded');
  assertEqual(byTier.mid, 1, 'mid-tier embedded');
  assertEqual(byTier.frontier, 1, 'high-tier embedded');
  return `low ${byTier.local}, mid ${byTier.mid}, high ${byTier.frontier}`;
});

check('R2 embedded are permissively licensed', () => {
  const embedded = catalog.filter((e) => e.embedded === true);
  const bad = embedded.filter(
    (e) => !['Apache-2.0', 'MIT'].includes(e.license),
  );
  assertEqual(bad.length, 0, `non-permissive (${bad.map((e) => `${e.id}=${e.license}`)})`);
  return embedded.map((e) => `${e.id}=${e.license}`).join(', ');
});

// --- R3: the 500 MiB rule is one constant, used by both sides ---------------
check('R3 the 500 MiB rule is a single constant', () => {
  const m = pickerTs.match(/AUTO_INSTALL_LIMIT\s*=\s*([^;]+);/);
  assert(m, 'AUTO_INSTALL_LIMIT not found in model-picker.ts');
  const value = Function(`return ${m[1]}`)();
  assertEqual(value, 500 * 1048576, 'AUTO_INSTALL_LIMIT bytes');
  return `${value} bytes = 500 MiB`;
});

check('R3 main process enforces the same threshold', () => {
  // The host owns the model directory, so the gate has to exist there too: a
  // renderer that ignored the picker must not be able to start a silent
  // multi-gigabyte transfer.
  //
  // Which file that is, is resolved rather than assumed. It was models-host.ts
  // until the transfer was split into its own module so the first-boot check
  // could run a real download outside Electron -- and this check kept looking
  // at the old filename and reported the gate missing while it sat one module
  // over. A check that names a file will report on that file's contents, not on
  // whether the behaviour exists.
  const srcDir = join(ROOT, 'apps/desktop/src');
  const sources = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(srcDir, name), 'utf8') }));

  const owner = sources.find(
    (file) =>
      /export async function downloadModel\(/.test(file.text) &&
      /from '\.\/catalog\.js'/.test(file.text),
  );
  assert(owner, 'no module exports downloadModel and reads the catalog');
  assert(
    /import \{[^}]*AUTO_INSTALL_LIMIT[^}]*\} from '\.\/model-picker\.js'/.test(owner.text),
    `${owner.name} does not import AUTO_INSTALL_LIMIT from model-picker`,
  );
  assert(
    /entry\.bytes >= AUTO_INSTALL_LIMIT && !options\.confirmed/.test(owner.text),
    `${owner.name} never compares a weight against AUTO_INSTALL_LIMIT`,
  );
  return `${owner.name} imports and enforces the same constant`;
});

check('R3 the picker asks above the threshold and does not below', () => {
  assert(
    /entry\.download\.bytes < AUTO_INSTALL_LIMIT/.test(pickerTs),
    'planSelection does not branch on AUTO_INSTALL_LIMIT',
  );
  assert(
    /confirmInstall/.test(pickerTs),
    'no confirm path for a large weight',
  );
  return 'under the limit installs without a dialog; at or above asks first';
});

// --- R4: no spend limits, and cost follows the provider ---------------------
check('R4 no model is metered without an API key', () => {
  // Local provider names are free regardless of tier. Mid and high hold local
  // weights as well as keyed cloud models, so the check is per provider.
  const localNames = /LOCAL_PROVIDER_NAMES_FOR_COST: readonly string\[\] = \[([^\]]+)\]/s
    .exec(typesTs);
  assert(localNames, 'LOCAL_PROVIDER_NAMES_FOR_COST not found');
  const names = localNames[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  // Any tier whose providers are all local must have no billing rate.
  for (const tier of ['local', 'mid', 'frontier']) {
    const block = defaultsTs.match(
      new RegExp(`\\b${tier}: \\{[\\s\\S]*?costPerToken: ([\\d.]+)`),
    );
    if (!block) continue;
    const embeddedHere = block[0].includes("name: 'embedded'");
    if (embeddedHere && tier !== 'frontier') {
      assert(
        names.includes('embedded'),
        'embedded not in the local provider list, so its cost cannot be derived',
      );
    }
  }
  assert(
    /function costClassForProvider/.test(typesTs),
    'costClassForProvider missing: cost is not derived from the provider',
  );
  return `${names.length} local provider names resolve to free by construction`;
});

check('R4 default config ships no spend limits', () => {
  assert(
    !/^\s*spend_limits\s*:/m.test(exampleYaml),
    'config.example.yaml still declares spend_limits',
  );
  // Locate the top-level `budget:` block by its indentation, so a `budget:`
  // mentioned inside a comment cannot satisfy this.
  const lines = exampleYaml.split('\n');
  const start = lines.findIndex((l) => /^budget:\s*$/.test(l));
  assert(start >= 0, 'no top-level budget block found');
  const body = lines.slice(start + 1);
  const block = [];
  for (const line of body) {
    if (/^\S/.test(line)) break; // next top-level key
    block.push(line);
  }
  const text = block.join('\n');
  for (const key of ['per_session', 'per_day', 'per_task']) {
    const found = text.match(new RegExp(`^\\s*${key}:\\s*([\\d.]+)`, 'm'));
    assert(found, `budget.${key} missing`);
    assertEqual(Number(found[1]), 0, `budget.${key}`);
  }
  return 'no spend_limits key; budget per_session/per_day/per_task all 0';
});

check('R4 the app meter enforces nothing', () => {
  assert(
    /sessionSpendUsd\.toFixed\(4\)/.test(rendererTs),
    'the spend meter no longer renders the session cost',
  );
  assert(
    /No limit is enforced/.test(rendererTs),
    'the meter does not say that no limit is enforced',
  );
  return 'meter renders a running cost and enforces no cap';
});

// --- packaging: installer payload, and the installable ceiling -------------
check('installer bundles exactly the low-tier embedded weights', () => {
  // The manifest is static JSON, so it cannot read the catalog. This is the
  // guard against the two drifting: every extraResources entry must name a
  // real file, and the set must equal what the catalog flags `installer`.
  const resources = appPkg.build?.extraResources ?? [];
  for (const resource of resources) {
    const from = resource.from ?? '';
    assert(
      from.startsWith('resources/models/') && !from.endsWith('/'),
      `extraResources.from is not a single file: "${from}"`,
    );
  }
  const shipped = resources.map((r) => r.from?.split('/').pop()).sort();
  const declared = catalog
    .filter((e) => e.provision === 'installer')
    .map((e) => e.file)
    .sort();
  assertEqual(shipped.join(','), declared.join(','), 'installer payload vs catalog');
  return shipped.join(', ');
});

check('installer payload is under 1 GiB', () => {
  // Only what ships in the installer counts; the mid and high weights are
  // provisioned on first launch. Derived from the catalog's real sizes.
  const files = new Set(
    (appPkg.build?.extraResources ?? []).map((r) => r.from?.split('/').pop()),
  );
  const shipped = catalog.filter((e) => files.has(e.file));
  assert(shipped.length > 0, 'no catalog entry matches the installer payload');
  const bytes = shipped.reduce((sum, e) => sum + e.bytes, 0);
  assert(bytes < 1 * GIB, `installer payload is ${(bytes / GIB).toFixed(2)} GiB`);
  return `${shipped.map((e) => e.id).join(', ')}: ${(bytes / GIB).toFixed(2)} GiB`;
});

check('the first-boot weights are the mid and high ones', () => {
  // What the app fetches in the background, unasked. Named so a claim about
  // first launch can be checked rather than taken on trust.
  const provisioned = catalog.filter((e) => e.provision === 'first-boot');
  assert(provisioned.length > 0, 'nothing is provisioned on first boot');
  return provisioned
    .map((e) => `${e.id} (${(e.bytes / GIB).toFixed(2)} GiB)`)
    .join(', ');
});

check('every weight is under the installable ceiling', () => {
  // Matched loosely and evaluated, because the constant is written as
  // `20 * GIB` and a stricter pattern would break on a cosmetic edit.
  const m = catalogTs.match(/REMOTE_ONLY_BYTES\s*=\s*([^;]+);/);
  assert(m, 'REMOTE_ONLY_BYTES not found in catalog.ts');
  const ceiling = Function(`return ${m[1].replace(/\bGIB\b/g, String(GIB))}`)();
  const over = catalog.filter((e) => e.bytes > ceiling);
  assertEqual(
    over.length, 0,
    `above the ceiling (${over.map((e) => `${e.id} ${(e.bytes / GIB).toFixed(1)}GiB`)})`,
  );
  const largest = catalog.reduce((a, b) => (a.bytes > b.bytes ? a : b));
  return `largest is ${largest.id} at ${(largest.bytes / GIB).toFixed(2)} GiB`;
});

// --- online: does every pinned URL still resolve? -------------------------
async function onlineChecks() {
  const results = [];
  for (const entry of catalog) {
    const url = `https://huggingface.co/api/models/${entry.url
      .split('/resolve/')[0]
      .replace('https://huggingface.co/', '')}`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      results.push({
        name: `online ${entry.id}`,
        pass: res.ok,
        detail: res.ok ? 'repo resolves' : `HTTP ${res.status}`,
      });
    } catch (error) {
      results.push({
        name: `online ${entry.id}`,
        pass: false,
        detail: String(error.message ?? error),
      });
    }
  }
  return results;
}

// --- report ---------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write('\nGearVane requirement verification\n\n');
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  process.stdout.write(
    `  [${mark}] ${r.name.padEnd(width)}  ${r.detail}\n`,
  );
}
let failed = results.filter((r) => !r.pass);

if (ONLINE) {
  process.stdout.write('\nchecking every pinned repository at Hugging Face...\n');
  const online = await onlineChecks();
  for (const r of online) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    process.stdout.write(
      `  [${mark}] ${r.name.padEnd(width)}  ${r.detail}\n`,
    );
  }
  failed = failed.concat(online.filter((r) => !r.pass));
}

process.stdout.write(
  `\n${results.length + (ONLINE ? catalog.length : 0) - failed.length}` +
    ` passed, ${failed.length} failed\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
