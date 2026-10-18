/**
 * IPC handlers and background polling for in-app updates.
 *
 * Checks GitHub Releases periodically and emits `updater:available` when a
 * newer version exists. Provides download and installation triggers for the
 * renderer so users can update within the app.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { chmodSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

import {
  checkUpdate,
  downloadUpdateFile,
  type DownloadProgress,
  type UpdateAsset,
  type UpdateInfo,
} from './updater.js';

export function registerUpdaterHandlers(
  getMainWindow: () => BrowserWindow | null,
  options?: {
    checkIntervalMs?: number;
    initialDelayMs?: number;
    fetchImpl?: typeof fetch;
  },
): { stop: () => void } {
  ipcMain.handle('updater:check', async (): Promise<UpdateInfo | null> => {
    try {
      const info = await checkUpdate(app.getVersion(), {
        fetchImpl: options?.fetchImpl,
      });
      if (info) {
        getMainWindow()?.webContents.send('updater:available', info);
      }
      return info;
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    'updater:download',
    async (
      _event,
      asset: unknown,
    ): Promise<{ ok: boolean; filePath?: string; error?: string }> => {
      if (!asset || typeof asset !== 'object') {
        return { ok: false, error: 'Invalid update asset' };
      }
      const { downloadUrl, name } = asset as UpdateAsset;
      if (!downloadUrl || !name) {
        return { ok: false, error: 'Missing asset download URL or filename' };
      }

      const tempDir = join(app.getPath('temp'), 'gearvane-update');
      const win = getMainWindow();

      try {
        const filePath = await downloadUpdateFile(downloadUrl, name, tempDir, {
          fetchImpl: options?.fetchImpl,
          onProgress: (progress: DownloadProgress) => {
            win?.webContents.send('updater:progress', progress);
          },
        });

        // Launch installer or open binary according to platform
        const osPlatform = platform();
        if (osPlatform === 'linux') {
          try {
            chmodSync(filePath, 0o755);
          } catch {
            // Advisory chmod
          }
        }

        const openError = await shell.openPath(filePath);
        if (openError) {
          return { ok: false, filePath, error: openError };
        }

        win?.webContents.send('updater:downloaded', { filePath });
        return { ok: true, filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('updater:open-url', (_event, url: unknown): boolean => {
    if (typeof url !== 'string' || !/^https?:/.test(url)) return false;
    void shell.openExternal(url);
    return true;
  });

  const initialDelay = options?.initialDelayMs ?? 5000;
  const intervalMs = options?.checkIntervalMs ?? 4 * 60 * 60 * 1000; // 4 hours

  let intervalId: NodeJS.Timeout | null = null;

  const doCheck = async () => {
    try {
      const info = await checkUpdate(app.getVersion(), {
        fetchImpl: options?.fetchImpl,
      });
      if (info) {
        getMainWindow()?.webContents.send('updater:available', info);
      }
    } catch {
      // Offline or network error: fail silently in background
    }
  };

  const timeoutId = setTimeout(() => {
    void doCheck();
    intervalId = setInterval(() => {
      void doCheck();
    }, intervalMs);
    intervalId.unref?.();
  }, initialDelay);
  timeoutId.unref?.();

  return {
    stop: () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    },
  };
}
