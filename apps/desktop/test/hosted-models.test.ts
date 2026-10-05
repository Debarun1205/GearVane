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

describe('hostedModelRows', () => {
  it('lists keyless embedded rows without keys on defaults', () => {
    const rows = hostedModelRows(defaultConfig(), {});
    // Mid: 19, Frontier: 15 = 34 total
    expect(rows).toHaveLength(34);
    expect(rows.filter((row) => row.tier === 'mid')).toHaveLength(19);
    expect(rows.filter((row) => row.tier === 'frontier')).toHaveLength(15);
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
    // 19 embedded + 3 openrouter + 1 meta + 2 deepseek + 1 gemini + 1 mistral = 27
    expect(mid).toHaveLength(27);
    expect(mid.filter((row) => !row.keyless)).toHaveLength(8);
    const embedded = mid.filter((row) => row.keyless);
    expect(embedded).toHaveLength(19);
    expect(embedded.every((row) => row.keyed)).toBe(true);
    // Frontier: 15 embedded + 3 anthropic + 1 openai + 1 xai = 18? No, 5 hosted = 20
    expect(rows.filter((row) => row.tier === 'frontier')).toHaveLength(20);
    expect(rows.filter((row) => row.tier === 'frontier' && !row.keyless)).toHaveLength(5);
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