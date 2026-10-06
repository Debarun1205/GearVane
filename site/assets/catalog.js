/**
 * The model catalog explorer.
 *
 * The data comes from catalog-data.js, which tools/gen-site-catalog.mjs
 * generates from apps/desktop/src/models.json and packages/core/src/defaults.ts.
 * Nothing here is typed by hand: a fifty-row table copied into markup goes
 * stale the moment someone adds a model, and a stale table is exactly the kind
 * of claim this project refuses to make. tests/catalog-tiers.test.ts compares
 * the generated tiers against the live config, so the two cannot drift.
 *
 * ## Tiers are read, not computed
 *
 * An earlier version derived each tier from the download size, on the
 * assumption that was how GearVane tiers. It is not: the default router puts
 * qwen3-8b (4.7 GiB) in frontier and eleven sub-2 GB weights in mid, so a size
 * rule disagreed with the app on 13 of the 36 routed models. The tier here is
 * whatever the router says, and a weight no default tier names shows as
 * "on request" rather than being assigned one.
 *
 * What is deliberately absent: RAM requirements and tokens/s. Those need the
 * hardware-manager work (F5) and a benchmark (B5). A guessed number is worse
 * than a blank, so the explorer shows what is genuinely known - size, use,
 * licence, tier - and says what is missing.
 *
 * Served to the browser as-is, so valid JavaScript only: no annotations.
 */

import { MODELS } from './catalog-data.js';

/** What each tier is for. The names are the router's own ids. */
export const TIER_INFO = {
  local: {
    label: 'local',
    note: 'The everyday default: typos, formatting, mechanical refactors.',
  },
  mid: {
    label: 'mid',
    note: 'Multi-file changes, endpoints, tests, and edge-case reasoning.',
  },
  frontier: {
    label: 'frontier',
    note: 'Heavier weights for architecture, concurrency, and performance work.',
  },
};

/** A short licence family, for a compact badge. */
export function licenseFamily(license) {
  if (license === 'Apache-2.0' || license === 'MIT') return license;
  return 'custom';
}

export function formatGiB(bytes) {
  const gib = bytes / 1073741824;
  // One decimal below 10 GB, none above: "18.5 GiB" and "67 GiB" read better
  // than "18.49 GiB" and "67.18 GiB".
  return gib >= 10 ? `${Math.round(gib)} GiB` : `${gib.toFixed(1)} GiB`;
}

/**
 * Build the explorer rows.
 *
 * Bundled weights sort first, because those are the four a visitor can use
 * without downloading anything, then by tier, then by size so each band reads
 * in order rather than arbitrarily.
 */
const TIER_ORDER = ['local', 'mid', 'frontier'];

export function buildRows(models) {
  return models
    .map((entry) => ({
      id: entry.id,
      bytes: entry.bytes,
      use: entry.use,
      bundled: entry.bundled === true,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      family: licenseFamily(entry.license),
      size: formatGiB(entry.bytes),
      // null is meaningful: the default tiers do not name this weight.
      tier: entry.tier ?? null,
    }))
    .sort((a, b) => {
      if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
      const at = a.tier === null ? TIER_ORDER.length : TIER_ORDER.indexOf(a.tier);
      const bt = b.tier === null ? TIER_ORDER.length : TIER_ORDER.indexOf(b.tier);
      if (at !== bt) return at - bt;
      return a.bytes - b.bytes;
    });
}

/** The summary sentence above the table, built from the data. */
export function summaryLine(rows) {
  const bundled = rows.filter((row) => row.bundled).length;
  const routed = rows.filter((row) => row.tier !== null).length;
  const onRequest = rows.length - routed;
  return (
    `${rows.length} weights, all downloadable and all free to run. ` +
    `${bundled} ship in the installer and work offline at first launch. ` +
    `${routed} are in the default tiers, and ${onRequest} are downloadable ` +
    'and selectable on request.'
  );
}

function tierCounts(rows) {
  const counts = { local: 0, mid: 0, frontier: 0, none: 0 };
  for (const row of rows) {
    if (row.tier === null) counts.none += 1;
    else counts[row.tier] += 1;
  }
  return counts;
}

const COLUMNS = ['Model', 'Tier', 'Size', 'Good for', 'Licence'];

/** Build the header row with DOM calls, never innerHTML. */
function buildHead() {
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  for (const label of COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    row.append(th);
  }
  head.append(row);
  return head;
}

function buildBody(rows) {
  const body = document.createElement('tbody');

  for (const row of rows) {
    const tr = document.createElement('tr');

    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = row.id;
    if (row.bundled) {
      const mark = document.createElement('span');
      mark.className = 'model-bundled';
      // A word, not a colour: an installed indicator has to survive a screen
      // reader and a monochrome display.
      mark.textContent = ' in the installer';
      mark.title = 'Ships with the app; no download needed at first launch';
      name.append(mark);
    }
    tr.append(name);

    const tier = document.createElement('td');
    if (row.tier === null) {
      tier.className = 'model-tier model-tier-none';
      tier.textContent = 'on request';
      tier.title = 'The default tiers do not name this weight; download and pin it yourself';
    } else {
      tier.className = `model-tier model-tier-${row.tier}`;
      tier.textContent = TIER_INFO[row.tier].label;
    }
    tr.append(tier);

    const size = document.createElement('td');
    size.className = 'model-size';
    size.textContent = row.size;
    tr.append(size);

    const use = document.createElement('td');
    use.textContent = row.use;
    tr.append(use);

    // Built with DOM APIs, so no value from the catalog can inject markup:
    // the ids, use strings, and licence URLs all come from a JSON file.
    const licence = document.createElement('td');
    const link = document.createElement('a');
    link.href = row.licenseUrl;
    link.rel = 'noopener';
    link.textContent = row.family;
    if (row.family === 'custom') {
      link.title = 'Custom licence: read it before use';
      link.className = 'model-licence-custom';
    }
    licence.append(link);
    tr.append(licence);

    body.append(tr);
  }

  return body;
}

function render() {
  const container = document.getElementById('model-table');
  if (!container) return;

  const rows = buildRows(MODELS);
  const counts = tierCounts(rows);

  const summary = document.getElementById('model-summary');
  if (summary) summary.textContent = summaryLine(rows);

  for (const tier of TIER_ORDER) {
    const el = document.getElementById(`model-count-${tier}`);
    if (el) el.textContent = String(counts[tier]);
  }
  const none = document.getElementById('model-count-none');
  if (none) none.textContent = String(counts.none);

  const table = document.createElement('table');
  table.className = 'model-table';

  const caption = document.createElement('caption');
  caption.className = 'visually-hidden';
  caption.textContent =
    'Every downloadable model weight, with the tier GearVane routes it in, ' +
    'its size, what it is good for, and its licence';
  table.append(caption, buildHead(), buildBody(rows));

  container.textContent = '';
  container.append(table);
}

if (typeof document !== 'undefined') {
  render();
}