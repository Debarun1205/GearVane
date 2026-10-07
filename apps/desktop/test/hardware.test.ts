import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RUNTIME_OVERHEAD,
  assessFit,
  formatBytes,
  sanitizeMachineInfo,
} from '../src/hardware.js';

// hardware-host imports electron for its IPC wiring, which is unavailable
// outside Electron. The measurement logic under test is reached through a
// dynamic import with the channel stubbed out, so no Electron runtime is
// needed for the parts that matter.
async function loadMeasure(): Promise<(dir: string) => Promise<unknown>> {
  const { measureMachine } = await import('../src/hardware-host.js');
  return measureMachine;
}

describe('measureMachine', () => {
  it('reports free space for a directory that does not exist yet', async () => {
    // The model directory is created on first download, so a fresh install has
    // none. Returning zero here would make every download look too large.
    const measure = await loadMeasure();
    const missing = join(mkdtempSync(join(tmpdir(), 'hw-')), 'not-created-yet', 'models');

    const info = (await measure(missing)) as { diskFree: number; degraded: boolean };
    expect(info.diskFree).toBeGreaterThan(0);
    expect(info.degraded).toBe(false);
  });

  it('reports the real memory figures for this machine', async () => {
    const measure = await loadMeasure();
    const info = (await measure(mkdtempSync(join(tmpdir(), 'hw-')))) as {
      totalMemory: number;
      freeMemory: number;
      cpuCount: number;
    };
    expect(info.totalMemory).toBeGreaterThan(0);
    expect(info.cpuCount).toBeGreaterThan(0);
    expect(info.freeMemory).toBeGreaterThanOrEqual(0);
  });

  it('measures the volume holding the model directory, not the process cwd', async () => {
    // Reading the wrong volume would report another disk's free space, which is
    // the kind of wrong that only shows up for a user with a small data drive.
    const measure = await loadMeasure();
    const dir = mkdtempSync(join(tmpdir(), 'hw-'));
    const info = (await measure(dir)) as { diskFree: number; diskTotal: number };
    expect(info.diskFree).toBeGreaterThan(0);
    // Free cannot exceed the volume it came from.
    expect(info.diskFree).toBeLessThanOrEqual(info.diskTotal);
  });
});

const GIB = 1073741824;

/** A machine with the given totals. Free is left generous unless stated. */
function machine(totalGiB: number, freeGiB = totalGiB, diskGiB = 500): {
  totalMemory: number;
  freeMemory: number;
  diskFree: number;
  cpuCount: number;
  diskTotal: number;
  degraded: boolean;
} {
  return {
    totalMemory: totalGiB * GIB,
    freeMemory: freeGiB * GIB,
    diskFree: diskGiB * GIB,
    diskTotal: diskGiB * 2 * GIB,
    cpuCount: 8,
    degraded: false,
  };
}

describe('assessFit', () => {
  it('rejects a weight larger than physical memory', () => {
    // The one hard rule: weights are mmapped, so a weight bigger than RAM
    // cannot load however much of it is free.
    const report = assessFit(20 * GIB, machine(8));
    expect(report.fitsRam).toBe(false);
    expect(report.notes.join(' ')).toMatch(/larger than this machine's physical memory/);
  });

  it('accepts a weight that fits', () => {
    expect(assessFit(4 * GIB, machine(16)).fitsRam).toBe(true);
  });

  it('warns when it fits on paper but not in current free memory', () => {
    // A 64 GB machine with 2 GB free will thrash. Comparing against total alone
    // would call this a fit.
    const report = assessFit(4 * GIB, machine(64, 2));
    expect(report.fitsRam).toBe(false);
    expect(report.notes.join(' ')).toMatch(/exceed currently free memory/);
  });

  it('does not claim a fit it could not measure', () => {
    // Zeroes mean the filesystem or memory read failed. An empty reading must
    // say so rather than reading as an all-clear.
    const report = assessFit(4 * GIB, {});
    expect(report.notes.join(' ')).toMatch(/could not be measured/);
  });

  it('rejects a download with no room on disk', () => {
    const report = assessFit(10 * GIB, machine(64, 64, 2));
    expect(report.fitsDisk).toBe(false);
    expect(report.notes.join(' ')).toMatch(/not enough free disk space/);
  });

  it('estimates above the file size, and says so as an estimate', () => {
    const report = assessFit(4 * GIB, machine(16));
    expect(report.estimatedRam).toBe(Math.ceil(4 * GIB * RUNTIME_OVERHEAD));
    expect(report.estimatedRam).toBeGreaterThan(report.weightBytes);
  });

  it('widens the estimate with context length', () => {
    // KV cache is the part that actually scales with context, and it is why a
    // long request needs more than a short one for the same weight.
    const short = assessFit(4 * GIB, machine(64), { contextLength: 2000 });
    const long = assessFit(4 * GIB, machine(64), { contextLength: 32000 });
    expect(long.estimatedRamAtContext).toBeGreaterThan(
      short.estimatedRamAtContext ?? 0,
    );
  });

  it('omits the context figure entirely when no context is known', () => {
    // Better absent than present-and-zero: the app does not know the context
    // length, so a number here would imply it did.
    expect(assessFit(4 * GIB, machine(16)).estimatedRamAtContext).toBeUndefined();
  });

  it('disagrees with the catalog on the two models the site names', () => {
    // The site discloses that qwen3-8b (4.7 GiB) claims 16 GB while
    // yi-1.5-34b (19.2 GiB) claims 32, which cannot both be right -- the small
    // file claims a third of what the larger one does. These estimates follow
    // the file size, so they come out the other way round, which is the point.
    const qwen3 = assessFit(4.7 * GIB, machine(32));
    const yi = assessFit(19.2 * GIB, machine(32));
    expect(yi.estimatedRam).toBeGreaterThan(qwen3.estimatedRam);
  });
});

describe('sanitizeMachineInfo', () => {
  it('replaces a non-numeric field with zero', () => {
    // NaN in a fit comparison makes every comparison false, which would report
    // a capable machine as unable to load anything.
    const info = sanitizeMachineInfo({
      totalMemory: Number.NaN,
      freeMemory: 'lots',
      diskFree: -5,
      cpuCount: undefined,
    });
    expect(info.totalMemory).toBe(0);
    expect(info.freeMemory).toBe(0);
    expect(info.diskFree).toBe(0);
    expect(info.cpuCount).toBe(0);
  });

  it('marks a reading with no memory as degraded', () => {
    expect(sanitizeMachineInfo({ totalMemory: 0 }).degraded).toBe(true);
  });

  it('does not mark a healthy reading as degraded', () => {
    expect(sanitizeMachineInfo(machine(16)).degraded).toBe(false);
  });

  it('survives null and undefined', () => {
    expect(sanitizeMachineInfo(null).totalMemory).toBe(0);
    expect(sanitizeMachineInfo(undefined).degraded).toBe(true);
  });

  it('keeps a real zero as a real zero', () => {
    // 0 GiB of free memory is a legitimate reading; forcing it to something
    // else would hide a genuinely full machine.
    expect(sanitizeMachineInfo(machine(16, 0)).freeMemory).toBe(0);
  });
});

describe('formatBytes', () => {
  it('reads in binary units, matching the catalog', () => {
    expect(formatBytes(4 * GIB)).toBe('4.0 GiB');
    expect(formatBytes(67.2 * GIB)).toBe('67 GiB');
    expect(formatBytes(428730240)).toBe('409 MB');
  });

  it('says unknown rather than guessing', () => {
    expect(formatBytes(0)).toBe('unknown');
    expect(formatBytes(-1)).toBe('unknown');
    expect(formatBytes(Number.NaN)).toBe('unknown');
  });
});