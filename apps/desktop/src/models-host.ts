/**
 * Model downloads for the Models dialog.
 *
 * The catalog lives in src/models.json; this module reads it for status
 * and refuses anything not in it, so the renderer can never turn the main
 * process into an arbitrary-URL downloader. Downloads stream to a `.part`
 * file renamed on completion, because the embedded server serves every
 * GGUF in the directory — a half-written file would load as corruption.
 */

import { ipcMain } from 'electron';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { isRemoteOnly, remoteOnlyReason } from './catalog.js';
import { AUTO_INSTALL_LIMIT } from './model-picker.js';

export interface CatalogModel {
  id: string;
  file: string;
  url: string;
  /** Commit sha the url resolves at, so the bytes cannot change under us. */
  revision: string;
  /** sha256 of the file as published. Verified after every download. */
  sha256: string;
  bytes: number;
  use: string;
  bundled: boolean;
}

export interface ModelStatus extends CatalogModel {
  present: boolean;
  sizeOnDisk: number;
}

export function catalogModels(): CatalogModel[] {
  return loadCatalog().map((entry) => ({ ...entry }));
}

/**
 * The catalog sits beside this module in both layouts that matter: src/
 * under vitest, dist/ in dev and packaged builds (the copy step puts it
 * there, because `tsc` types a JSON import but never emits the file — and
 * a bare ESM JSON import would crash Electron's Node at startup).
 */
let catalogCache: CatalogModel[] | undefined;
function loadCatalog(): CatalogModel[] {
  if (!catalogCache) {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, 'models.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('models.json must be an array');
    catalogCache = parsed as CatalogModel[];
  }
  return catalogCache;
}

export function findCatalogEntry(id: unknown): CatalogModel | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  return catalogModels().find((entry) => entry.id === id);
}

/** Catalog annotated with what is already on disk. */
export function listModels(modelDir: string): ModelStatus[] {
  return catalogModels().map((entry) => {
    const path = join(modelDir, entry.file);
    const present = existsSync(path);
    return {
      ...entry,
      present,
      sizeOnDisk: present ? sizeOf(path) : 0,
    };
  });
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Wait until a write stream has closed its file handle.
 *
 * On Windows an unlink issued in the moment after a stream is destroyed can
 * still fail with EPERM, because the handle is released a tick later. Waiting
 * for 'close' is the deterministic version of retrying the unlink and hoping
 * the machine is fast enough.
 *
 * The timer is a backstop, not a deadline: a stream that never emits 'close'
 * must not hold a cancelled download open forever, and the unlink retry in
 * downloadModel still gets its turn afterwards.
 */
function handleReleased(sink: WriteStream | undefined): Promise<void> {
  if (!sink) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (sink.closed) {
      resolve();
      return;
    }
    const done = (): void => resolve();
    sink.once('close', done);
    setTimeout(done, 500).unref?.();
  });
}

export interface DownloadProgress {
  id: string;
  done: number;
  total: number;
}

export async function downloadModel(
  modelDir: string,
  id: string,
  options: {
    onProgress?: (progress: DownloadProgress) => void;
    fetchImpl?: typeof fetch;
    /** Aborts the transfer. The partial file is removed either way. */
    signal?: AbortSignal;
    /**
     * The user agreed to this weight, for a size at or above
     * AUTO_INSTALL_LIMIT. Set by the confirm dialog. Required for large
     * weights: without it the host refuses rather than downloading in
     * silence.
     */
    confirmed?: boolean;
    /**
     * Override the expected sha256.
     *
     * Defaults to the catalog's, and production never overrides it: the whole
     * point is that the expected hash comes from the catalog rather than from
     * whatever the transfer produced. It exists so a test can verify the
     * verification -- a real weight's bytes cannot be reproduced in a stub, so
     * without this the only observable behaviour would be the mismatch path.
     */
    expectedSha256?: string;
  } = {},
): Promise<{ path: string; bytes: number }> {
  const entry = findCatalogEntry(id);
  if (!entry) throw new Error(`unknown model: ${String(id)}`);

  mkdirSync(modelDir, { recursive: true });
  const target = join(modelDir, entry.file);
  if (existsSync(target)) return { path: target, bytes: sizeOf(target) };

  // The picker already withholds the download affordance for these, but the
  // main process is the boundary that matters: the renderer is sandboxed and
  // every argument arrives over IPC, so a crafted `models:fetch` must not be
  // able to start a transfer the UI never offered.
  if (isRemoteOnly(entry)) {
    throw new Error(remoteOnlyReason(entry.bytes));
  }

  // R3: the 500 MiB rule lives in one place and both sides use it. The picker
  // decides whether to ask; this is the half that cannot be bypassed, because a
  // renderer that skipped the confirm dialog would otherwise start a silent
  // multi-gigabyte transfer. Callers that did not confirm declare it here.
  if (entry.bytes >= AUTO_INSTALL_LIMIT && !options.confirmed) {
    throw new Error(
      `${entry.id} is ${(entry.bytes / 1048576).toFixed(0)} MB, at or above the ` +
        `${AUTO_INSTALL_LIMIT / 1048576} MB threshold, and was not confirmed. ` +
        'A silent install of a weight this size is not something the host may do unasked.',
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  // A controller of our own, so a cancel always reaches fetch: the caller may
  // pass no signal at all, and one download must not be able to abort another.
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted) controller.abort();
  const detach = (): void => options.signal?.removeEventListener('abort', forward);

  let response: Response;
  try {
    response = await fetchImpl(entry.url, { signal: controller.signal });
  } catch (error) {
    detach();
    throw error;
  }
  if (!response.ok || !response.body) {
    detach();
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  const partial = `${target}.part`;
  let done = 0;
  let sink: WriteStream | undefined;
  try {
    const source = Readable.fromWeb(
      response.body as import('node:stream/web').ReadableStream,
    );
    source.on('data', (chunk: Buffer) => {
      done += chunk.length;
      options.onProgress?.({ id: entry.id, done, total });
    });
    // pipeline, not pipe + finished: .pipe() returns the destination, so
    // finished() would only ever watch the write side. A cancelled transfer
    // fails on the *read* side, and pipe swallows that - so the await never
    // settled, the download hung after being cancelled, and the .part file
    // below was never cleaned up. pipeline watches both ends and tears down
    // the whole chain, which is what the catch block relies on.
    sink = createWriteStream(partial);
    await pipeline(source, sink);
  } catch (error) {
    // A cancelled transfer leaves a half-written .part behind, and the
    // embedded server serves every GGUF in this directory. Removing it is
    // what stops a cancelled download becoming a corrupt model that loads
    // like real corruption.
    //
    // On Windows the handle can outlive the rejected pipeline by a moment, and
    // an unlink landing in that window fails with EPERM. Wait for the stream
    // to actually close first: retrying the unlink only ever won because the
    // machine happened to be fast enough for the handle to be gone already,
    // which is why this still failed on the Windows runner. The retry stays
    // as a backstop for the case where 'close' arrives but the directory
    // entry has not been settled yet.
    await handleReleased(sink);
    let unlinked = false;
    for (let i = 0; i < 5 && !unlinked; i++) {
      try {
        unlinkSync(partial);
        unlinked = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EPERM') break;
        await new Promise((r) => setTimeout(r, 10 * (i + 1)));
      }
    }
    if (!unlinked) {
      // Best effort: a stale .part is ignored on the next attempt.
    }
    detach();
    throw error;
  }
  detach();

  // The catalog records a sha256 for every weight, so a fetched file can be
  // checked rather than trusted. Without this a corrupted transfer -- a proxy
  // that truncated the body, a resume that spliced two versions together --
  // becomes a model that fails to load with no indication of why, and the
  // embedded server will serve it as though it were fine.
  const expected = options.expectedSha256 ?? entry.sha256;
  if (expected) {
    const digest = await sha256Of(partial);
    if (digest !== expected) {
      rmSync(partial, { force: true });
      throw new Error(
        `checksum mismatch for ${entry.id}: got sha256 ${digest.slice(0, 16)}..., ` +
          `expected ${expected.slice(0, 16)}... The download was discarded.`,
      );
    }
  }

  renameSync(partial, target);
  return { path: target, bytes: sizeOf(target) };
}

/**
 * sha256 of a file, streamed.
 *
 * Read in chunks rather than whole: the largest weight in the catalog is
 * 19.24 GiB, and reading that into a Buffer to hash it is a 19 GiB allocation
 * in the main process on a machine that may not have 19 GiB free.
 */
function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Live transfers, so a cancel can find the right one to abort. */
const inFlight = new Map<string, AbortController>();

/**
 * Abort a download in progress.
 *
 * False when nothing is running for that id, so a cancel button that outlives
 * its transfer does not claim to have stopped something.
 */
export function cancelDownload(id: string): boolean {
  const controller = inFlight.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function registerModelsHandlers(modelDir: string): void {
  ipcMain.handle('models:list', () => listModels(modelDir));

  ipcMain.handle('models:fetch', async (event, id: unknown, request: unknown) => {
    const entry = findCatalogEntry(id);
    if (!entry) return { ok: false, error: `unknown model: ${String(id)}` };

    // The agreement arrives over IPC from a sandboxed renderer, so it is read
    // as a strict boolean rather than trusted as whatever shape it took.
    const confirmed =
      typeof request === 'object' &&
      request !== null &&
      (request as { confirmed?: unknown }).confirmed === true;

    // One transfer per weight: a second request for the same id replaces the
    // first, so a double click cannot leave two writers on one .part file.
    inFlight.get(entry.id)?.abort();
    const controller = new AbortController();
    inFlight.set(entry.id, controller);

    const sender = event.sender;
    try {
      const result = await downloadModel(modelDir, entry.id, {
        signal: controller.signal,
        confirmed,
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send('models:progress', progress);
        },
      });
      return { ok: true, path: result.path, bytes: result.bytes };
    } catch (error) {
      // An abort is the user's own cancel, not a failure to report as a
      // network problem they cannot act on.
      if (controller.signal.aborted) {
        return { ok: false, cancelled: true, error: 'download cancelled' };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (inFlight.get(entry.id) === controller) inFlight.delete(entry.id);
    }
  });

  ipcMain.handle('models:cancel', (_event, id: unknown) => {
    if (typeof id !== 'string' || id === '') return { ok: false };
    return { ok: cancelDownload(id) };
  });
}
