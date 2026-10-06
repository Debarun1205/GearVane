import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EMBEDDED_MODEL_ID,
  findModelFile,
  hostAllowed,
  originAllowed,
  startEmbeddedServer,
  type ChatBackend,
} from '../src/embedded-server.js';

function setupDir(files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'gearvane-embedded-'));
  for (const file of files) writeFileSync(join(dir, file), 'fake-gguf-bytes');
  return dir;
}

/** Deterministic stand-in for node-llama-cpp: no model, no native code. */
function stubBackend(modelId = EMBEDDED_MODEL_ID): ChatBackend {
  return {
    modelId,
    tokenize: (text) => text.split(/\s+/).filter(Boolean).length,
    chat: async (messages, options) => {
      const last = messages.filter((m) => m.role !== 'system').pop();
      if (options.signal?.aborted) throw options.signal.reason;
      if (options.onToken) {
        for (const word of ['hello', 'world']) options.onToken(word);
      }
      return { content: `echo: ${last?.content ?? ''}`, stopReason: 'stop' };
    },
  };
}

describe('findModelFile', () => {
  it('prefers the named file', () => {
    const dir = setupDir(['b.gguf', 'a.gguf']);
    expect(findModelFile(dir, 'a.gguf')).toBe(join(dir, 'a.gguf'));
  });

  it('falls back to the first gguf alphabetically', () => {
    const dir = setupDir(['b.gguf', 'a.gguf']);
    expect(findModelFile(dir)).toBe(join(dir, 'a.gguf'));
  });

  it('ignores non-gguf files and missing directories', () => {
    const dir = setupDir(['notes.txt']);
    expect(findModelFile(dir)).toBeNull();
    expect(findModelFile(join(dir, 'nope'))).toBeNull();
  });
});

describe('startEmbeddedServer', () => {
  it('stays down without a model directory', async () => {
    const server = await startEmbeddedServer({ port: 11471, onLog: () => {} });
    expect(server.started).toBe(false);
    await server.stop();
  });

  it('starts empty and serves models that land later', async () => {
    // An empty dir no longer keeps the server down: the Models dialog
    // downloads mid-session, and the server must already be listening.
    const server = await startEmbeddedServer({
      port: 11472,
      modelDir: setupDir(),
      onLog: () => {},
    });
    expect(server.started).toBe(true);
    try {
      const models = (await (await fetch('http://127.0.0.1:11472/v1/models')).json()) as {
        data: unknown[];
      };
      expect(models.data).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('starts with a failing backend and reports the load error per request', async () => {
    const server = await startEmbeddedServer({
      port: 11473,
      modelDir: setupDir(['model.gguf']),
      onLog: () => {},
      loadLlama: () => Promise.reject(new Error('wrong ABI')),
    });
    // Lazy loading: startup succeeds with files present; the failure
    // surfaces on the request that needs the model, with its cause.
    expect(server.started).toBe(true);
    try {
      const res = await fetch('http://127.0.0.1:11473/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(500);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toMatch(/wrong ABI/);
    } finally {
      await server.stop();
    }
  });

  it('leaves an already-answering port alone', async () => {
    const existing = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'other' }] }));
    });
    await new Promise<void>((resolve) => existing.listen(11474, '127.0.0.1', resolve));
    try {
      let loaded = false;
      const server = await startEmbeddedServer({
        port: 11474,
        modelDir: setupDir(['model.gguf']),
        onLog: () => {},
        loadLlama: () => {
          loaded = true;
          return Promise.resolve(stubBackend());
        },
      });
      expect(server.started).toBe(false);
      expect(loaded).toBe(false);
      await server.stop();
    } finally {
      await new Promise<void>((resolve) => existing.close(() => resolve()));
    }
  });

  it('serves OpenAI-compatible endpoints', async () => {
    let loads = 0;
    const server = await startEmbeddedServer({
      port: 11475,
      modelDir: setupDir(['model.gguf']),
      onLog: () => {},
      loadLlama: () => {
        loads += 1;
        return Promise.resolve(stubBackend());
      },
    });
    expect(server.started).toBe(true);
    expect(server.modelId).toBe('model');
    expect(server.modelIds).toEqual(['model']);
    // Lazy: nothing loads until the first request asks for it.
    expect(loads).toBe(0);
    try {
      const base = 'http://127.0.0.1:11475';

      const models = (await (await fetch(`${base}/v1/models`)).json()) as {
        data: Array<{ id: string }>;
      };
      expect(models.data).toEqual([{ id: 'model' }]);

      const completion = (await (
        await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'model',
            messages: [
              { role: 'system', content: 'be brief' },
              { role: 'user', content: 'hi' },
            ],
            temperature: 0,
            max_tokens: 32,
          }),
        })
      ).json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
        usage: { prompt_tokens: number; completion_tokens: number };
        model: string;
      };
      expect(loads).toBe(1);
      expect(completion.choices[0]?.message.content).toBe('echo: hi');
      expect(completion.choices[0]?.finish_reason).toBe('stop');
      expect(completion.usage.prompt_tokens).toBeGreaterThan(0);
      expect(completion.model).toBe('model');

      const stream = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      const text = await stream.text();
      expect(text).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}');
      expect(text).toContain('data: [DONE]');

      const missing = await fetch(`${base}/v1/nope`);
      expect(missing.status).toBe(404);

      const empty = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(empty.status).toBe(400);

      const unknown = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(unknown.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it('serves every gguf in the directory under its own id', async () => {
    const loaded: string[] = [];
    const server = await startEmbeddedServer({
      port: 11476,
      modelDir: setupDir(['b.gguf', 'a.gguf']),
      onLog: () => {},
      loadLlama: (path) => {
        loaded.push(path);
        const id = path.split(/[\\/]/).pop() ?? path;
        return Promise.resolve({
          ...stubBackend(),
          chat: async () => ({ content: `from ${id}`, stopReason: 'stop' }),
        });
      },
    });
    expect(server.started).toBe(true);
    expect(server.modelIds).toEqual(['a', 'b']);
    try {
      const base = 'http://127.0.0.1:11476';
      const models = (await (await fetch(`${base}/v1/models`)).json()) as {
        data: Array<{ id: string }>;
      };
      expect(models.data).toEqual([{ id: 'a' }, { id: 'b' }]);

      const ask = (model: string): Promise<{ choices: Array<{ message: { content: string } }> }> =>
        fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
        }).then((res) => res.json() as Promise<{ choices: Array<{ message: { content: string } }> }>);
      expect((await ask('b')).choices[0]?.message.content).toBe('from b.gguf');
      expect((await ask('a')).choices[0]?.message.content).toBe('from a.gguf');
      // Each model loaded exactly once, on first use.
      expect(loaded).toHaveLength(2);
      expect((await ask('a')).choices[0]?.message.content).toBe('from a.gguf');
      expect(loaded).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it('lists a model downloaded mid-session without a restart', async () => {
    const dir = setupDir(['a.gguf']);
    const server = await startEmbeddedServer({
      port: 11477,
      modelDir: dir,
      onLog: () => {},
      loadLlama: () => Promise.resolve(stubBackend()),
    });
    expect(server.started).toBe(true);
    try {
      const base = 'http://127.0.0.1:11477';
      const listed = async (): Promise<string[]> => {
        const payload = (await (await fetch(`${base}/v1/models`)).json()) as {
          data: Array<{ id: string }>;
        };
        return payload.data.map((entry) => entry.id);
      };
      expect(await listed()).toEqual(['a']);
      writeFileSync(join(dir, 'b.gguf'), 'fake-gguf-bytes');
      expect(await listed()).toEqual(['a', 'b']);
    } finally {
      await server.stop();
    }
  });

  it('binds an OS-assigned port when asked for port 0', async () => {
    const server = await startEmbeddedServer({
      port: 0,
      modelDir: setupDir(['a.gguf']),
      onLog: () => {},
      loadLlama: () => Promise.resolve(stubBackend()),
    });
    expect(server.started).toBe(true);
    expect(server.port).not.toBe(0);
    try {
      const models = (await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json()) as {
        data: Array<{ id: string }>;
      };
      expect(models.data).toEqual([{ id: 'a' }]);
    } finally {
      await server.stop();
    }
  });
});

describe('loopback hardening', () => {
  const TOKEN = 'test-token';

  async function authedServer(): Promise<{ server: Awaited<ReturnType<typeof startEmbeddedServer>>; port: number }> {
    const server = await startEmbeddedServer({
      port: 0,
      modelDir: setupDir(['a.gguf']),
      token: TOKEN,
      onLog: () => {},
      loadLlama: () => Promise.resolve(stubBackend()),
    });
    return { server, port: server.port };
  }

  it('rejects a request without the per-launch token', async () => {
    const { server, port } = await authedServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('rejects a wrong token and accepts the right one', async () => {
    const { server, port } = await authedServer();
    try {
      const wrong = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(wrong.status).toBe(401);
      const right = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(right.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('rejects a non-loopback Host header (DNS rebinding)', () => {
    // fetch cannot set Host (forbidden header name), so the guard tests
    // directly — a browser rebinding attack is exactly this input.
    expect(hostAllowed({ host: 'evil.example.com' })).toBe(false);
    expect(hostAllowed({ host: 'evil.example.com:8080' })).toBe(false);
    expect(hostAllowed({ host: '127.0.0.1:11439' })).toBe(true);
    expect(hostAllowed({ host: 'localhost' })).toBe(true);
    expect(hostAllowed({})).toBe(false);
    // A repeated header arrives as an array; it cannot name loopback.
    expect(hostAllowed({ host: ['127.0.0.1', 'evil.example.com'] })).toBe(false);
  });

  it('allows only an absent, opaque, or loopback Origin', () => {
    // Absence is the non-browser client; `null` is a file:// renderer.
    expect(originAllowed({})).toBe(true);
    expect(originAllowed({ origin: 'null' })).toBe(true);
    expect(originAllowed({ origin: 'http://127.0.0.1:11439' })).toBe(true);
    expect(originAllowed({ origin: 'http://localhost:11439' })).toBe(true);
    expect(originAllowed({ origin: 'https://evil.example.com' })).toBe(false);
    // A malformed repeated Origin fails closed rather than guessing.
    expect(originAllowed({ origin: ['http://127.0.0.1', 'https://evil.example.com'] })).toBe(false);
  });

  it('rejects a web-page Origin and accepts an opaque one', async () => {
    const { server, port } = await authedServer();
    try {
      const evil = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example.com' },
      });
      expect(evil.status).toBe(403);
      // file:// renderers send Origin: null; non-browser clients send none.
      const opaque = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'null' },
      });
      expect(opaque.status).toBe(200);
      const bare = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(bare.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
