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
  it('is empty without keys on defaults except keyless embedded', () => {
    const rows = hostedModelRows(defaultConfig(), {});
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.tier === 'mid' && row.keyless && row.keyed)).toBe(true);
  });

  it('lists eight hosted mid and five frontier rows with keys, plus keyless embedded', () => {
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
    expect(mid).toHaveLength(13);
    expect(mid.filter((row) => !row.keyless)).toHaveLength(8);
    const embedded = mid.filter((row) => row.keyless);
    expect(embedded).toHaveLength(5);
    expect(embedded.every((row) => row.keyed)).toBe(true);
    expect(rows.filter((row) => row.tier === 'frontier')).toHaveLength(5);
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
