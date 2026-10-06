/**
 * Embedded local model server.
 *
 * Ships the "no setup" promise: the desktop app answers its own local tier
 * without Ollama, LM Studio, or anything else installed. On startup the
 * main process loads the GGUFs bundled beside the app through
 * node-llama-cpp and serves an OpenAI-compatible subset on 127.0.0.1:11439, so the
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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const EMBEDDED_HOST = '127.0.0.1';
export const EMBEDDED_PORT = 11439;
export const EMBEDDED_MODEL_ID = 'qwen2.5-coder-0.5b-instruct-q4_0';
export const EMBEDDED_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_0.gguf';
export const SMOL_MODEL_ID = 'smollm2-360m-instruct.q4_k_m';
export const SMOL_MODEL_URL =
  'https://huggingface.co/QuantFactory/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct.Q4_K_M.gguf';
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
  /**
   * Port to bind. 0 picks a OS-assigned port per launch, so the endpoint
   * cannot be predicted by a local process or a web page guessing 11439.
   */
  port?: number;
  /**
   * Per-launch bearer token. When set, every request must present it as
   * `Authorization: Bearer <token>`. The desktop main process generates one
   * per launch and injects it into the config it serves to the renderer;
   * tests omit it and run without authentication.
   */
  token?: string;
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
  /** Port actually serving (the bound one; the OS-assigned one when port was 0). */
  port: number;
  /** First model id; the full list is in modelIds. */
  modelId: string;
  /** Every model id the server answers for. */
  modelIds: string[];
  /** False when another server already answered on the port. */
  started: boolean;
  /** The per-launch token, when one was configured. */
  token?: string;
  stop(): Promise<void>;
}

/** Per-launch bearer token: 192 bits, URL-safe. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time token comparison. Both sides are hashed first so the compare
 * length does not leak the token's length.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Host header must name loopback. A DNS-rebinding attack points a domain at
 * 127.0.0.1 and relies on the browser sending that domain in Host; rejecting
 * anything but 127.0.0.1/localhost breaks the attack even when the Origin
 * header is absent. Takes the headers record so the rule tests directly.
 */
export function hostAllowed(headers: Record<string, string | undefined>): boolean {
  const host = headers.host;
  if (!host) return false;
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

/**
 * Origin, when a browser sends one, must be loopback or an opaque `null`
 * (what file:// renderers send). Any other origin — a web page, a malicious
 * site — is rejected. Non-browser clients send no Origin and pass.
 */
export function originAllowed(headers: Record<string, string | undefined>): boolean {
  const origin = headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Find GGUF files: the preferred name first, then the rest alphabetically.
 * Power users drop any GGUF in the dir (or point GEARVANE_EMBEDDED_MODEL
 * at it) and the server picks it up with no config change.
 */
export function findModelFiles(dir: string, preferred?: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const gguf = entries.filter((name) => name.toLowerCase().endsWith('.gguf')).sort();
  if (gguf.length === 0) return [];
  if (preferred) {
    const match = gguf.find((name) => name === preferred);
    if (match) return [join(dir, match), ...gguf.filter((name) => name !== match).map((name) => join(dir, name))];
  }
  return gguf.map((name) => join(dir, name));
}

/**
 * Find a model file: the preferred name first, then any *.gguf. Kept for
 * single-model callers; the server itself enumerates with findModelFiles.
 */
export function findModelFile(dir: string, preferred?: string): string | null {
  return findModelFiles(dir, preferred)[0] ?? null;
}

function modelIdFor(path: string): string {
  // Lowercased: quant repos mix cases (SmolLM2-360M-....Q4_K_M.gguf) and
  // request ids from configs are lowercase; matching is exact.
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.toLowerCase().endsWith('.gguf') ? base.slice(0, -5) : base;
  return stem.toLowerCase();
}

async function portAnswers(host: string, port: number, token?: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/v1/models`, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
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
  const token = options.token;
  const log = options.onLog ?? ((): void => {});
  const contextSize = options.contextSize ?? 4096;
  const loadLlama = options.loadLlama ?? defaultLoadLlama;

  const idle = (modelIds: string[], boundPort: number): EmbeddedServer => ({
    port: boundPort,
    modelId: modelIds[0] ?? EMBEDDED_MODEL_ID,
    modelIds,
    started: false,
    ...(token ? { token } : {}),
    stop: () => Promise.resolve(),
  });

  // Port 0 means "OS-assigned": there is nothing to probe, because the OS
  // hands out a fresh port that no other process is holding.
  if (port !== 0 && (await portAnswers(host, port, token))) {
    log(`embedded model: ${host}:${port} already answers, leaving it alone`);
    return idle([], port);
  }

  const modelDir = options.modelDir;
  if (!modelDir) {
    log('embedded model: no model directory configured, embedded tier unavailable');
    return idle([], port);
  }

  const preferred = options.modelFile ?? process.env[EMBEDDED_MODEL_FILE_ENV];
  // Rescanned on every use, not just at startup: a model downloaded
  // through the Models dialog lands mid-session and must serve without an
  // app restart. Loaded backends stay cached by id.
  const discover = (): Map<string, string> => {
    const found = new Map<string, string>();
    for (const modelPath of findModelFiles(modelDir, preferred)) {
      const id = modelIdFor(modelPath);
      if (!found.has(id)) found.set(id, modelPath);
    }
    return found;
  };
  if (discover().size === 0) {
    log(
      `embedded model: no .gguf in ${modelDir} (fetch from the Models dialog or npm run models:fetch); ` +
        'embedded tier unavailable until one lands',
    );
  }

  // Models load lazily on first request for them: startup stays instant
  // and memory grows only with the models actually used.
  const backends = new Map<string, ChatBackend>();
  const loading = new Map<string, Promise<ChatBackend>>();
  const getBackend = (id: string): Promise<ChatBackend> => {
    const ready = backends.get(id);
    if (ready) return Promise.resolve(ready);
    const inFlight = loading.get(id);
    if (inFlight) return inFlight;
    const path = discover().get(id);
    if (!path) return Promise.reject(new Error(`unknown model: ${id}`));
    const pending = loadLlama(path, { contextSize })
      .then((backend) => {
        backends.set(id, backend);
        loading.delete(id);
        return backend;
      })
      .catch((error: unknown) => {
        loading.delete(id);
        // Keep the id listed: the file exists, so "unknown model" would
        // lie. Requests fail fast with the load error instead, and the
        // next request retries the load (a transient failure can clear).
        throw error;
      });
    loading.set(id, pending);
    return pending;
  };

  const server: Server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      { listIds: () => [...discover().keys()], has: (id) => discover().has(id), getBackend },
      log,
      token,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // With port 0 the bound port is the only truth: the renderer config is
  // rewritten to this value before it can make a request.
  const boundPort = typeof server.address() === 'object' && server.address() !== null
    ? (server.address() as { port: number }).port
    : port;
  log(`embedded model: serving ${[...discover().keys()].join(', ')} on http://${host}:${boundPort}`);

  const snapshotIds = [...discover().keys()];
  return {
    port: boundPort,
    modelId: snapshotIds[0] as string,
    modelIds: snapshotIds,
    started: true,
    ...(token ? { token } : {}),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ModelPool {
  listIds(): string[];
  has(id: string): boolean;
  getBackend(id: string): Promise<ChatBackend>;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pool: ModelPool,
  log: (message: string) => void,
  token?: string,
): Promise<void> {
  try {
    // Loopback hardening, in order: the Host header must name loopback
    // (kills DNS rebinding), a browser-supplied Origin must be loopback or
    // opaque (kills malicious web pages), and the per-launch bearer token
    // must match (kills every other local process). No CORS headers are
    // ever sent, so cross-origin browser reads fail regardless.
    if (!hostAllowed(request.headers) || !originAllowed(request.headers)) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    if (token) {
      const header = request.headers.authorization;
      const presented = header && header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!tokenMatches(presented, token)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
    }

    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, { data: pool.listIds().map((id) => ({ id })) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = (await readBody(request)) as {
        model?: unknown;
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
      const requestedModel =
        typeof body.model === 'string' && body.model !== '' ? body.model : (pool.listIds()[0] as string);
      if (!pool.has(requestedModel)) {
        sendJson(response, 400, { error: `unknown model: ${requestedModel}` });
        return;
      }
      let backend: ChatBackend;
      try {
        backend = await pool.getBackend(requestedModel);
      } catch (error) {
        // Load failure (wrong ABI, corrupt file): 500 with the cause, not
        // 404 — the model file exists, it just cannot run.
        sendJson(response, 500, { error: `model failed to load: ${describe(error)}` });
        return;
      }
      const temperature = typeof body.temperature === 'number' ? body.temperature : 0;
      const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 2048;

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
