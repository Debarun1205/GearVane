import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../../../packages/core/src/defaults.js';

import { hostedModelRows, keyStateFor } from '../src/hosted-models.js';

describe('keyStateFor', () => {
  it('accepts the declared variable and the NAME_API_KEY convention', () => {
    expect(keyStateFor({ name: 'openrouter' }, { OPENROUTER_API_KEY: 'x' })).toBe(true);
    expect(
      keyStateFor({ name: 'meta', apiKeyEnv: 'MODEL_API_KEY' }, { MODEL_API_KEY: 'x' }),
    ).toBe(true);
    expect(keyStateFor({ name: 'openrouter' }, {})).toBe(false);
    expect(keyStateFor({ name: 'openrouter' }, { OTHER_KEY: 'x' })).toBe(false);
  });
});

/**
 * How many embedded models each tier's config declares.
 *
 * Read from the config rather than written as literals: the previous version
 * hardcoded 19 and 15, which is what made the tier repair look like a
 * regression when it was the arithmetic catching up. A test that pins counts
 * must be re-pinned by hand every time a weight moves bands, and the last time
 * that happened the count was updated without checking where the models went.
 */
function embeddedCount(config: ReturnType<typeof defaultConfig>): number {
  return (['mid', 'frontier'] as const).reduce((total, tier) => {
    const provider = config.tiers[tier].providers.find((p) => p.name === 'embedded');
    return total + (provider?.models.length ?? 0);
  }, 0);
}

describe('hostedModelRows', () => {
  it('lists keyless embedded rows without keys on defaults', () => {
    const config = defaultConfig();
    const rows = hostedModelRows(config, {});
    const expected = embeddedCount(config);
    // Mid: 14, Frontier: 17 = 31 total, after each weight was filed under its
    // published size rather than its old estimate.
    expect(rows).toHaveLength(expected);
    expect(rows.filter((row) => row.tier === 'mid')).toHaveLength(
      config.tiers.mid.providers.find((p) => p.name === 'embedded')?.models.length,
    );
    expect(rows.filter((row) => row.tier === 'frontier')).toHaveLength(
      config.tiers.frontier.providers.find((p) => p.name === 'embedded')?.models.length,
    );
    expect(rows.every((row) => row.keyless && row.keyed)).toBe(true);
  });

  it('lists hosted providers with keys, plus keyless embedded', () => {
    const config = defaultConfig({
      OPENROUTER_API_KEY: 'x',
      MODEL_API_KEY: 'x',
      DEEPSEEK_API_KEY: 'x',
      GEMINI_API_KEY: 'x',
      MISTRAL_API_KEY: 'x',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      XAI_API_KEY: 'x',
    });
    const keys = {
      OPENROUTER_API_KEY: 'x',
      MODEL_API_KEY: 'x',
      DEEPSEEK_API_KEY: 'x',
      GEMINI_API_KEY: 'x',
      MISTRAL_API_KEY: 'x',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      XAI_API_KEY: 'x',
    };
    const rows = hostedModelRows(config, keys);
    const mid = rows.filter((row) => row.tier === 'mid');
    const frontier = rows.filter((row) => row.tier === 'frontier');
    // 14 embedded + 3 openrouter + 1 meta + 2 deepseek + 1 gemini + 1 mistral = 22
    expect(mid).toHaveLength(22);
    expect(mid.filter((row) => !row.keyless)).toHaveLength(8);
    const embedded = mid.filter((row) => row.keyless);
    expect(embedded).toHaveLength(14);
    expect(embedded.every((row) => row.keyed)).toBe(true);
    // Frontier: 17 embedded + 3 anthropic + 1 openai + 1 xai = 22
    expect(frontier).toHaveLength(22);
    expect(frontier.filter((row) => !row.keyless)).toHaveLength(5);
    expect(rows.every((row) => row.keyed)).toBe(true);
    expect(rows[0]?.label).toMatch(/\//);
  });

  it('marks rows without vault keys as missing, except keyless embedded', () => {
    const config = defaultConfig({ OPENROUTER_API_KEY: 'env-only' });
    const rows = hostedModelRows(config, {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !row.keyless).every((row) => !row.keyed)).toBe(true);
    expect(rows.filter((row) => row.keyless).length).toBeGreaterThan(0);
  });
});