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
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface CatalogModel {
  id: string;
  file: string;
  url: string;
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
  } = {},
): Promise<{ path: string; bytes: number }> {
  const entry = findCatalogEntry(id);
  if (!entry) throw new Error(`unknown model: ${String(id)}`);

  mkdirSync(modelDir, { recursive: true });
  const target = join(modelDir, entry.file);
  if (existsSync(target)) return { path: target, bytes: sizeOf(target) };

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
    await pipeline(source, createWriteStream(partial));
  } catch (error) {
    // A cancelled transfer leaves a half-written .part behind, and the
    // embedded server serves every GGUF in this directory. Removing it is
    // what stops a cancelled download becoming a corrupt model that loads
    // like real corruption.
    try {
      unlinkSync(partial);
    } catch {
      // Best effort: a stale .part is ignored on the next attempt.
    }
    detach();
    throw error;
  }
  detach();
  renameSync(partial, target);
  return { path: target, bytes: sizeOf(target) };
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

  ipcMain.handle('models:fetch', async (event, id: unknown) => {
    const entry = findCatalogEntry(id);
    if (!entry) return { ok: false, error: `unknown model: ${String(id)}` };

    // One transfer per weight: a second request for the same id replaces the
    // first, so a double click cannot leave two writers on one .part file.
    inFlight.get(entry.id)?.abort();
    const controller = new AbortController();
    inFlight.set(entry.id, controller);

    const sender = event.sender;
    try {
      const result = await downloadModel(modelDir, entry.id, {
        signal: controller.signal,
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
