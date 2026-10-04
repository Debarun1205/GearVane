import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  catalogModels,
  downloadModel,
  findCatalogEntry,
  listModels,
} from '../src/models-host.js';

function setupDir(files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'gearvane-models-'));
  for (const file of files) writeFileSync(join(dir, file), 'fake-bytes');
  return dir;
}

/** In-memory stand-in for a model file download. */
function stubFetch(bytes: string): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })) as typeof fetch;
}

describe('catalog', () => {
  it('lists thirty-five models', () => {
    expect(catalogModels()).toHaveLength(35);
  });

  it('rejects unknown and non-string ids', () => {
    expect(findCatalogEntry('nope')).toBeUndefined();
    expect(findCatalogEntry('../evil')).toBeUndefined();
    expect(findCatalogEntry(42)).toBeUndefined();
    expect(findCatalogEntry('')).toBeUndefined();
    expect(findCatalogEntry('qwen2.5-coder-0.5b-instruct-q4_0')?.file).toBe(
      'qwen2.5-coder-0.5b-instruct-q4_0.gguf',
    );
  });
});

describe('listModels', () => {
  it('marks present files with their size', () => {
    const dir = setupDir(['qwen2.5-coder-0.5b-instruct-q4_0.gguf']);
    const listed = listModels(dir);
    expect(listed).toHaveLength(35);
    const coder = listed.find((entry) => entry.id === 'qwen2.5-coder-0.5b-instruct-q4_0');
    expect(coder?.present).toBe(true);
    expect(coder?.sizeOnDisk).toBeGreaterThan(0);
    expect(listed.filter((entry) => entry.present)).toHaveLength(1);
  });
});

describe('downloadModel', () => {
  it('streams a catalog id to disk with progress', async () => {
    const dir = setupDir();
    const seen: Array<{ done: number; total: number }> = [];
    const result = await downloadModel(dir, 'qwen2.5-coder-0.5b-instruct-q4_0', {
      fetchImpl: stubFetch('x'.repeat(1024)),
      onProgress: (progress) => {
        seen.push({ done: progress.done, total: progress.total });
      },
    });
    expect(result.bytes).toBe(1024);
    expect(listModels(dir).find((e) => e.id === 'qwen2.5-coder-0.5b-instruct-q4_0')?.present).toBe(
      true,
    );
    expect(seen.length).toBeGreaterThan(0);
  });

  it('skips files that already exist', async () => {
    const dir = setupDir(['qwen2.5-coder-0.5b-instruct-q4_0.gguf']);
    let fetched = false;
    await downloadModel(dir, 'qwen2.5-coder-0.5b-instruct-q4_0', {
      fetchImpl: ((async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as unknown) as typeof fetch,
    });
    expect(fetched).toBe(false);
  });

  it('refuses ids outside the catalog', async () => {
    await expect(downloadModel(setupDir(), 'https://evil.example/x')).rejects.toThrow(
      /unknown model/,
    );
    await expect(downloadModel(setupDir(), '../escape')).rejects.toThrow(/unknown model/);
  });

  it('leaves no partial file behind on failure', async () => {
    const dir = setupDir();
    const failing = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await expect(
      downloadModel(dir, 'qwen2.5-coder-0.5b-instruct-q4_0', { fetchImpl: failing }),
    ).rejects.toThrow(/HTTP 500/);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual([]);
  });
});
