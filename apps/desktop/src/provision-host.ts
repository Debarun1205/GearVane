/**
 * IPC for first-boot provisioning.
 *
 * Split from provisioner.ts for the same reason the transfer was split from the
 * IPC layer: the provisioner itself must stay loadable without Electron so the
 * first-boot check can drive the real thing in a plain Node process.
 *
 * Five handlers, all of them things a user pressed rather than things the app
 * decided. Nothing here can start a transfer on its own -- `provision:start` is
 * absent on purpose, because a renderer must not be able to re-trigger a
 * 9 GiB download by calling it.
 */
import { ipcMain } from 'electron';

import type { Provisioner } from './provisioner.js';
import type { ProvisionStatus } from './provisioner.js';

export function registerProvisionHandlers(provisioner: Provisioner): void {
  ipcMain.handle('provision:status', (): ProvisionStatus => provisioner.status());

  ipcMain.handle('provision:pause', () => {
    provisioner.pause();
    return provisioner.status();
  });

  ipcMain.handle('provision:resume', async (_event, request: unknown) => {
    // Read strictly: this arrives from a sandboxed renderer and decides whether
    // a metered connection is overridden.
    const metered =
      typeof request === 'object' &&
      request !== null &&
      (request as { metered?: unknown }).metered === true;
    await provisioner.resume({ metered });
    return provisioner.status();
  });

  ipcMain.handle('provision:cancel', (_event, id: unknown) => {
    provisioner.cancel(typeof id === 'string' ? id : undefined);
    return provisioner.status();
  });

  /**
   * The renderer's guess that this connection is metered.
   *
   * `navigator.connection` is Chromium-only, so this is the only place the
   * answer exists -- and it is a guess. Hence it pauses and offers a one-click
   * continue rather than refusing.
   */
  ipcMain.handle('provision:metered', (_event, metered: unknown) => {
    provisioner.reportMetered(metered === true);
    return provisioner.status();
  });
}

export type { ProvisionStatus, ProvisionItem } from './provisioner.js';
export { Provisioner } from './provisioner.js';
