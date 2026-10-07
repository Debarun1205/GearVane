import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream as WebReadableStream } from 'node:stream/web';

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

/**
 * sha256 of a string, so a stub body can declare the hash it should verify
 * against.
 *
 * A real weight's bytes cannot be reproduced here, so the checksum step needs
 * an expected hash the test chooses. Production never overrides it: the point
 * is that the expectation comes from the catalog, not from whatever arrived.
 */
const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** In-memory stand-in for a model file download. */
function stubFetch(bytes: string): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })) as typeof fetch;
}

describe('catalog', () => {
  it('lists fifty models', () => {
    expect(catalogModels()).toHaveLength(50);
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
    expect(listed).toHaveLength(50);
    const coder = listed.find((entry) => entry.id === 'qwen2.5-coder-0.5b-instruct-q4_0');
    expect(coder?.present).toBe(true);
    expect(coder?.sizeOnDisk).toBeGreaterThan(0);
    expect(listed.filter((entry) => entry.present)).toHaveLength(1);
  });
});

describe('downloadModel', () => {
  const ID = 'qwen2.5-coder-0.5b-instruct-q4_0';

  it('streams a catalog id to disk with progress', async () => {
    const dir = setupDir();
    const seen: Array<{ done: number; total: number }> = [];
    const result = await downloadModel(dir, ID, {
      fetchImpl: stubFetch('x'.repeat(1024)),
      confirmed: true,
      expectedSha256: sha256('x'.repeat(1024)),
      onProgress: (progress) => {
        seen.push({ done: progress.done, total: progress.total });
      },
    });
    expect(result.bytes).toBe(1024);
    expect(listModels(dir).find((e) => e.id === ID)?.present).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('keeps a file whose sha256 matches', async () => {
    // The happy path of the verification step, proved rather than assumed.
    const dir = setupDir();
    const result = await downloadModel(dir, ID, {
      fetchImpl: stubFetch('good'.repeat(256)),
      confirmed: true,
      expectedSha256: sha256('good'.repeat(256)),
    });
    expect(readdirSync(dir)).toEqual([`${ID}.gguf`]);
    expect(result.bytes).toBe(1024);
  });

  it('discards a download whose sha256 does not match', async () => {
    // Regression: nothing verified what arrived, so a truncated transfer or a
    // spliced resume became a weight that failed to load with no explanation,
    // and the embedded server served it as though it were fine.
    const dir = setupDir();
    await expect(
      downloadModel(dir, ID, {
        fetchImpl: stubFetch('x'.repeat(1024)),
        confirmed: true,
        // The catalog's real hash, against bytes that cannot produce it: this
        // is the path production takes.
        expectedSha256: findCatalogEntry(ID)?.sha256,
      }),
    ).rejects.toThrow(/checksum mismatch/);
    // Nothing survives: no .part, and no file that would look complete.
    expect(readdirSync(dir)).toEqual([]);
    expect(listModels(dir).find((e) => e.id === ID)?.present).toBe(false);
  });

  it('carries a sha256 for every catalog weight', async () => {
    // Without this the verification above would be testing an override rather
    // than the catalog, and a catalog entry missing a hash would silently skip
    // the check.
    const missing = catalogModels().filter((e) => !/^[0-9a-f]{64}$/.test(e.sha256 ?? ''));
    expect(missing.map((e) => e.id)).toEqual([]);
  });

  it('refuses an unconfirmed download at or above the threshold', async () => {
    // R3, enforced at the boundary. The picker's confirm dialog is the
    // convenience; this is the half a sandboxed renderer cannot bypass.
    //
    // A weight over the threshold, not ID: qwen2.5-coder-0.5b is 409 MB and
    // installs silently by design, so using it here would test nothing.
    const big = catalogModels().find((e) => e.bytes >= 500 * 1048576);
    expect(big, 'no catalog weight is at or above 500 MiB').toBeDefined();

    const dir = setupDir();
    let fetched = false;
    await expect(
      downloadModel(dir, big?.id ?? '', {
        fetchImpl: ((async () => {
          fetched = true;
          return new Response('x', { status: 200 });
        }) as unknown) as typeof fetch,
      }),
    ).rejects.toThrow(/not confirmed/);
    expect(fetched).toBe(false);

    // And the same weight installs once the agreement is carried through.
    const ok = await downloadModel(dir, big?.id ?? '', {
      fetchImpl: stubFetch('x'.repeat(16)),
      confirmed: true,
      expectedSha256: sha256('x'.repeat(16)),
    });
    expect(ok.bytes).toBe(16);
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
    expect(readdirSync(dir)).toEqual([]);
  });
});


describe('downloadModel cancellation', () => {
  /**
   * A fetch whose body streams forever, so a test can abort it mid-transfer.
   *
   * The signal is what a real fetch would honour; here the stream watches it
   * and errors, which is the same shape of failure undici produces.
   */
  function endlessFetch(signal?: AbortSignal): typeof fetch {
    return (async () => {
      // What a real fetch does with an already-aborted signal: fail at the
      // handshake rather than start a transfer the caller has disowned.
      if (signal?.aborted) throw new Error('aborted');

      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new WebReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
        },
        pull(controller) {
          // Yield between chunks. An unbounded synchronous pull starves the
          // timer, so the abort would never be dispatched and this test would
          // hang for a reason that has nothing to do with the download path.
          // A real network body yields, so the stub should too.
          setTimeout(() => {
            // Already-closed means the download was cancelled, which is the
            // case under test; enqueueing past it would throw and register as
            // an unhandled error.
            if (controller.desiredSize !== null) {
              controller.enqueue(new Uint8Array(1024));
            }
          }, 5);
        },
      });
      // undici errors the body stream on abort, which is what surfaces as a
      // failed download rather than a silent truncation.
      signal?.addEventListener(
        'abort',
        () => ctrl?.error(new Error('aborted')),
        { once: true },
      );
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': '999999999' },
      });
    }) as typeof fetch;
  }

  it('stops the transfer and leaves no partial file', async () => {
    const dir = setupDir();
    const controller = new AbortController();

    const pending = downloadModel(dir, 'qwen2.5-coder-0.5b-instruct-q4_0', {
      fetchImpl: endlessFetch(controller.signal),
      signal: controller.signal,
    });

    // Abort once bytes are moving, not before: the interesting case is a
    // half-written file, not a request cancelled at the handshake.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(pending).rejects.toThrow();
    // Nothing survives: no .part, and no file that would look complete.
    expect(readdirSync(dir)).toEqual([]);
    expect(
      listModels(dir).find((e) => e.id === 'qwen2.5-coder-0.5b-instruct-q4_0')?.present,
    ).toBe(false);
  });

  it('refuses to start when the signal is already aborted', async () => {
    // A cancel that lands between the click and the request must not begin a
    // transfer the user has already backed out of.
    const dir = setupDir();
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadModel(dir, 'qwen2.5-coder-0.5b-instruct-q4_0', {
        fetchImpl: endlessFetch(controller.signal),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('completes normally when nothing aborts it', async () => {
    // The guard against a signal-handling change silently cancelling every
    // download: an untouched transfer still finishes and renames into place.
    const dir = setupDir();
    const controller = new AbortController();
    const result = await downloadModel(dir, 'qwen2.5-coder-0.5b-instruct-q4_0', {
      fetchImpl: stubFetch('y'.repeat(512)),
      signal: controller.signal,
      confirmed: true,
      expectedSha256: sha256('y'.repeat(512)),
    });
    expect(result.bytes).toBe(512);
    expect(readdirSync(dir)).toEqual(['qwen2.5-coder-0.5b-instruct-q4_0.gguf']);
  });
});
