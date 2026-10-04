/**
 * Embedded local model server.
 *
 * Ships the "no setup" promise: the desktop app answers its own local tier
 * without Ollama, LM Studio, or anything else installed. On startup the
 * main process loads a GGUF bundled beside the app through node-llama-cpp
 * and serves an OpenAI-compatible subset on 127.0.0.1:11439, so the
 * existing `embedded` provider entry, the router, health checks, the chat
 * view, and the IDE agent all work unchanged — it is just another endpoint.
 *
 * Boundaries, all deliberate:
 * - Loopback only. The server never listens on a LAN interface.
 * - Starts only when nothing already answers on the port, and only when a
 *   model file is present. It never downloads on its own: a 400MB fetch
 *   must be an explicit act (`npm run models:fetch`, or the release
 *   pipeline), never a side effect of opening the app.
 * - node-llama-cpp loads lazily inside try/catch. Where the native module
 *   cannot load (wrong ABI, missing toolchain output), the app boots
 *   without the embedded tier instead of failing to start.
 * - One request drives one fresh chat session, so no conversation state
 *   leaks between callers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const EMBEDDED_HOST = '127.0.0.1';
export const EMBEDDED_PORT = 11439;
export const EMBEDDED_MODEL_ID = 'qwen2.5-coder-0.5b-instruct-q4_0';
export const EMBEDDED_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_0.gguf';
export const EMBEDDED_MODEL_DIR_ENV = 'GEARVANE_MODEL_DIR';
export const EMBEDDED_MODEL_FILE_ENV = 'GEARVANE_EMBEDDED_MODEL';

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatBackend {
  readonly modelId: string;
  chat(
    messages: ChatMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      onToken?: (token: string) => void;
    },
  ): Promise<{ content: string; stopReason: string }>;
  tokenize?(text: string): number;
}

export type LoadLlama = (
  modelPath: string,
  options: { contextSize: number },
) => Promise<ChatBackend>;

export interface EmbeddedServerOptions {
  host?: string;
  port?: number;
  /** Directory holding *.gguf files. Defaults to the bundled models dir. */
  modelDir?: string;
  /** Exact GGUF file name to prefer inside the dir. */
  modelFile?: string;
  contextSize?: number;
  onLog?: (message: string) => void;
  /** Injected for tests; defaults to the real node-llama-cpp loader. */
  loadLlama?: LoadLlama;
}

export interface EmbeddedServer {
  /** Port actually serving (the requested one; no fallback port). */
  port: number;
  modelId: string;
  /** False when another server already answered on the port. */
  started: boolean;
  stop(): Promise<void>;
}

/**
 * Find a model file: the preferred name first, then any *.gguf. Power
 * users drop a different GGUF in the dir (or point GEARVANE_EMBEDDED_MODEL
 * at it) and the server picks it up with no config change.
 */
export function findModelFile(dir: string, preferred?: string): string | null {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const gguf = entries.filter((name) => name.toLowerCase().endsWith('.gguf')).sort();
  if (gguf.length === 0) return null;
  if (preferred) {
    const match = gguf.find((name) => name === preferred);
    if (match) return join(dir, match);
  }
  return join(dir, gguf[0] as string);
}

function modelIdFor(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.toLowerCase().endsWith('.gguf') ? base.slice(0, -5) : base;
}

async function portAnswers(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { data?: unknown };
    return Array.isArray(data.data);
  } catch {
    return false;
  }
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // 1MB cap: prompts ride in the body, and an unbounded buffer is a
      // client-controlled allocation.
      if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Connection': 'close',
  });
  response.end(text);
}

function toPromptText(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const prompt = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return { system, prompt };
}

/**
 * Default loader: the real node-llama-cpp binding, imported lazily so a
 * missing or ABI-mismatched native module fails here, not at app boot.
 */
export async function defaultLoadLlama(
  modelPath: string,
  options: { contextSize: number },
): Promise<ChatBackend> {
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: options.contextSize });
  const tokenize = (text: string): number => {
    try {
      return model.tokenize(text).length;
    } catch {
      return 0;
    }
  };
  return {
    modelId: modelIdFor(modelPath),
    tokenize,
    chat: async (messages, chatOptions) => {
      // A fresh sequence per call: concurrent requests share the context
      // without sharing conversation state.
      const sequence = context.getSequence();
      try {
        const { system, prompt } = toPromptText(messages);
        const session = new LlamaChatSession({
          contextSequence: sequence,
          ...(system ? { systemPrompt: system } : {}),
        });
        const content = await session.prompt(prompt || ' ', {
          temperature: chatOptions.temperature ?? 0,
          maxTokens: chatOptions.maxTokens ?? 2048,
          ...(chatOptions.signal ? { signal: chatOptions.signal } : {}),
          ...(chatOptions.onToken ? { onTextChunk: chatOptions.onToken } : {}),
        });
        return { content, stopReason: 'stop' };
      } finally {
        await sequence.dispose();
      }
    },
  };
}

export async function startEmbeddedServer(options: EmbeddedServerOptions = {}): Promise<EmbeddedServer> {
  const host = options.host ?? EMBEDDED_HOST;
  const port = options.port ?? EMBEDDED_PORT;
  const log = options.onLog ?? ((): void => {});
  const contextSize = options.contextSize ?? 4096;

  if (await portAnswers(host, port)) {
    log(`embedded model: ${host}:${port} already answers, leaving it alone`);
    return {
      port,
      modelId: EMBEDDED_MODEL_ID,
      started: false,
      stop: () => Promise.resolve(),
    };
  }

  const modelDir = options.modelDir;
  if (!modelDir) {
    log('embedded model: no model directory configured, embedded tier unavailable');
    return { port, modelId: EMBEDDED_MODEL_ID, started: false, stop: () => Promise.resolve() };
  }

  const preferred = options.modelFile ?? process.env[EMBEDDED_MODEL_FILE_ENV];
  const modelPath = findModelFile(modelDir, preferred);
  if (!modelPath) {
    log(
      `embedded model: no .gguf in ${modelDir} (fetch one with npm run models:fetch); ` +
        'embedded tier unavailable',
    );
    return { port, modelId: EMBEDDED_MODEL_ID, started: false, stop: () => Promise.resolve() };
  }

  let backend: ChatBackend;
  try {
    backend = await (options.loadLlama ?? defaultLoadLlama)(modelPath, { contextSize });
  } catch (error) {
    // Wrong ABI, missing toolchain output, corrupt file: the app must boot
    // anyway, on its other local providers.
    log(`embedded model: backend failed to load (${describe(error)}), embedded tier unavailable`);
    return { port, modelId: EMBEDDED_MODEL_ID, started: false, stop: () => Promise.resolve() };
  }

  const modelId = backend.modelId;
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response, backend, modelId, log);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  log(`embedded model: serving ${modelId} on http://${host}:${port}`);

  return {
    port,
    modelId,
    started: true,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  backend: ChatBackend,
  modelId: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, { data: [{ id: modelId }] });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = (await readBody(request)) as {
        messages?: Array<{ role?: unknown; content?: unknown }>;
        temperature?: unknown;
        max_tokens?: unknown;
        stream?: unknown;
      };
      const messages: ChatMessage[] = Array.isArray(body.messages)
        ? body.messages.map((m) => ({
            role: typeof m.role === 'string' ? m.role : 'user',
            content: typeof m.content === 'string' ? m.content : '',
          }))
        : [];
      if (messages.length === 0) {
        sendJson(response, 400, { error: 'messages must be a non-empty array' });
        return;
      }
      const temperature = typeof body.temperature === 'number' ? body.temperature : 0;
      const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 2048;
      const requestedModel =
        typeof (body as { model?: unknown }).model === 'string'
          ? ((body as { model?: string }).model as string)
          : modelId;

      if (body.stream === true) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        try {
          await backend.chat(messages, {
            temperature,
            maxTokens,
            onToken: (token) => {
              response.write(
                `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`,
              );
            },
          });
          response.write('data: [DONE]\n\n');
        } catch (error) {
          response.write(`data: ${JSON.stringify({ error: describe(error) })}\n\n`);
        }
        response.end();
        return;
      }

      const { content } = await backend.chat(messages, { temperature, maxTokens });
      const usage = backend.tokenize
        ? {
            prompt_tokens: backend.tokenize(messages.map((m) => m.content).join('\n')),
            completion_tokens: backend.tokenize(content),
          }
        : { prompt_tokens: 0, completion_tokens: 0 };
      sendJson(response, 200, {
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
        model: requestedModel,
      });
      return;
    }

    sendJson(response, 404, { error: 'unknown endpoint' });
  } catch (error) {
    log(`embedded model: request failed (${describe(error)})`);
    if (!response.headersSent) {
      sendJson(response, 500, { error: 'embedded model failed' });
    } else {
      response.end();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
