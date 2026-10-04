import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../../../packages/core/src/defaults.js';
import CATALOG from '../src/models.json';

interface CatalogEntry {
  id: string;
  file: string;
  url: string;
  bytes: number;
  use: string;
  bundled: boolean;
}

const ENTRIES = CATALOG as CatalogEntry[];

/**
 * The model catalog is the single source for the fetch script, the Models
 * dialog, and the installer payload. Every entry below was verified by
 * HEAD against its Hugging Face URL; sizes are pinned so a re-quantized
 * upstream file fails loudly instead of silently changing the installer.
 */
describe('model catalog', () => {
  it('lists eight models', () => {
    expect(ENTRIES).toHaveLength(8);
  });

  it('keeps ids unique, lowercase, and matching their file stems', () => {
    const ids = ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ENTRIES) {
      expect(entry.id).toBe(entry.id.toLowerCase());
      expect(entry.file.toLowerCase().replace(/\.gguf$/, '')).toBe(entry.id);
      expect(entry.url.startsWith('https://huggingface.co/')).toBe(true);
      expect(entry.url.endsWith(`/resolve/main/${entry.file}`)).toBe(true);
      expect(typeof entry.use).toBe('string');
    }
  });

  it('pins the verified byte sizes', () => {
    expect(Object.fromEntries(ENTRIES.map((entry) => [entry.id, entry.bytes]))).toEqual({
      'qwen2.5-coder-0.5b-instruct-q4_0': 428730240,
      'smollm2-360m-instruct.q4_k_m': 270590592,
      'qwen2.5-1.5b-instruct-q4_0': 1066227232,
      'llama-3.2-1b-instruct-q4_k_m': 807694464,
      'llama-3.2-3b-instruct-q4_k_m': 2019377696,
      'gemma-2-2b-it-q4_k_m': 1708582752,
      'deepseek-r1-distill-qwen-1.5b-q4_k_m': 1117320800,
      'qwen2.5-coder-1.5b-instruct-q4_0': 1066227264,
    });
  });

  it('flags exactly the two bundled weights', () => {
    expect(ENTRIES.filter((entry) => entry.bundled).map((entry) => entry.id)).toEqual([
      'qwen2.5-coder-0.5b-instruct-q4_0',
      'smollm2-360m-instruct.q4_k_m',
    ]);
  });

  it('covers every model the defaults route to on embedded', () => {
    // Otherwise the router names an id the dialog never heard of, and a
    // first attempt fails before failover even though the fix is a click.
    const ids = new Set(ENTRIES.map((entry) => entry.id));
    const embedded = defaultConfig().tiers.local.providers.find((p) => p.name === 'embedded');
    expect(embedded).toBeDefined();
    for (const model of embedded?.models ?? []) {
      expect(ids.has(model)).toBe(true);
    }
  });
});
