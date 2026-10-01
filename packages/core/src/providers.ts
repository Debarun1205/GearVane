import type {
  Completion,
  ProviderConfig,
  ToolCall,
  Usage,
} from './types.js';

/**
 * Thrown when a provider call fails.
 *
 * `retryable` distinguishes transient faults (429, 5xx, connection loss)
 * from permanent ones (auth, bad request, protocol violations) so the retry
 * loop does not burn attempts on calls that cannot succeed.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly provider: string;

  constructor(
    message: string,
    options: { retryable?: boolean; statusCode?: number; provider?: string } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = options.retryable ?? true;
    this.statusCode = options.statusCode;
    this.provider = options.provider ?? 'unknown';
  }
}

/**
 * Injectable fetch, so the core stays free of Node-only globals and can run
 * in a browser, Electron renderer, Android webview, or Node.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface CompleteOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export abstract class ProviderClient {
  abstract readonly providerName: string;

  constructor(
    readonly baseUrl: string,
    readonly model: string,
    protected readonly apiKey: string | undefined,
    protected readonly timeoutMs: number,
  ) {}

  abstract complete(prompt: string, options?: CompleteOptions): Promise<Completion>;

  abstract stream(
    prompt: string,
    options?: CompleteOptions,
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Cheap availability probe.
   *
   * Must not report healthy without contacting the endpoint: a false green
   * is worse than reporting nothing.
   */
  abstract healthCheck(signal?: AbortSignal): Promise<boolean>;

  abstract listModels(signal?: AbortSignal): Promise<string[]>;

  protected async request<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...init.headers,
    };
    if (this.apiKey) {
      headers['Authorization'] ??= `Bearer ${this.apiKey}`;
    }

    // Compose the caller's signal with our own timeout so a caller cancel
    // still works while a hung request is bounded.
    const timeoutSignal = new AbortController();
    const timer = setTimeout(() => timeoutSignal.abort(), this.timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal.signal])
      : timeoutSignal.signal;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (signal.aborted && !init.signal?.aborted) {
        throw new ProviderError(`Request to ${url} timed out`, {
          retryable: true,
          provider: this.providerName,
        });
      }
      throw new ProviderError(`Cannot reach ${url}: ${describe(error)}`, {
        retryable: true,
        provider: this.providerName,
      });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 429 and 5xx are worth retrying; other 4xx are permanent.
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        `HTTP ${response.status} from ${url}: ${detail.slice(0, 300)}`,
        { retryable, statusCode: response.status, provider: this.providerName },
      );
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError(`Invalid JSON from ${url}`, {
        retryable: false,
        provider: this.providerName,
      });
    }
  }

  /**
   * Iterate server-sent events, yielding the decoded JSON payload.
   *
   * Handles both `data: {...}` framing and bare JSON lines. Lives on the base
   * class so every client shares one implementation.
   */
  protected async *sse(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (this.apiKey && !extraHeaders?.['x-api-key']) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`Stream request failed: HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
        statusCode: response.status,
        provider: this.providerName,
      });
    }

    for await (const line of readLines(response.body)) {
      let text = line.trim();
      if (text.startsWith('data:')) text = text.slice(5).trim();
      if (text === '') continue;
      if (text === '[DONE]') return;
      try {
        yield JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Ignore malformed frames rather than aborting the stream.
      }
    }
  }

  protected async post(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(path, {
      method: 'POST',
      body,
      ...(headers ? { headers } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  protected async get(
    path: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(path, {
      method: 'GET',
      ...(headers ? { headers } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}

/**
 * Client for a local Ollama server (/api/generate).
 */
export class OllamaClient extends ProviderClient {
  readonly providerName = 'ollama';

  async complete(prompt: string, options: CompleteOptions = {}): Promise<Completion> {
    const payload: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.maxTokens ?? 2048,
      },
    };
    if (options.system) payload['system'] = options.system;

    const data = await this.post(
      '/api/generate',
      payload,
      undefined,
      options.signal,
    );

    return {
      content: String(data['response'] ?? ''),
      model: String(data['model'] ?? this.model),
      usage: {
        tokensIn: Number(data['prompt_eval_count'] ?? 0),
        tokensOut: Number(data['eval_count'] ?? 0),
      },
      finishReason: String(data['done_reason'] ?? 'stop'),
      toolCalls: [],
    };
  }

  async *stream(
    prompt: string,
    options: CompleteOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const payload: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: true,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.maxTokens ?? 2048,
      },
    };
    if (options.system) payload['system'] = options.system;

    for await (const chunk of this.sse('/api/generate', payload, options.signal)) {
      const text = chunk['response'];
      if (typeof text === 'string' && text.length > 0) yield text;
      if (chunk['done']) return;
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const data = await this.get('/api/tags', undefined, signal);
      return 'models' in data;
    } catch {
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const data = await this.get('/api/tags', undefined, signal);
      const models = data['models'];
      if (!Array.isArray(models)) return [];
      return models.map((m) => String((m as Record<string, unknown>)['name'] ?? ''));
    } catch {
      return [];
    }
  }
}

/**
 * Client for any OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Covers OpenRouter, Groq, Together, vLLM, LM Studio, llama.cpp server,
 * and hosted OpenAI.
 */
export class OpenAICompatClient extends ProviderClient {
  readonly providerName = 'openai-compatible';

  async complete(prompt: string, options: CompleteOptions = {}): Promise<Completion> {
    const data = await this.post(
      '/v1/chat/completions',
      {
        model: this.model,
        messages: buildMessages(prompt, options.system),
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 2048,
        stream: false,
      },
      undefined,
      options.signal,
    );

    const choices = data['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError('No choices in provider response', {
        retryable: false,
        provider: this.providerName,
      });
    }

    const first = choices[0] as Record<string, unknown>;
    const message = (first['message'] ?? {}) as Record<string, unknown>;
    const usage = (data['usage'] ?? {}) as Record<string, unknown>;

    return {
      content: typeof message['content'] === 'string' ? message['content'] : '',
      model: String(data['model'] ?? this.model),
      usage: {
        tokensIn: Number(usage['prompt_tokens'] ?? 0),
        tokensOut: Number(usage['completion_tokens'] ?? 0),
      },
      finishReason: String(first['finish_reason'] ?? 'stop'),
      toolCalls: normaliseToolCalls(message['tool_calls']),
    };
  }

  async *stream(
    prompt: string,
    options: CompleteOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const payload = {
      model: this.model,
      messages: buildMessages(prompt, options.system),
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
    };

    for await (const chunk of this.sse(
      '/v1/chat/completions',
      payload,
      options.signal,
    )) {
      const choices = chunk['choices'];
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const first = choices[0] as Record<string, unknown>;
      const delta = (first['delta'] ?? {}) as Record<string, unknown>;
      const token = delta['content'];
      if (typeof token === 'string' && token.length > 0) yield token;
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const data = await this.get('/v1/models', undefined, signal);
      return 'data' in data;
    } catch {
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const data = await this.get('/v1/models', undefined, signal);
      const models = data['data'];
      if (!Array.isArray(models)) return [];
      return models.map((m) => String((m as Record<string, unknown>)['id'] ?? ''));
    } catch {
      return [];
    }
  }

  }

/**
 * Client for the Anthropic Messages API.
 */
export class AnthropicClient extends ProviderClient {
  readonly providerName = 'anthropic';

  private authHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  async complete(prompt: string, options: CompleteOptions = {}): Promise<Completion> {
    const payload: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0,
      messages: [{ role: 'user', content: prompt }],
    };
    if (options.system) payload['system'] = options.system;

    const data = await this.post(
      '/v1/messages',
      payload,
      this.authHeaders(),
      options.signal,
    );

    // Anthropic returns content as a list of typed blocks; concatenate the
    // text ones and ignore thinking blocks.
    const blocks = data['content'];
    let content = '';
    if (Array.isArray(blocks)) {
      for (const block of blocks as Record<string, unknown>[]) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          content += block['text'];
        }
      }
    }

    const usage = (data['usage'] ?? {}) as Record<string, unknown>;

    return {
      content,
      model: String(data['model'] ?? this.model),
      usage: {
        tokensIn: Number(usage['input_tokens'] ?? 0),
        tokensOut: Number(usage['output_tokens'] ?? 0),
      },
      finishReason: String(data['stop_reason'] ?? 'stop'),
      toolCalls: [],
    };
  }

  async *stream(
    prompt: string,
    options: CompleteOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const payload: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
    if (options.system) payload['system'] = options.system;

    for await (const event of this.sse(
      '/v1/messages',
      payload,
      options.signal,
      this.authHeaders(),
    )) {
      if (event['type'] === 'content_block_delta') {
        const delta = (event['delta'] ?? {}) as Record<string, unknown>;
        const token = delta['text'];
        if (typeof token === 'string' && token.length > 0) yield token;
      }
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    // Anthropic has no unauthenticated probe endpoint, so the cheapest
    // reliable check is a minimal message.
    try {
      await this.complete('ping', { maxTokens: 1, ...(signal ? { signal } : {}) });
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }
}

function buildMessages(
  prompt: string,
  system?: string,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function normaliseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const entry of value as Record<string, unknown>[]) {
    const fn = (entry['function'] ?? {}) as Record<string, unknown>;
    const name = String(fn['name'] ?? '');
    if (!name) continue;
    let args: Record<string, unknown> = {};
    if (typeof fn['arguments'] === 'string') {
      try {
        args = JSON.parse(fn['arguments']) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Read newline-delimited chunks from a response body.
 *
 * Works across Node, browsers, and Electron renderers by using whichever
 * async-iteration interface the runtime exposes.
 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Provider name to client class. Unknown names fall back to OpenAI-compatible. */
const REGISTRY: Record<string, new (...args: ConstructorParameters<typeof OpenAICompatClient>) => ProviderClient> = {
  ollama: OllamaClient as never,
  anthropic: AnthropicClient as never,
};

export const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lm_studio: 'http://localhost:1234',
  llama_cpp: 'http://localhost:8080',
  llamacpp: 'http://localhost:8080',
  vllm: 'http://localhost:8000',
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
  together: 'https://api.together.xyz',
  groq: 'https://api.groq.com/openai',
  anthropic: 'https://api.anthropic.com',
  claude: 'https://api.anthropic.com',
};

/** Local servers do not authenticate, so keys are never sent to them. */
const LOCAL_PROVIDERS = new Set([
  'ollama',
  'lm_studio',
  'llama_cpp',
  'llamacpp',
  'vllm',
]);

export interface ClientFactoryOptions {
  /** Supplies API keys; kept separate so config never carries secrets. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export class ProviderFactory {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: ClientFactoryOptions = {}) {
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (options.fetchImpl) setFetchImpl(options.fetchImpl);
  }

  create(provider: ProviderConfig, model?: string): ProviderClient {
    const name = provider.name.toLowerCase().trim();
    const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[name];

    if (!baseUrl) {
      throw new ProviderError(
        `No baseUrl configured for provider '${provider.name}'. ` +
          `Set tiers.<tier>.providers[].baseUrl in your config.`,
        { retryable: false, provider: name },
      );
    }

    let apiKey: string | undefined;
    if (provider.apiKeyEnv) apiKey = this.env[provider.apiKeyEnv];
    if (!apiKey) {
      for (const candidate of [
        `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`,
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
      ]) {
        const found = this.env[candidate];
        if (found) {
          apiKey = found;
          break;
        }
      }
    }

    if (LOCAL_PROVIDERS.has(name)) apiKey = undefined;

    const target = model ?? provider.models[0] ?? '';
    const ClientClass = REGISTRY[name] ?? OpenAICompatClient;

    return new ClientClass(baseUrl, target, apiKey, this.timeoutMs);
  }
}

// --- fetch indirection -----------------------------------------------------
// Tests inject a stub; runtime uses the global.
let globalFetch: FetchLike | undefined;

export function setFetchImpl(impl: FetchLike): void {
  globalFetch = impl;
}

function fetchImpl(url: string, init: Parameters<FetchLike>[1]): Promise<Response> {
  const impl = globalFetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!impl) {
    throw new ProviderError('No fetch implementation available', {
      retryable: false,
    });
  }
  return impl(url, init);
}

export type { Usage };