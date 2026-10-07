import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultConfig } from '@gearvane/core';
import CATALOG from '../apps/desktop/src/models.json';

const REPO = join(import.meta.dirname, '..');

interface CatalogEntry {
  id: string;
  file: string;
  url: string;
  bytes: number;
  use: string;
  license: string;
}

const entries = CATALOG as CatalogEntry[];

/** The tier lists the router ships with, per tier. */
function embeddedByTier(): Record<string, string[]> {
  const config = defaultConfig();
  const out: Record<string, string[]> = { local: [], mid: [], frontier: [] };
  for (const tier of ['local', 'mid', 'frontier'] as const) {
    const provider = config.tiers[tier].providers.find((p) => p.name === 'embedded');
    out[tier] = provider?.models ?? [];
  }
  return out;
}

describe('site tier bands', () => {
  // The site labels every weight with a tier. That is only honest while the
  // label matches what the router actually does, so the generated data is
  // compared against the live configuration rather than trusted.
  //
  // This is also the cheapest possible version of B5. Tiers are currently a
  // reasonable ordering rather than a measured one, and this test is what
  // keeps that visible: re-tier a weight by hand, and the site follows or the
  // build fails.
  it('labels every weight with the tier the router gives it', async () => {
    const generated = await import('../site/assets/catalog-data.js');
    const assigned = embeddedByTier();

    const mismatches: string[] = [];
    for (const row of generated.MODELS) {
      const routed = (['local', 'mid', 'frontier'] as const).filter((t) =>
        assigned[t].includes(row.id),
      );
      if (routed.length === 0) {
        // Not named by any default tier: the site must say "on request" and
        // invent nothing.
        if (row.tier !== null) {
          mismatches.push(`${row.id}: in no default tier but labelled ${row.tier}`);
        }
        continue;
      }
      if (!routed.includes(row.tier as 'local')) {
        mismatches.push(
          `${row.id}: router says ${routed.join('/')}, site says ${String(row.tier)}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('has no duplicate id or file', () => {
    // B3. The catalog is generated into three surfaces -- the site table, the
    // README table, and THIRD_PARTY_NOTICES -- all keyed by id, so a duplicate
    // is not a cosmetic problem: it silently merges two weights into one row
    // in every one of them.
    const ids = new Set<string>();
    const files = new Set<string>();
    const dupes: string[] = [];
    for (const entry of entries) {
      if (ids.has(entry.id)) dupes.push(`id ${entry.id}`);
      if (files.has(entry.file)) dupes.push(`file ${entry.file}`);
      ids.add(entry.id);
      files.add(entry.file);
    }
    expect(dupes).toEqual([]);
    expect(entries).toHaveLength(50);
  });

  it('gives every weight a size, a use and a licence', () => {
    for (const entry of entries) {
      expect(entry.bytes, `${entry.id} has no size`).toBeGreaterThan(0);
      expect(entry.use, `${entry.id} has no use`).toBeTruthy();
      expect(entry.license, `${entry.id} has no licence`).toBeTruthy();
      expect(entry.url, `${entry.id} has no url`).toMatch(/^https:\/\//);
    }
  });

  it('never labels a weight the router does not name', async () => {
    // The inverse failure: a weight sitting in no tier must not be given one,
    // because that is a classification the app does not perform.
    const generated = await import('../site/assets/catalog-data.js');
    const assigned = new Set(Object.values(embeddedByTier()).flat());
    const invented = generated.MODELS.filter(
      (row: { id: string; tier: string | null }) =>
        !assigned.has(row.id) && row.tier !== null,
    );

    expect(invented.map((r: { id: string }) => r.id)).toEqual([]);
  });

  it('carries a licence and link for every weight', async () => {
    const generated = await import('../site/assets/catalog-data.js');
    for (const row of generated.MODELS) {
      expect(row.license, `${row.id} has no licence`).toBeTruthy();
      expect(row.licenseUrl, `${row.id} has no licence URL`).toMatch(/^https:\/\//);
    }
  });

  it('regenerates byte-identically, so --check can gate CI', async () => {
    const { execFileSync } = await import('node:child_process');
    // The generator exits non-zero when the committed file is stale, which is
    // the whole point of committing generated output into a no-build site.
    expect(() =>
      execFileSync('node', [join(REPO, 'tools', 'gen-site-catalog.mjs'), '--check'], {
        cwd: REPO,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('names a real tier for every bundled weight', async () => {
    const generated = await import('../site/assets/catalog-data.js');
    const bundled = generated.MODELS.filter((r: { bundled: boolean }) => r.bundled);

    // Only smollm2-360m is bundled now (shipped in installer)
    expect(bundled).toHaveLength(1);
    expect(bundled[0].id).toBe('smollm2-360m-instruct.q4_k_m');
    expect(bundled[0].tier).not.toBeNull();
  });
});
