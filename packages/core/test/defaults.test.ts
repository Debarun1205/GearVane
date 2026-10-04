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

  it('wires eight mid and five frontier models when keys are present', () => {
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
    const mid = config.tiers.mid.providers.reduce((sum, p) => sum + p.models.length, 0);
    const frontier = config.tiers.frontier.providers.reduce((sum, p) => sum + p.models.length, 0);
    expect(mid).toBe(8);
    expect(frontier).toBe(5);
  });

  it('stays local-only with no keys', () => {
    const config = defaultConfig();
    expect(config.tiers.mid.providers).toEqual([]);
    expect(config.tiers.frontier.providers).toEqual([]);
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
