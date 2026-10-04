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
  it('lists thirty-five models', () => {
    expect(ENTRIES).toHaveLength(35);
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
      'qwen2.5-coder-3b-instruct-q4_0': 1997879744,
      'smollm2-1.7b-instruct.q4_k_m': 1055609536,
      'qwen3-0.6b.q4_k_m': 484220000,
      'tinyllama-1.1b-chat-v1.0.q4_k_m': 668788096,
      'deepseek-coder-1.3b-instruct.q4_k_m': 873582624,
      'falcon3-3b-instruct-q4_k_m': 2005684448,
      'phi-3-mini-4k-instruct-q4': 2393231072,
      'qwen2.5-3b-instruct-q4_0': 1997879712,
      'qwen2.5-0.5b-instruct-q4_0': 428730208,
      'qwen2.5-7b-instruct-q4_k_m': 4683074240,
      'mistral-7b-instruct-v0.3-q4_k_m': 4372812000,
      'deepseek-r1-distill-qwen-7b-q4_k_m': 4683073504,
      'falcon3-7b-instruct-q4_k_m': 4569726368,
      'qwen2.5-coder-7b-instruct-q4_0': 4431390720,
      'falcon3-1b-instruct-q4_k_m': 1057044608,
      'qwen3-1.7b.q4_k_m': 1282439264,
      'starcoder2-7b-q4_k_m': 4402887488,
      'qwen3-4b.q4_k_m': 2716068512,
      'starcoder2-3b-q4_k_m': 1848976448,
      'qwen2.5-14b-instruct-q4_k_m': 8988110976,
      'deepseek-r1-distill-qwen-14b-q4_k_m': 8988110240,
      'mistral-nemo-instruct-2407-q4_k_m': 7477208192,
      'falcon3-10b-instruct-q4_k_m': 6287521408,
      'qwen2.5-coder-14b-instruct-q4_k_m': 8988111072,
      'qwen3-8b.q4_k_m': 5027783872,
      'starcoder2-15b-q4_k_m': 9860188000,
      'phi-4-q4_k': 9053114560,
    });
  });

  it('flags exactly the four bundled weights', () => {
    expect(ENTRIES.filter((entry) => entry.bundled).map((entry) => entry.id)).toEqual([
      'qwen2.5-coder-0.5b-instruct-q4_0',
      'smollm2-360m-instruct.q4_k_m',
      'qwen2.5-7b-instruct-q4_k_m',
      'qwen3-8b.q4_k_m',
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
