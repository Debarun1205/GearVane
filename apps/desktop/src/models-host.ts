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
import { finished } from 'node:stream/promises';

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
  } = {},
): Promise<{ path: string; bytes: number }> {
  const entry = findCatalogEntry(id);
  if (!entry) throw new Error(`unknown model: ${String(id)}`);

  mkdirSync(modelDir, { recursive: true });
  const target = join(modelDir, entry.file);
  if (existsSync(target)) return { path: target, bytes: sizeOf(target) };

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(entry.url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  const partial = `${target}.part`;
  let done = 0;
  try {
    await finished(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
        .on('data', (chunk: Buffer) => {
          done += chunk.length;
          options.onProgress?.({ id: entry.id, done, total });
        })
        .pipe(createWriteStream(partial)),
    );
  } catch (error) {
    try {
      unlinkSync(partial);
    } catch {
      // Best effort: a stale .part is ignored on the next attempt.
    }
    throw error;
  }
  renameSync(partial, target);
  return { path: target, bytes: sizeOf(target) };
}

export function registerModelsHandlers(modelDir: string): void {
  ipcMain.handle('models:list', () => listModels(modelDir));

  ipcMain.handle('models:fetch', async (event, id: unknown) => {
    const entry = findCatalogEntry(id);
    if (!entry) return { ok: false, error: `unknown model: ${String(id)}` };
    const sender = event.sender;
    try {
      const result = await downloadModel(modelDir, entry.id, {
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send('models:progress', progress);
        },
      });
      return { ok: true, path: result.path, bytes: result.bytes };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
