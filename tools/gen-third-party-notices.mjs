#!/usr/bin/env node
/**
 * Regenerate THIRD_PARTY_NOTICES.md from the model catalog.
 *
 * The notices file is the legal record of which weight comes from where and
 * under what terms. It was hand-maintained and had drifted to the point of
 * being useless: it named seven repositories that return 401 or do not contain
 * the file, quoted thirteen byte counts that disagreed with the published
 * size, and listed ids the catalog no longer has. A notices file that describes
 * weights nobody downloads is worse than none, because it looks authoritative.
 *
 * Generated from models.json, so it cannot describe a weight the app does not
 * offer. The prose is fixed; only the tables and counts move.
 *
 * Usage:
 *   node tools/gen-third-party-notices.mjs           # write
 *   node tools/gen-third-party-notices.mjs --check   # fail if out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TARGET = join(ROOT, 'THIRD_PARTY_NOTICES.md');

const GIB = 1073741824;
/** Licences with no use restriction, attribution duty or extra terms. */
const PERMISSIVE = new Set(['Apache-2.0', 'MIT']);

/**
 * Repositories that publish no `cardData.license`.
 *
 * A quantisation does not change the terms, so for these the licence is the
 * base model's -- which was confirmed against that base model's own repository,
 * not assumed. Listed here because "the repository says nothing" and "the
 * repository says Apache-2.0" are different facts about a weight, and a reader
 * deciding whether to run something is entitled to both.
 */
const LICENCE_FROM_BASE = {
  'bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B (MIT)',
  'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B (MIT)',
  'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B (MIT)',
  'bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B (MIT)',
  'tiiuae/Falcon3-1B-Instruct-GGUF': 'tiiuae/Falcon3-1B-Instruct (TII Falcon-LLM License 2.0)',
  'tiiuae/Falcon3-7B-Instruct-GGUF': 'tiiuae/Falcon3-7B-Instruct (TII Falcon-LLM License 2.0)',
  'tiiuae/Falcon3-10B-Instruct-GGUF': 'tiiuae/Falcon3-10B-Instruct (TII Falcon-LLM License 2.0)',
};

/**
 * Display names for the licences the catalog uses.
 *
 * The catalog stores whatever Hugging Face's `cardData.license` returned, which
 * mixes SPDX identifiers ('Apache-2.0') with platform keys ('gemma',
 * 'llama3.1') and prose ('TII Falcon-LLM License 2.0'). An unlisted licence
 * falls through to its own name, which is still a link to the terms.
 */
const LICENCE_NAMES = {
  'BigCode OpenRAIL-M': 'BigCode OpenRAIL-M',
  'DeepSeek Model License': 'DeepSeek Model License',
  'Gemma License': 'Gemma Terms of Use',
  'Llama 3.2 Community License': 'Llama 3.2 Community License',
  'Qwen Research License': 'Qwen Research License',
  'TII Falcon-LLM License 2.0': 'TII Falcon-LLM License 2.0',
  // Quoted: a bare `llama3.1` is a syntax error, not a key.
  gemma: 'Gemma Terms of Use',
  'llama3.1': 'Llama 3.1 Community License',
  'llama3.2': 'Llama 3.2 Community License',
  'llama3.3': 'Llama 3.3 Community License',
  other: 'Other terms',
};

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/src/models.json'), 'utf8'),
);

/** The `owner/name` segment of a resolve URL. */
function repoOf(url) {
  return /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\//.exec(url)?.[1] ?? '(unknown)';
}

/** Two decimals, because a weight's size decides whether a machine holds it. */
const gib = (bytes) => `${(bytes / GIB).toFixed(2)} GiB`;

function rowsFor(entries) {
  return [...entries]
    .sort((a, b) => a.bytes - b.bytes)
    .map((entry) => {
      const repo = repoOf(entry.url);
      return `| \`${entry.id}\` | [\`${repo}\`](https://huggingface.co/${repo}) | ${gib(
        entry.bytes,
      )} |`;
    });
}

const permissive = catalog.filter((e) => PERMISSIVE.has(e.license));
const restricted = catalog.filter((e) => !PERMISSIVE.has(e.license));

const lines = [
  '# Third-party notices',
  '',
  'GearVane is MIT licensed. **Model weights are not.** Each keeps its own',
  'terms, and running one is a decision you make about your own machine.',
  '',
  'This file is generated from `apps/desktop/src/models.json` by',
  '`tools/gen-third-party-notices.mjs`. Do not edit it by hand: a weight added',
  'to the catalog without appearing here, or a notice for a weight the catalog',
  'no longer offers, is exactly the drift this file exists to remove.',
  '',
  `## ${permissive.length} weights under Apache-2.0 or MIT`,
  '',
  'These are the permissive licences: no use restriction, no attribution duty,',
  'no extra terms. Every weight the installer ships, and every weight the app',
  'provisions on first launch, is one of these.',
  '',
  '| Model | Repository | Size |',
  '| --- | --- | --- |',
  ...rowsFor(permissive),
  '',
  ...(() => {
    // Provenance, stated once for the permissive set. The restricted licences
    // below each name their own, because there the reader has to go and read
    // something; here it is one sentence so the claim is still auditable.
    const fromBase = permissive.filter((e) => LICENCE_FROM_BASE[repoOf(e.url)]);
    if (fromBase.length === 0) return [];
    return [
      `${fromBase.length} of these come from a repository that publishes no licence of`,
      "its own; their terms are the base model's, confirmed against the base model",
      'repository rather than assumed:',
      '',
      ...fromBase.map(
        (e) => `- \`${e.id}\` — ${LICENCE_FROM_BASE[repoOf(e.url)]}`,
      ),
      '',
    ];
  })(),
  '',
  `## ${restricted.length} weights under other terms`,
  '',
  'Each of these is download-on-request only: none ships in the installer and',
  'none is provisioned automatically. Read the licence before use. Some',
  'restrict commercial use, require attribution, or add terms of their own.',
  '',
  '| Model | Repository | Size |',
  '| --- | --- | --- |',
  ...rowsFor(restricted),
  '',
  '## Licences in full',
  '',
];

// Grouped by licence so a reader can go from a weight to its terms without a
// lookup across 19 rows.
const byLicence = new Map();
for (const entry of restricted) {
  if (!byLicence.has(entry.license)) byLicence.set(entry.license, []);
  byLicence.get(entry.license).push(entry);
}

for (const licence of [...byLicence.keys()].sort()) {
  const entries = byLicence.get(licence);
  lines.push(`### ${LICENCE_NAMES[licence] ?? licence}`);
  lines.push('');
  lines.push(`- ${entries[0].licenseUrl}`);
  lines.push('');
  lines.push(
    `Applies to ${entries.length} weight${entries.length === 1 ? '' : 's'} in the catalog.`,
  );
  lines.push('');

  // Name the weights whose licence came from the base model, so the source of
  // the claim is visible rather than assumed.
  const fromBase = entries.filter((e) => LICENCE_FROM_BASE[repoOf(e.url)]);
  if (fromBase.length > 0) {
    lines.push(
      `${fromBase.length} of these come from a repository that publishes no ` +
        'licence of its own. Their terms are the base model' +
        `${fromBase.length === 1 ? "'s" : "s"}, confirmed against the base ` +
        'model repository:',
    );
    lines.push('');
    for (const entry of fromBase) {
      lines.push(`- \`${entry.id}\` — ${LICENCE_FROM_BASE[repoOf(entry.url)]}`);
    }
    lines.push('');
  }

  lines.push('| Model | Repository | Size |');
  lines.push('| --- | --- | --- |');
  lines.push(...rowsFor(entries));
  lines.push('');
}

const output = lines.join('\n');

if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  if (current !== output) {
    process.stderr.write(
      'THIRD_PARTY_NOTICES.md is out of date.\nRun: node tools/gen-third-party-notices.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `third-party notices OK: ${catalog.length} weights, ${byLicence.size} licences\n`,
  );
} else {
  writeFileSync(TARGET, output);
  process.stdout.write(
    `THIRD_PARTY_NOTICES.md rewritten: ${permissive.length} permissive, ` +
      `${restricted.length} restricted, ${byLicence.size} licences\n`,
  );
}
