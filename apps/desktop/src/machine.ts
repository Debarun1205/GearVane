/**
 * Measure the machine, with no Electron import.
 *
 * Split out of hardware-host.ts for the same reason the transfer was split out
 * of models-host.ts: the first-boot provisioner needs these numbers to decide
 * what it can fetch, and it must be drivable outside the app so the
 * first-boot check exercises the real code rather than a copy of it.
 *
 * Every figure is best effort. A statfs failure means "unknown", never "fine" --
 * a disk check that silently reports success when it could not read the
 * filesystem is worse than no check at all.
 */
import { freemem, totalmem, cpus } from 'node:os';
import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { MachineInfo } from './hardware.js';

/**
 * Free space on the volume that would hold `path`.
 *
 * Walks up to the nearest existing ancestor: the model directory is created on
 * demand, so statfs on it throws ENOENT on a fresh install -- which is exactly
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
      // Stop at the root: if statfs fails there, the filesystem itself is the
      // problem and there is nothing above to try.
      if (code !== 'ENOENT' || parent(current) === current) return { free: 0, total: 0 };
      current = parent(current);
    }
  }
}

const parent = (path: string): string => dirname(path);

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

  return {
    totalMemory,
    freeMemory,
    cpuCount: cpus().length,
    diskFree: free,
    diskTotal,
    // Only memory and disk together justify calling the reading degraded: cpu
    // count is a nicety, not part of any fit decision.
    degraded: totalMemory === 0 || free === 0,
  };
}
