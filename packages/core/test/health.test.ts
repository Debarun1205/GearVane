import { afterEach, describe, expect, it } from 'vitest';

import { HealthChecker } from '../src/health.js';
import { defaultConfig } from '../src/defaults.js';
import { setFetchImpl, type FetchLike } from '../src/providers.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(captured: Captured[]): FetchLike {
  return (async (input: string, init?: { headers?: Record<string, string> }) => {
    captured.push({ url: input, headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as FetchLike;
}

const realFetch = globalThis.fetch as FetchLike;

afterEach(() => {
  setFetchImpl(realFetch);
});

function hostedConfig(): ReturnType<typeof defaultConfig> {
  const config = defaultConfig();
  config.tiers.mid.providers = [
    { name: 'openrouter', apiKeyEnv: 'FOO_API_KEY', models: ['m'] },
  ];
  return config;
}

/**
 * Health probes must authenticate like execution does. Before the env
 * option existed, the checker built keyless clients, so a key entered in
 * the app's Keys dialog still showed every hosted model as unhealthy.
 */
describe('HealthChecker env', () => {
  it('sends the configured key on probes', async () => {
    const captured: Captured[] = [];
    setFetchImpl(stubFetch(captured));
    const checker = new HealthChecker(hostedConfig(), undefined, {
      env: { FOO_API_KEY: 'secret' },
    });

    const result = await checker.check('openrouter', 'm');

    expect(result.status).toBe('healthy');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers['Authorization']).toBe('Bearer secret');
  });

  it('probes anonymously without keys', async () => {
    const captured: Captured[] = [];
    setFetchImpl(stubFetch(captured));
    const checker = new HealthChecker(hostedConfig());

    const result = await checker.check('openrouter', 'm');

    expect(result.status).toBe('healthy');
    expect(captured[0]?.headers['Authorization']).toBeUndefined();
  });
});
