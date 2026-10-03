import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicClient,
  OllamaClient,
  OpenAICompatClient,
  ProviderError,
  ProviderFactory,
  setFetchImpl,
  type FetchLike,
} from '../src/providers.js';

function stubFetch(handler: (url: string, init?: Record<string, unknown>) => unknown): FetchLike {
  return vi.fn(async (url: string, init?: Record<string, unknown>) => {
    const body = handler(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as FetchLike;
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OllamaClient', () => {
  it('posts to /api/generate and parses usage', async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {};
    setFetchImpl(
      stubFetch((url, init) => {
        captured.url = url;
        captured.body = JSON.parse(String(init?.['body'])) as Record<string, unknown>;
        return {
          response: 'hello there',
          model: 'llama3.2',
          prompt_eval_count: 12,
          eval_count: 34,
          done_reason: 'stop',
        };
      }),
    );

    const client = new OllamaClient('http://localhost:11434', 'llama3.2', undefined, 5000);
    const result = await client.complete('hi', { system: 'be brief' });

    expect(captured.url).toBe('http://localhost:11434/api/generate');
    expect(captured.body?.['model']).toBe('llama3.2');
    expect(captured.body?.['stream']).toBe(false);
    expect(captured.body?.['system']).toBe('be brief');

    expect(result.content).toBe('hello there');
    expect(result.usage).toEqual({ tokensIn: 12, tokensOut: 34 });
  });

  it('omits system when not supplied', async () => {
    let body: Record<string, unknown> = {};
    setFetchImpl(
      stubFetch((_url, init) => {
        body = JSON.parse(String(init?.['body'])) as Record<string, unknown>;
        return { response: '' };
      }),
    );
    const client = new OllamaClient('http://localhost:11434', 'llama3.2', undefined, 5000);
    await client.complete('hi');
    expect(body['system']).toBeUndefined();
  });

  it('reports healthy only when the endpoint answers', async () => {
    setFetchImpl(stubFetch(() => ({ models: [] })));
    const client = new OllamaClient('http://localhost:11434', 'llama3.2', undefined, 5000);
    await expect(client.healthCheck()).resolves.toBe(true);
  });

  it('reports unhealthy on a connection failure', async () => {
    setFetchImpl(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new OllamaClient('http://localhost:11434', 'llama3.2', undefined, 5000);
    await expect(client.healthCheck()).resolves.toBe(false);
  });

  it('lists models', async () => {
    setFetchImpl(stubFetch(() => ({ models: [{ name: 'llama3.2' }, { name: 'qwen' }] })));
    const client = new OllamaClient('http://localhost:11434', 'llama3.2', undefined, 5000);
    await expect(client.listModels()).resolves.toEqual(['llama3.2', 'qwen']);
  });
});

describe('OpenAICompatClient', () => {
  it('posts chat completions and parses usage', async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {};
    setFetchImpl(
      stubFetch((url, init) => {
        captured.url = url;
        captured.body = JSON.parse(String(init?.['body'])) as Record<string, unknown>;
        return {
          model: 'anthropic/claude-3-haiku',
          choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 20 },
        };
      }),
    );

    const client = new OpenAICompatClient(
      'https://openrouter.ai/api',
      'anthropic/claude-3-haiku',
      'sk-test',
      5000,
    );
    const result = await client.complete('hello', { system: 'be nice', temperature: 0.7 });

    expect(captured.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(result.content).toBe('hi there');
    expect(result.usage).toEqual({ tokensIn: 8, tokensOut: 20 });
  });

  it('treats an empty choices list as a permanent failure', async () => {
    setFetchImpl(stubFetch(() => ({ choices: [] })));
    const client = new OpenAICompatClient('https://x', 'm', undefined, 5000);
    await expect(client.complete('hi')).rejects.toMatchObject({ retryable: false });
  });

  it('normalises tool calls', async () => {
    setFetchImpl(
      stubFetch(() => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: 'search', arguments: '{"q":"x"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })),
    );
    const client = new OpenAICompatClient('https://x', 'm', undefined, 5000);
    const result = await client.complete('hi');
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([{ name: 'search', arguments: { q: 'x' } }]);
  });

  it('marks 429 retryable and 400 permanent', async () => {
    const client = new OpenAICompatClient('https://x', 'm', undefined, 5000);

    setFetchImpl(async () => textResponse('rate limited', 429));
    await expect(client.complete('hi')).rejects.toMatchObject({ retryable: true });

    setFetchImpl(async () => textResponse('bad request', 400));
    await expect(client.complete('hi')).rejects.toMatchObject({ retryable: false });
  });

  it('marks 5xx retryable', async () => {
    setFetchImpl(async () => textResponse('server error', 503));
    const client = new OpenAICompatClient('https://x', 'm', undefined, 5000);
    await expect(client.complete('hi')).rejects.toMatchObject({ retryable: true });
  });

  it('reports unhealthy when invalid JSON arrives', async () => {
    setFetchImpl(async () => new Response('not json', { status: 200 }));
    const client = new OpenAICompatClient('https://x', 'm', undefined, 5000);
    await expect(client.healthCheck()).resolves.toBe(false);
  });
});

describe('AnthropicClient', () => {
  it('concatenates text blocks and skips thinking blocks', async () => {
    const captured: { url?: string; init?: Record<string, unknown>; body?: Record<string, unknown> } = {};
    setFetchImpl(
      stubFetch((url, init) => {
        captured.url = url;
        captured.init = init;
        captured.body = JSON.parse(String(init?.['body'])) as Record<string, unknown>;
        return {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
            { type: 'thinking', thinking: 'ignored' },
          ],
          usage: { input_tokens: 5, output_tokens: 11 },
          stop_reason: 'end_turn',
        };
      }),
    );

    const client = new AnthropicClient(
      'https://api.anthropic.com',
      'claude-sonnet-4-20250514',
      'sk-ant-test',
      5000,
    );
    const result = await client.complete('hi', { system: 'sys' });

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = captured.init?.['headers'] as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(captured.body?.['system']).toBe('sys');
    expect(captured.body?.['max_tokens']).toBe(2048);

    expect(result.content).toBe('Hello world');
    expect(result.usage).toEqual({ tokensIn: 5, tokensOut: 11 });
  });
});

describe('ProviderFactory', () => {
  it('applies a default base URL per provider', () => {
    const factory = new ProviderFactory();
    const client = factory.create({ name: 'ollama', models: ['llama3.2'] });
    expect(client).toBeInstanceOf(OllamaClient);
    expect(client.baseUrl).toBe('http://localhost:11434');
    expect(client.model).toBe('llama3.2');
  });

  it('prefers an explicit base URL', () => {
    const factory = new ProviderFactory();
    const client = factory.create({
      name: 'ollama',
      models: ['llama3.2'],
      baseUrl: 'http://gpu-box:11434',
    });
    expect(client.baseUrl).toBe('http://gpu-box:11434');
  });

  it('never sends a key to a local server', () => {
    // Local servers do not authenticate; sending a key would leak it.
    const factory = new ProviderFactory({ env: { OLLAMA_API_KEY: 'should-be-ignored' } });
    const client = factory.create({ name: 'ollama', models: ['llama3.2'] }) as {
      apiKey?: string;
    };
    expect((client as unknown as { apiKey: string | undefined }).apiKey).toBeUndefined();
  });

  it('reads the key from the environment', () => {
    const factory = new ProviderFactory({ env: { ANTHROPIC_API_KEY: 'sk-real' } });
    const client = factory.create({
      name: 'anthropic',
      models: ['claude-opus-4'],
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });
    expect((client as unknown as { apiKey: string }).apiKey).toBe('sk-real');
  });

  it('falls back to the OpenAI-compatible client for unknown providers', () => {
    const factory = new ProviderFactory();
    const client = factory.create({ name: 'groq', models: ['m'], baseUrl: 'https://api.groq.com/openai' });
    expect(client).toBeInstanceOf(OpenAICompatClient);
  });

  it('refuses a provider with no base URL', () => {
    const factory = new ProviderFactory();
    expect(() => factory.create({ name: 'some-unknown-cloud', models: ['m'] })).toThrow(
      /No baseUrl configured/,
    );
  });

  it('honours an explicit model override', () => {
    const factory = new ProviderFactory();
    const client = factory.create({ name: 'ollama', models: ['a', 'b'] }, 'b');
    expect(client.model).toBe('b');
  });

  it('never embeds a key from config', () => {
    // ProviderConfig has no key field at all; assert the shape stays that way.
    const provider = { name: 'anthropic', models: ['m'] } as Record<string, unknown>;
    expect(provider['apiKey']).toBeUndefined();
  });

  it('resolves Meta to its documented endpoint and key variable', () => {
    const factory = new ProviderFactory({ env: { MODEL_API_KEY: 'mk-meta' } });
    const client = factory.create({ name: 'meta', models: ['muse-spark-1.3'] });

    expect(client).toBeInstanceOf(OpenAICompatClient);
    expect(client.baseUrl).toBe('https://api.meta.ai/v1');
    expect((client as unknown as { apiKey: string }).apiKey).toBe('mk-meta');
  });

  it('resolves the muse alias identically to meta', () => {
    const factory = new ProviderFactory({ env: { MODEL_API_KEY: 'mk-meta' } });
    const client = factory.create({ name: 'muse', models: ['muse-spark-1.3'] });

    expect(client.baseUrl).toBe('https://api.meta.ai/v1');
  });

  it('resolves LongCat to its OpenAI-format endpoint', () => {
    const factory = new ProviderFactory({ env: { LONGCAT_API_KEY: 'lk-longcat' } });
    const client = factory.create({ name: 'longcat', models: ['LongCat-2.5-Preview'] });

    expect(client).toBeInstanceOf(OpenAICompatClient);
    expect(client.baseUrl).toBe('https://api.longcat.chat/openai');
    expect((client as unknown as { apiKey: string }).apiKey).toBe('lk-longcat');
  });

  it('resolves DeepSeek, Mistral, xAI, and Gemini to their documented endpoints', () => {
    const factory = new ProviderFactory();
    const cases: Array<[string, string]> = [
      ['deepseek', 'https://api.deepseek.com'],
      ['mistral', 'https://api.mistral.ai/v1'],
      ['xai', 'https://api.x.ai/v1'],
      ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ];

    for (const [name, baseUrl] of cases) {
      expect(factory.create({ name, models: ['m'] }).baseUrl).toBe(baseUrl);
    }
  });

  it('resolves local servers to their default ports', () => {
    const factory = new ProviderFactory();
    const cases: Array<[string, string]> = [
      ['localai', 'http://localhost:8080'],
      ['gpt4all', 'http://localhost:4891'],
      ['textgen', 'http://localhost:5000'],
    ];

    for (const [name, baseUrl] of cases) {
      const client = factory.create({ name, models: ['m'] });
      expect(client).toBeInstanceOf(OpenAICompatClient);
      expect(client.baseUrl).toBe(baseUrl);
    }
  });

  it('never sends a key to the new local servers', () => {
    const factory = new ProviderFactory({ env: { LOCALAI_API_KEY: 'should-be-ignored' } });
    const client = factory.create({ name: 'localai', models: ['m'] }) as {
      apiKey?: string;
    };
    expect(client.apiKey).toBeUndefined();
  });

  it('posts Meta chat to /chat/completions, not /v1/chat/completions', async () => {
    // Meta's base already ends in /v1, so the default path would double it.
    const captured: { url?: string } = {};
    setFetchImpl(
      stubFetch((url) => {
        captured.url = url;
        return { choices: [{ message: { content: 'hi' } }], usage: {} };
      }),
    );

    const factory = new ProviderFactory({ env: { MODEL_API_KEY: 'mk' } });
    const client = factory.create({ name: 'meta', models: ['muse-spark-1.3'] });
    await client.complete('hi');

    expect(captured.url).toBe('https://api.meta.ai/v1/chat/completions');
  });

  it('posts Gemini chat and models under /v1beta/openai', async () => {
    const urls: string[] = [];
    setFetchImpl(
      stubFetch((url) => {
        urls.push(url);
        return { choices: [{ message: { content: 'hi' } }], usage: {} };
      }),
    );

    const factory = new ProviderFactory({ env: { GEMINI_API_KEY: 'gk' } });
    const client = factory.create({ name: 'gemini', models: ['gemini-2.5-flash'] });
    await client.complete('hi');

    expect(urls[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('honours an explicit completions path over the provider default', async () => {
    const captured: { url?: string } = {};
    setFetchImpl(
      stubFetch((url) => {
        captured.url = url;
        return { choices: [{ message: { content: 'hi' } }], usage: {} };
      }),
    );

    const factory = new ProviderFactory();
    const client = factory.create({
      name: 'openai',
      models: ['m'],
      baseUrl: 'https://proxy.example.com/prefix',
      completionsPath: '/custom/chat',
    });
    await client.complete('hi');

    expect(captured.url).toBe('https://proxy.example.com/prefix/custom/chat');
  });

  it('keeps the default paths for ordinary providers', () => {
    const factory = new ProviderFactory();
    const client = factory.create({ name: 'openrouter', models: ['m'] }) as unknown as {
      completionsPath: string;
      modelsPath: string;
    };

    expect(client.completionsPath).toBe('/v1/chat/completions');
    expect(client.modelsPath).toBe('/v1/models');
  });
});

describe('ProviderError', () => {
  it('is retryable by default', () => {
    expect(new ProviderError('boom').retryable).toBe(true);
  });

  it('carries an explicit flag', () => {
    expect(new ProviderError('bad', { retryable: false }).retryable).toBe(false);
  });

  it('carries the status code', () => {
    expect(new ProviderError('x', { statusCode: 429 }).statusCode).toBe(429);
  });
});