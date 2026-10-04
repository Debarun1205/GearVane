import { describe, expect, it } from 'vitest';

import {
  CompletionCache,
  GHOST_MAX_TOKENS,
  MAX_CONSECUTIVE_FAILURES,
  MIN_LINE_CHARS,
  buildFimRequest,
  fetchCompletion,
  parseFimResponse,
  resolveInlineModel,
  shouldComplete,
} from '../src/ide/inline-complete.js';
import type { GearVaneConfig } from '@gearvane/core';

/**
 * Inline completion tests.
 *
 * Everything here is pure or takes its I/O as arguments, which is why this
 * file can execute rather than guard at the source level. The Monaco provider
 * registration itself needs a real editor, so that half stays in
 * ide-agent.test.ts as source guards.
 */

function configWithLocal(
  providers: Array<{ name: string; models: string[]; baseUrl?: string }>,
): GearVaneConfig {
  return {
    tiers: {
      local: {
        name: 'local',
        description: '',
        providers: providers as GearVaneConfig['tiers']['local']['providers'],
        maxRetries: 2,
        costPerToken: 0,
      },
    },
  } as GearVaneConfig;
}

describe('resolveInlineModel', () => {
  it('picks the first model of the first Ollama provider', () => {
    const resolved = resolveInlineModel(
      configWithLocal([
        { name: 'ollama', models: ['qwen2.5-coder:1.5b', 'llama3.2'] },
      ]),
    );
    expect(resolved).toEqual({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:1.5b',
    });
  });

  it('prefers an explicit base URL over the default', () => {
    const resolved = resolveInlineModel(
      configWithLocal([
        { name: 'ollama', models: ['m'], baseUrl: 'http://gpu-box:11434/' },
      ]),
    );
    expect(resolved?.baseUrl).toBe('http://gpu-box:11434');
  });

  it('skips providers with no models', () => {
    const resolved = resolveInlineModel(
      configWithLocal([
        { name: 'ollama', models: [] },
        { name: 'ollama', models: ['fallback'] },
      ]),
    );
    expect(resolved?.model).toBe('fallback');
  });

  it('returns undefined with no local providers', () => {
    expect(resolveInlineModel(configWithLocal([]))).toBeUndefined();
  });

  it('returns undefined when only hosted providers exist', () => {
    // Hosted completion per keystroke would bill the user for typing. The
    // caller disables ghost text instead of offering that.
    const config = {
      tiers: {
        mid: {
          name: 'mid',
          description: '',
          providers: [{ name: 'openrouter', models: ['m'] }],
          maxRetries: 2,
          costPerToken: 0.0001,
        },
      },
    } as unknown as GearVaneConfig;
    expect(resolveInlineModel(config)).toBeUndefined();
  });

  it('ignores non-Ollama local servers', () => {
    // LM Studio has no /api/generate endpoint, so resolving it would produce
    // a provider that 404s on every keystroke.
    const resolved = resolveInlineModel(
      configWithLocal([{ name: 'lm_studio', models: ['m'] }]),
    );
    expect(resolved).toBeUndefined();
  });
});

describe('shouldComplete', () => {
  it('fires on real code', () => {
    expect(shouldComplete('  const x')).toBe(true);
  });

  it('stays quiet on short stubs', () => {
    expect(shouldComplete('')).toBe(false);
    expect(shouldComplete('x')).toBe(false);
    expect(shouldComplete('  ')).toBe(false);
  });

  it('stays quiet after trailing whitespace', () => {
    // The user just hit space or tab: completing now would suggest over their
    // own indentation.
    expect(shouldComplete('const x = ')).toBe(false);
  });

  it(`uses a documented minimum of ${MIN_LINE_CHARS} characters`, () => {
    expect(shouldComplete('x'.repeat(MIN_LINE_CHARS))).toBe(true);
    expect(shouldComplete('x'.repeat(MIN_LINE_CHARS - 1))).toBe(false);
  });
});

describe('buildFimRequest', () => {
  const inline = { baseUrl: 'http://localhost:11434', model: 'm' };

  it('targets the generate endpoint with prefix and suffix', () => {
    const request = buildFimRequest(inline, 'const a =', ';\nconst b = 2;');
    expect(request.url).toBe('http://localhost:11434/api/generate');
    expect(request.body).toMatchObject({
      model: 'm',
      prompt: 'const a =',
      suffix: ';\nconst b = 2;',
      stream: false,
    });
  });

  it('caps context on both sides', () => {
    const request = buildFimRequest(inline, 'p'.repeat(9000), 's'.repeat(9000));
    const body = request.body as { prompt: string; suffix: string };
    expect(body.prompt).toHaveLength(4000);
    expect(body.suffix).toHaveLength(2000);
  });

  it('keeps ghosts short with low temperature', () => {
    const request = buildFimRequest(inline, 'a', 'b');
    const options = (request.body as { options: Record<string, unknown> }).options;
    expect(options['num_predict']).toBe(GHOST_MAX_TOKENS);
    expect(options['temperature']).toBe(0.2);
  });
});

describe('parseFimResponse', () => {
  it('returns the text', () => {
    expect(parseFimResponse({ response: ' 1;' })).toBe(' 1;');
  });

  it('preserves leading indentation', () => {
    // Leading space is usually indentation; stripping it misaligns the ghost.
    expect(parseFimResponse({ response: '    return x;' })).toBe('    return x;');
  });

  it('strips trailing whitespace', () => {
    expect(parseFimResponse({ response: 'x;\n  ' })).toBe('x;');
  });

  it('returns undefined for empty or missing text', () => {
    expect(parseFimResponse({ response: '' })).toBeUndefined();
    expect(parseFimResponse({ response: '   ' })).toBeUndefined();
    expect(parseFimResponse({})).toBeUndefined();
    expect(parseFimResponse(null)).toBeUndefined();
    expect(parseFimResponse('just a string')).toBeUndefined();
  });
});

describe('fetchCompletion', () => {
  const request = {
    url: 'http://localhost:11434/api/generate',
    body: { model: 'm' },
  };

  it('posts JSON and parses the ghost', async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ response: ' ghost' }), { status: 200 });
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>)['fetch'] = fetch;
    try {
      const ghost = await fetchCompletion(request, new AbortController().signal);
      expect(ghost).toBe(' ghost');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws a short error on non-2xx, not the body', async () => {
    const fetch = async () =>
      new Response('<html>proxy error page</html>', { status: 502 });
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>)['fetch'] = fetch;
    try {
      await expect(
        fetchCompletion(request, new AbortController().signal),
      ).rejects.toThrow('502');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('returns undefined on abort instead of throwing', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = async (_url: unknown, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response('{}', { status: 200 });
    };
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>)['fetch'] = fetch;
    try {
      await expect(fetchCompletion(request, controller.signal)).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('CompletionCache', () => {
  it('returns what was stored for the exact pair', () => {
    const cache = new CompletionCache();
    cache.set('prefix', 'suffix', 'ghost');
    expect(cache.get('prefix', 'suffix')).toBe('ghost');
  });

  it('misses on a different pair', () => {
    const cache = new CompletionCache();
    cache.set('prefix', 'suffix', 'ghost');
    expect(cache.get('prefix!', 'suffix')).toBeUndefined();
  });

  it('evicts the oldest entry past the bound', () => {
    const cache = new CompletionCache(2);
    cache.set('a', '', '1');
    cache.set('b', '', '2');
    cache.set('c', '', '3');
    expect(cache.size).toBe(2);
    expect(cache.get('a', '')).toBeUndefined();
    expect(cache.get('c', '')).toBe('3');
  });
});

describe('failure budget', () => {
  it('documents the give-up threshold', () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
  });
});
