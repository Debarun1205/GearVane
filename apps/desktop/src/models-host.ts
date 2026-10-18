/**
 * Model status and the IPC handlers for the Models dialog.
 *
 * The catalog lives in src/models.json; this module reads it for status and
 * refuses anything not in it, so the renderer can never turn the main process
 * into an arbitrary-URL downloader.
 *
 * The transfer itself is in model-download.ts, which has no `electron` import.
 * That split is deliberate: it lets the first-boot provisioning check run a real
 * download against a local mirror outside the app, instead of reimplementing the
 * logic the check exists to verify.
 */
import { ipcMain } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cancelDownload, catalogModels, downloadModel, findCatalogEntry } from './model-download.js';

export {
  cancelDownload,
  catalogModels,
  downloadModel,
  findCatalogEntry,
} from './model-download.js';

export type CatalogModel = ReturnType<typeof catalogModels>[number];

/** Catalog annotated with what is already on disk. */
export function listModels(
  modelDir: string,
  /** Read-only directories that also count as installed (the installer's weights). */
  extraDirs: string[] = [],
): Array<CatalogModel & { present: boolean; sizeOnDisk: number }> {
  return catalogModels().map((entry) => {
    const path = [modelDir, ...extraDirs]
      .map((dir) => join(dir, entry.file))
      .find((candidate) => existsSync(candidate));
    return {
      ...entry,
      present: path !== undefined,
      sizeOnDisk: path !== undefined ? sizeOf(path) : 0,
    };
  });
}

/** Zero when the file cannot be stat'd, rather than throwing from a status read. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function registerModelsHandlers(modelDir: string, readOnlyDirs: string[] = []): void {
  ipcMain.handle('models:list', () => listModels(modelDir, readOnlyDirs));

  ipcMain.handle('models:fetch', async (event, id: unknown, request: unknown) => {
    const entry = findCatalogEntry(id);
    if (!entry) return { ok: false, error: `unknown model: ${String(id)}` };

    // The agreement arrives over IPC from a sandboxed renderer, so it is read as
    // a strict boolean rather than trusted as whatever shape it took.
    const confirmed =
      typeof request === 'object' &&
      request !== null &&
      (request as { confirmed?: unknown }).confirmed === true;

    // A weight that shipped in the installer is already installed. Without this
    // a second copy would be downloaded into the writable directory.
    const shipped = readOnlyDirs
      .map((dir) => join(dir, entry.file))
      .find((candidate) => existsSync(candidate));
    if (shipped) return { ok: true, path: shipped, bytes: sizeOf(shipped) };

    const sender = event.sender;
    try {
      const result = await downloadModel(modelDir, entry.id, {
        confirmed,
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send('models:progress', progress);
        },
      });
      return { ok: true, path: result.path, bytes: result.bytes };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('models:cancel', (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false };
    return { ok: cancelDownload(id) };
  });
}
