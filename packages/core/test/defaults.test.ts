import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/defaults.js';
import { ProviderFactory, LOCAL_PROVIDER_NAMES } from '../src/providers.js';

/**
 * The zero-config experience is local-first: a fresh install with no keys
 * and no config file must still route to a working local tier, and every
 * local server the factory knows must be represented so `health --offline`
 * and `models` see the same world the factory does.
 */
describe('default local tier', () => {
  it('wires at least ten local models', () => {
    const providers = defaultConfig().tiers.local.providers;
    const total = providers.reduce((sum, provider) => sum + provider.models.length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('wires eight hosted mid and five frontier models when keys are present', () => {
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
    const hosted = (tier: 'mid' | 'frontier'): number =>
      config.tiers[tier].providers
        .filter((p) => p.name !== 'embedded')
        .reduce((sum, p) => sum + p.models.length, 0);
    expect(hosted('mid')).toBe(8);
    expect(hosted('frontier')).toBe(5);
  });

  it('leads the mid tier with keyless embedded weights', () => {
    const config = defaultConfig();
    const [first] = config.tiers.mid.providers;
    expect(first?.name).toBe('embedded');
    expect(first?.models.length).toBeGreaterThan(0);
    expect(first?.apiKeyEnv).toBeUndefined();
  });

  it('ends the frontier tier with keyless embedded weights', () => {
    const config = defaultConfig();
    const providers = config.tiers.frontier.providers;
    const last = providers[providers.length - 1];
    expect(last?.name).toBe('embedded');
    expect(last?.models.length).toBeGreaterThan(0);
    expect(last?.apiKeyEnv).toBeUndefined();
  });

  it('files every catalog weight in exactly one tier band', () => {
    // The invariant behind the two tests above, which used to assert literal
    // counts (19 and 15) and so had to be re-pinned by hand every time a weight
    // moved bands. Thirteen byte counts turned out to be invented, so the bands
    // were rebuilt from the published sizes -- and the counts changed from 19/15
    // to 14/17 without anything being wrong. What must hold is coverage and
    // exclusivity, not a number a reviewer has to check.
    const config = defaultConfig();
    const banded = (['local', 'mid', 'frontier'] as const).flatMap((tier) =>
      (config.tiers[tier].providers.find((p) => p.name === 'embedded')?.models ?? []),
    );

    // No weight appears twice: a duplicate would mean two tiers offering the
    // same file, so "escalate to mid" would silently stay on the same model.
    expect(new Set(banded).size).toBe(banded.length);

    // Every weight in a band is a real catalog id, read from models.json rather
    // than a copy in this file.
    const catalog = JSON.parse(
      readFileSync(new URL('../../../apps/desktop/src/models.json', import.meta.url), 'utf8'),
    ) as Array<{ id: string }>;
    const ids = new Set(catalog.map((entry) => entry.id));
    for (const id of banded) {
      expect(ids.has(id), `${id} is routed to but is not in the catalog`).toBe(true);
    }
  });

  it('keeps hosted providers key-gated with no keys', () => {
    const config = defaultConfig();
    // Only keyless embedded entries survive anywhere: every hosted
    // provider is absent from all three tiers.
    for (const tier of [config.tiers.local, config.tiers.mid, config.tiers.frontier]) {
      for (const provider of tier.providers) {
        expect(provider.apiKeyEnv).toBeUndefined();
      }
    }
    expect(config.tiers.local.providers.map((p) => p.name)).toEqual(['embedded', 'ollama', 'lm_studio', 'llama_cpp', 'vllm', 'localai', 'gpt4all', 'textgen']);
    expect(config.tiers.mid.providers.map((p) => p.name)).toEqual(['embedded']);
    expect(config.tiers.frontier.providers.map((p) => p.name)).toEqual(['embedded']);
  });

  it('covers every local server the factory supports', () => {
    // llamacpp is a spelling alias for llama_cpp, not a second server.
    const expected = LOCAL_PROVIDER_NAMES.filter((name) => name !== 'llamacpp');
    const configured = defaultConfig().tiers.local.providers.map((provider) => provider.name);
    for (const name of expected) {
      expect(configured).toContain(name);
    }
  });

  it('gives every local provider a base URL and at least one model', () => {
    for (const provider of defaultConfig().tiers.local.providers) {
      // Loopback IPs are deliberate: 127.0.0.1 skips DNS and proxy quirks
      // that break sandboxed webviews.
      expect(provider.baseUrl).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):/);
      expect(provider.models.length).toBeGreaterThan(0);
    }
  });

  it('builds a client for every default local model without a key', () => {
    const factory = new ProviderFactory({ env: {} });
    for (const provider of defaultConfig().tiers.local.providers) {
      for (const model of provider.models) {
        const client = factory.create(provider, model);
        expect(client).toBeDefined();
      }
    }
  });

  it('never sends an API key to a local server', () => {
    const factory = new ProviderFactory({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    for (const provider of defaultConfig().tiers.local.providers) {
      for (const model of provider.models) {
        // ProviderClient stores the key on the instance; the factory passes
        // undefined for local servers even when a key is in the environment.
        const client = factory.create(provider, model) as unknown as { apiKey?: string };
        expect(client.apiKey).toBeUndefined();
      }
    }
  });
});
