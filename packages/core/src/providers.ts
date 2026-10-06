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

/**
 * A tool offered to the model.
 *
 * Structurally the JSON Schema subset the OpenAI and Ollama tool-calling APIs
 * both accept, declared locally so core keeps its zero-dependency property.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A message in an ongoing conversation.
 *
 * `toolCalls` is set on an assistant turn that requested tools; `toolCallId`
 * and `name` identify which call a `tool` turn is answering. Providers that do
 * not support tool calling ignore `toolCalls` and return prose instead.
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface CompleteOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;

  /**
   * Tools the model may call.
   *
   * Until this is set, a model is never told what it can do and therefore
   * cannot ask to do it. The response parser has always understood
   * `tool_calls`; what was missing was the request that provokes one.
   */
  tools?: ToolDefinition[];

  /**
   * Full conversation history, for multi-turn tool use.
   *
   * Takes precedence over `system` when both are supplied. When omitted the
   * call degrades to a single user turn, which is what every existing caller
   * does and why this is additive rather than a breaking change.
   */
  messages?: ConversationMessage[];
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
 * Client for any OpenAI-compatible chat completions endpoint.
 *
 * Covers OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Meta, LongCat,
 * Gemini, vLLM, LM Studio, llama.cpp server, LocalAI, GPT4All, oobabooga's
 * text-generation-webui, and hosted OpenAI.
 *
 * The completions and models paths default to the OpenAI layout but can be
 * overridden per instance, because providers disagree on where the version
 * segment lives: Meta serves chat at `/chat/completions` under a `/v1` base,
 * and Gemini at `/chat/completions` under `/v1beta/openai`.
 */
export class OpenAICompatClient extends ProviderClient {
  readonly providerName = 'openai-compatible';

  protected readonly completionsPath: string;
  protected readonly modelsPath: string;

  constructor(
    baseUrl: string,
    model: string,
    apiKey: string | undefined,
    timeoutMs: number,
    completionsPath = '/v1/chat/completions',
    modelsPath = '/v1/models',
  ) {
    super(baseUrl, model, apiKey, timeoutMs);
    this.completionsPath = completionsPath;
    this.modelsPath = modelsPath;
  }

  async complete(prompt: string, options: CompleteOptions = {}): Promise<Completion> {
    const data = await this.post(
      this.completionsPath,
      withTools(
        {
          model: this.model,
          messages: buildMessages(prompt, options),
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? 2048,
          stream: false,
        },
        options,
      ),
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
    const payload = withTools(
      {
        model: this.model,
        messages: buildMessages(prompt, options),
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 2048,
        stream: true,
      },
      options,
    );

    for await (const chunk of this.sse(
      this.completionsPath,
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
      const data = await this.get(this.modelsPath, undefined, signal);
      return 'data' in data;
    } catch {
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const data = await this.get(this.modelsPath, undefined, signal);
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
      messages: buildAnthropicMessages(prompt, options),
    };
    if (options.system) payload['system'] = options.system;

    // Anthropic names the parameter `tools` and takes a bare function object
    // per entry, without the OpenAI `type` wrapper.
    if (options.tools && options.tools.length > 0) {
      payload['tools'] = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const data = await this.post(
      '/v1/messages',
      payload,
      this.authHeaders(),
      options.signal,
    );

    // Anthropic returns content as a list of typed blocks. Text blocks
    // concatenate into the reply; tool_use blocks become tool calls, and a
    // response that is nothing but a tool call has no text at all.
    const blocks = data['content'];
    let content = '';
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(blocks)) {
      for (const block of blocks as Record<string, unknown>[]) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          content += block['text'];
        } else if (block['type'] === 'tool_use') {
          const input = block['input'];
          toolCalls.push({
            name: String(block['name'] ?? ''),
            arguments:
              input && typeof input === 'object'
                ? (input as Record<string, unknown>)
                : {},
          });
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
      toolCalls: toolCalls.filter((call) => call.name !== ''),
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

/**
 * Anthropic requires user and assistant turns to alternate strictly, and a
 * tool result is a user turn carrying `tool_result` rather than a `tool` role.
 * Sending the OpenAI shape verbatim is rejected with a 400.
 */
function buildAnthropicMessages(
  prompt: string,
  options: CompleteOptions,
): Array<Record<string, unknown>> {
  if (!options.messages || options.messages.length === 0) {
    return [{ role: 'user', content: prompt }];
  }

  const messages: Array<Record<string, unknown>> = [];

  for (const message of options.messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? message.name ?? 'tool',
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const [index, call] of message.toolCalls.entries()) {
        blocks.push({
          type: 'tool_use',
          id: message.toolCallId ?? `call_${index}`,
          name: call.name,
          input: call.arguments,
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    messages.push({ role: message.role, content: message.content });
  }

  // Consecutive same-role turns are an error, so merge any that appeared.
  const merged: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous['role'] === message['role']) {
      const before = Array.isArray(previous['content'])
        ? (previous['content'] as Array<Record<string, unknown>>)
        : [{ type: 'text', text: String(previous['content'] ?? '') }];
      const after = Array.isArray(message['content'])
        ? (message['content'] as Array<Record<string, unknown>>)
        : [{ type: 'text', text: String(message['content'] ?? '') }];
      previous['content'] = [...before, ...after];
      continue;
    }
    merged.push(message);
  }

  return merged;
}

/** Shape a tool for the OpenAI-compatible `tools` array. */
export function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Build the request message array.
 *
 * With history, passes it through and only fills in a system prompt when one
 * was supplied separately. Without history, degrades to the single-turn shape
 * every existing caller expects.
 */
function buildMessages(
  prompt: string,
  options: CompleteOptions,
): Array<Record<string, unknown>> {
  if (options.messages && options.messages.length > 0) {
    const messages: Array<Record<string, unknown>> = [];

    if (options.system) {
      messages.push({ role: 'system', content: options.system });
    }

    for (const message of options.messages) {
      // An assistant turn that called tools carries the calls alongside
      // whatever prose preceded them; content is allowed to be empty.
      if (message.role === 'assistant' && message.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map((call, index) => ({
            id: `call_${index}`,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        });
        continue;
      }

      const entry: Record<string, unknown> = {
        role: message.role,
        content: message.content,
      };
      if (message.role === 'tool') {
        entry['tool_call_id'] = message.toolCallId ?? `call_${message.name ?? 'tool'}`;
        if (message.name) entry['name'] = message.name;
      }
      messages.push(entry);
    }

    return messages;
  }

  const messages: Array<Record<string, unknown>> = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

/**
 * Add the tools array when any were offered.
 *
 * Kept separate from `buildMessages` because sending `tools: []` is not the
 * same as sending nothing: some providers reject an empty array outright.
 */
function withTools(
  body: Record<string, unknown>,
  options: CompleteOptions,
): Record<string, unknown> {
  if (options.tools && options.tools.length > 0) {
    body['tools'] = options.tools.map(toOpenAITool);
    body['tool_choice'] = 'auto';
  }
  return body;
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
  embedded: 'http://127.0.0.1:11439',
  ollama: 'http://localhost:11434',
  lm_studio: 'http://localhost:1234',
  llama_cpp: 'http://localhost:8080',
  llamacpp: 'http://localhost:8080',
  vllm: 'http://localhost:8000',
  localai: 'http://localhost:8080',
  gpt4all: 'http://localhost:4891',
  // oobabooga's text-generation-webui serves its OpenAI extension on 5000;
  // newer versions default to 5001, so override baseUrl if that is yours.
  textgen: 'http://localhost:5000',
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
  together: 'https://api.together.xyz',
  groq: 'https://api.groq.com/openai',
  deepseek: 'https://api.deepseek.com',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  meta: 'https://api.meta.ai/v1',
  muse: 'https://api.meta.ai/v1',
  longcat: 'https://api.longcat.chat/openai',
  anthropic: 'https://api.anthropic.com',
  claude: 'https://api.anthropic.com',
};

/**
 * Providers whose endpoints do not live at the default OpenAI paths.
 *
 * Each entry was checked against that provider's docs: Meta serves chat at
 * `/chat/completions` under a `/v1` base, and Gemini serves chat and models at
 * `/chat/completions` and `/models` under `/v1beta/openai`. Anything not
 * listed here uses the OpenAI layout. An explicit `completionsPath` or
 * `modelsPath` in the config always wins over these defaults.
 */
export const DEFAULT_API_PATHS: Record<string, { completions: string; models: string }> = {
  meta: { completions: '/chat/completions', models: '/v1/models' },
  muse: { completions: '/chat/completions', models: '/v1/models' },
  gemini: { completions: '/chat/completions', models: '/models' },
};

/**
 * Providers whose documented key variable does not follow NAME_API_KEY.
 *
 * Meta's docs use MODEL_API_KEY, so `meta` would otherwise look for
 * META_API_KEY and never find it.
 */
const KEY_ENV_OVERRIDES: Record<string, string> = {
  meta: 'MODEL_API_KEY',
  muse: 'MODEL_API_KEY',
};

/**
 * Names the CLI and the app treat as local: no API key needed, probed by
 * `health --offline`, and listed by `models`. Exported so the CLI filters
 * with the same list the factory enforces below instead of a copy that can
 * drift (localai/gpt4all/textgen were missing from the CLI copy).
 */
export const LOCAL_PROVIDER_NAMES: readonly string[] = [
  'embedded',
  'ollama',
  'lm_studio',
  'llama_cpp',
  'llamacpp',
  'vllm',
  'localai',
  'gpt4all',
  'textgen',
];

/** Local servers do not authenticate, so keys are never sent to them. */
const LOCAL_PROVIDERS = new Set<string>(LOCAL_PROVIDER_NAMES);

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
    if (name === 'embedded') {
      // The per-launch loopback bearer token arrives in the config itself,
      // injected by the desktop main process. No environment variable can
      // know it, so this provider does no env lookup at all.
      apiKey = provider.apiKey;
    } else {
      if (provider.apiKeyEnv) apiKey = this.env[provider.apiKeyEnv];
      if (!apiKey && KEY_ENV_OVERRIDES[name]) {
        apiKey = this.env[KEY_ENV_OVERRIDES[name]];
      }
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

      // Every other local provider is truly keyless.
      if (LOCAL_PROVIDERS.has(name)) apiKey = undefined;
    }

    const target = model ?? provider.models[0] ?? '';
    const ClientClass = REGISTRY[name] ?? OpenAICompatClient;

    // Only the OpenAI-compatible client takes endpoint paths; the others fix
    // theirs. Passing extra arguments to those constructors would not type
    // check, so the branch is explicit rather than spread.
    if (ClientClass === OpenAICompatClient) {
      const apiPaths = DEFAULT_API_PATHS[name];
      return new ClientClass(
        baseUrl,
        target,
        apiKey,
        this.timeoutMs,
        provider.completionsPath ?? apiPaths?.completions ?? '/v1/chat/completions',
        provider.modelsPath ?? apiPaths?.models ?? '/v1/models',
      );
    }

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