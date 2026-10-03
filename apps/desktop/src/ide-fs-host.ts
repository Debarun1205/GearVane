/**
 * IDE filesystem handlers for the main process.
 *
 * The renderer is sandboxed and has no filesystem access, so listing, reading,
 * and saving files go through these narrow channels. The work itself lives in
 * fs-store.ts, which has no Electron import and is unit tested directly; this
 * file only validates channel input and forwards it.
 *
 * Input is validated because anything can arrive on a channel. A non-string
 * path must be refused rather than passed to the filesystem, where its
 * coercion rules are surprising.
 */

import { dialog, ipcMain } from 'electron';

import { Workspace, searchFilesTool } from '@waypoint/harness';

import { listFiles, readTextFile, removeFile, writeTextFile } from './ide/fs-store.js';

export function registerIdeFsHandlers(): void {
  ipcMain.handle('workspace:root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for the IDE',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle('ide:list', async (_event, root: unknown) => {
    if (typeof root !== 'string' || root.trim() === '') {
      return { ok: false, error: 'workspace root must be a non-empty string' };
    }

    try {
      const entries = await listFiles(root);
      return { ok: true, entries };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('ide:read', async (_event, root: unknown, relPath: unknown) => {
    if (typeof root !== 'string' || root.trim() === '') {
      return { ok: false, error: 'workspace root must be a non-empty string' };
    }
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      return { ok: false, error: 'path must be a non-empty string' };
    }

    return readTextFile(root, relPath);
  });

  ipcMain.handle(
    'ide:write',
    async (_event, root: unknown, relPath: unknown, content: unknown) => {
      if (typeof root !== 'string' || root.trim() === '') {
        return { ok: false, error: 'workspace root must be a non-empty string' };
      }
      if (typeof relPath !== 'string' || relPath.trim() === '') {
        return { ok: false, error: 'path must be a non-empty string' };
      }
      if (typeof content !== 'string') {
        return { ok: false, error: 'content must be a string' };
      }

      return writeTextFile(root, relPath, content);
    },
  );

  ipcMain.handle('ide:remove', async (_event, root: unknown, relPath: unknown) => {
    if (typeof root !== 'string' || root.trim() === '') {
      return { ok: false, error: 'workspace root must be a non-empty string' };
    }
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      return { ok: false, error: 'path must be a non-empty string' };
    }

    return removeFile(root, relPath);
  });

  ipcMain.handle(
    'ide:search',
    async (_event, root: unknown, query: unknown, directory: unknown) => {
      if (typeof root !== 'string' || root.trim() === '') {
        return { ok: false, error: 'workspace root must be a non-empty string' };
      }
      if (typeof query !== 'string' || query.trim() === '') {
        return { ok: false, error: 'query must be a non-empty string' };
      }

      // The harness tool owns the walk, caps, and skip rules, so the sidebar
      // and the agent search identically. A second implementation would
      // eventually disagree about an edge case.
      const result = await searchFilesTool.execute(
        {
          query,
          ...(typeof directory === 'string' && directory.trim() !== ''
            ? { directory }
            : {}),
        },
        { workspace: new Workspace(root), maxReadBytes: 256 * 1024 },
      );

      return { ok: result.ok, content: result.content, error: result.error };
    },
  );
}
