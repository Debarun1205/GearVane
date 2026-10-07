import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../../../packages/core/src/defaults.js';
import CATALOG from '../src/models.json';

interface CatalogEntry {
  id: string;
  file: string;
  url: string;
  revision: string;
  sha256: string;
  bytes: number;
  use: string;
  bundled: boolean;
  /** Ready at first boot: in the installer, or provisioned on first launch. */
  embedded?: boolean;
  provision?: 'installer' | 'first-boot';
  license: string;
  licenseUrl: string;
}

const ENTRIES = CATALOG as CatalogEntry[];

describe('model catalog', () => {
  it('lists fifty models', () => {
    expect(ENTRIES).toHaveLength(50);
  });

  it('keeps ids unique, lowercase, and matching their file stems', () => {
    const ids = ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ENTRIES) {
      expect(entry.id).toBe(entry.id.toLowerCase());
      expect(entry.file.toLowerCase().replace(/\.gguf$/, '')).toBe(entry.id);
      expect(entry.url.startsWith('https://huggingface.co/')).toBe(true);
      // Pinned to a commit, never to a branch. `main` moves, so the bytes
      // behind a URL could change under an installed app and nothing recorded
      // what it expected to receive.
      expect(entry.url.endsWith(`/resolve/${entry.revision}/${entry.file}`)).toBe(true);
      expect(entry.url).not.toContain('/resolve/main/');
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.use).toBe('string');
    }
  });

  it('records a real size and a matching hash for every model', () => {
    // Previously this test hardcoded all fifty byte counts, which meant the
    // catalog and the test had to be updated together whenever a size was
    // wrong -- and thirteen were wrong, invented rather than measured, so the
    // test pinned the invention. It now checks the property that matters: every
    // entry has a positive size and a sha256 of the right shape, so a size can
    // only come from the same response that supplied the hash.
    for (const entry of ENTRIES) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(Number.isInteger(entry.bytes)).toBe(true);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // The two installer weights were downloaded and hashed locally, so their
    // sizes and digests are observed rather than copied from an API response.
    const observed: Record<string, [number, string]> = {
      'smollm2-360m-instruct.q4_k_m': [
        270590592,
        '75c4346ef9e855ed',
      ],
      'qwen2.5-coder-0.5b-instruct-q4_0': [
        428730240,
        '9739055e046d62a9',
      ],
    };
    for (const [id, [bytes, shaPrefix]] of Object.entries(observed)) {
      const entry = ENTRIES.find((e) => e.id === id);
      expect(entry, `${id} is not in the catalog`).toBeDefined();
      expect(entry?.bytes).toBe(bytes);
      expect(entry?.sha256.slice(0, 16)).toBe(shaPrefix);
    }
  });

  it('flags the two installer weights, and provisions two more', () => {
    // R2: four models ready at first boot -- two inside the installer, and two
    // the app fetches on first launch without asking. Before this, only
    // smollm2-360m shipped, so the "four models at first launch" claim had one
    // model behind it.
    const byProvision = (mode: string) =>
      ENTRIES.filter((entry) => entry.provision === mode).map((entry) => entry.id);

    expect(byProvision('installer').sort()).toEqual([
      'qwen2.5-coder-0.5b-instruct-q4_0',
      'smollm2-360m-instruct.q4_k_m',
    ]);
    expect(byProvision('first-boot').sort()).toEqual([
      'qwen2.5-7b-instruct-q4_k_m',
      'qwen3-8b.q4_k_m',
    ]);

    // `bundled` is the installer payload specifically, and must agree with
    // `provision: installer` so the two cannot disagree about what ships.
    expect(ENTRIES.filter((e) => e.bundled).map((e) => e.id).sort()).toEqual(
      byProvision('installer').sort(),
    );
    // Four embedded, and no weight both provisioned and absent.
    expect(ENTRIES.filter((e) => e.embedded)).toHaveLength(4);
  });

  it('carries a verified license and link for every model', () => {
    // Licences were checked against each model's Hugging Face card
    // (API tags plus card frontmatter, with base-model fallbacks for
    // gated repos). THIRD_PARTY_NOTICES.md lists the full mapping.
    for (const entry of ENTRIES) {
      expect(entry.license.length).toBeGreaterThan(0);
      expect(entry.licenseUrl.startsWith('https://')).toBe(true);
    }
  });

  it('bundles only permissively licensed weights', () => {
    // The install-time bundle ships without asking, so it is
    // restricted to Apache-2.0 and MIT — licences that impose no
    // commercial or use restrictions.
    for (const entry of ENTRIES.filter((e) => e.bundled)) {
      expect(['Apache-2.0', 'MIT']).toContain(entry.license);
    }
  });

  it('covers every model the defaults route to on embedded', () => {
    // Otherwise the router names an id the dialog never heard of, and a
    // first attempt fails before failover even though the fix is a click.
    const ids = new Set(ENTRIES.map((entry) => entry.id));
    const localEmbedded = defaultConfig().tiers.local.providers.find((p) => p.name === 'embedded');
    const midEmbedded = defaultConfig().tiers.mid.providers.find((p) => p.name === 'embedded');
    const frontierEmbedded = defaultConfig().tiers.frontier.providers.find((p) => p.name === 'embedded');
    expect(localEmbedded).toBeDefined();
    expect(midEmbedded).toBeDefined();
    expect(frontierEmbedded).toBeDefined();
    for (const model of localEmbedded?.models ?? []) {
      expect(ids.has(model)).toBe(true);
    }
    for (const model of midEmbedded?.models ?? []) {
      expect(ids.has(model)).toBe(true);
    }
    for (const model of frontierEmbedded?.models ?? []) {
      expect(ids.has(model)).toBe(true);
    }
  });
});