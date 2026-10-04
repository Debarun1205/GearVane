import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EMBEDDED_MODEL_ID,
  findModelFile,
  startEmbeddedServer,
  type ChatBackend,
} from '../src/embedded-server.js';

function setupDir(files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'waypoint-embedded-'));
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

  it('stays down with an empty model directory', async () => {
    const server = await startEmbeddedServer({
      port: 11472,
      modelDir: setupDir(),
      onLog: () => {},
    });
    expect(server.started).toBe(false);
    await server.stop();
  });

  it('stays down when the backend fails to load', async () => {
    const server = await startEmbeddedServer({
      port: 11473,
      modelDir: setupDir(['model.gguf']),
      onLog: () => {},
      loadLlama: () => Promise.reject(new Error('wrong ABI')),
    });
    expect(server.started).toBe(false);
    await server.stop();
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
    const server = await startEmbeddedServer({
      port: 11475,
      modelDir: setupDir(['model.gguf']),
      onLog: () => {},
      loadLlama: () => Promise.resolve(stubBackend()),
    });
    expect(server.started).toBe(true);
    expect(server.modelId).toBe(EMBEDDED_MODEL_ID);
    try {
      const base = 'http://127.0.0.1:11475';

      const models = (await (await fetch(`${base}/v1/models`)).json()) as {
        data: Array<{ id: string }>;
      };
      expect(models.data).toEqual([{ id: EMBEDDED_MODEL_ID }]);

      const completion = (await (
        await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: EMBEDDED_MODEL_ID,
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
      expect(completion.choices[0]?.message.content).toBe('echo: hi');
      expect(completion.choices[0]?.finish_reason).toBe('stop');
      expect(completion.usage.prompt_tokens).toBeGreaterThan(0);
      expect(completion.model).toBe(EMBEDDED_MODEL_ID);

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
    } finally {
      await server.stop();
    }
  });
});
