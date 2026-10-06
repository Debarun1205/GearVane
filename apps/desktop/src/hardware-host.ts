/**
 * Machine facts from the main process.
 *
 * The renderer is sandboxed and cannot statfs or read os.totalmem, so these
 * go over IPC like the other host bridges. Every figure is best-effort: a
 * statfs failure means "unknown", never "fine". A disk check that silently
 * reports success when it could not read the filesystem is worse than no
 * check at all.
 */

import { ipcMain } from 'electron';
import { freemem, totalmem, cpus, platform } from 'node:os';
import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { MachineInfo } from './hardware.js';

/**
 * Free space on the volume that would hold `path`.
 *
 * Walks up to the nearest existing ancestor: the model directory is created on
 * demand, so statfs on it throws ENOENT on a fresh install - which is exactly
 * the moment a disk check matters most.
 */
async function diskFor(path: string): Promise<{ free: number; total: number }> {
  let current = resolve(path);
  for (;;) {
    try {
      const stats = await statfs(current);
      return {
        // bavail rather than bfree: blocks reserved for the OS are not ours to
        // spend, so counting them would overstate what a download can use.
        free: stats.bavail * stats.bsize,
        total: stats.blocks * stats.bsize,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      // Stop at the root: if statfs fails there, the filesystem itself is the
      // problem and there is nothing above to try.
      if (code !== 'ENOENT' || parent === current) return { free: 0, total: 0 };
      current = parent;
    }
  }
}

/**
 * Measure this machine.
 *
 * Exported separately from the IPC wiring so a test can drive it against a
 * known directory without an Electron runtime.
 */
export async function measureMachine(modelDir: string): Promise<MachineInfo> {
  let free = 0;
  let diskTotal = 0;
  try {
    const disk = await diskFor(modelDir);
    free = disk.free;
    diskTotal = disk.total;
  } catch {
    free = 0;
    diskTotal = 0;
  }

  const totalMemory = totalmem();
  const freeMemory = freemem();
  const cpuCount = cpus().length;

  return {
    totalMemory,
    freeMemory,
    cpuCount,
    diskFree: free,
    diskTotal,
    // Only memory and disk together justify calling the reading degraded: cpu
    // count is a nicety, not part of any fit decision.
    degraded: totalMemory === 0 || free === 0,
  };
}

export function registerHardwareHandlers(modelDir: string): void {
  ipcMain.handle('hardware:info', () => measureMachine(modelDir));
}

// sanitizeMachineInfo lives in hardware.ts, not here: the renderer imports it,
// and this module imports electron, so pulling it in would drag the main
// process into the renderer bundle.

/** Platform string, for the onboarding hardware scan's wording. */
export const hostPlatform = (): string => platform();