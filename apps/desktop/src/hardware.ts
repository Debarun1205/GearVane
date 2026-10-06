/**
 * What the machine can actually do, and what a weight needs to load on it.
 *
 * The catalog's RAM figures are hand-written prose: 29 of the 50 entries say
 * "needs NGB RAM" inside their `use` string, the ratios to file size range
 * from 1.73 to 3.48, and 21 entries say nothing at all. gemma-3-27b is a 15 GiB
 * file claiming 48 GB while qwen2.5-32b is a 17.9 GiB file claiming 32, so
 * neither figure can be taken as the source of truth.
 *
 * What *can* be derived is a floor. The weights are mmapped into RAM, so a
 * weight cannot load unless its own file fits in physical memory - that is
 * arithmetic, not a guess, and it is enough to warn someone before they commit
 * several gigabytes of download to a machine that cannot hold it.
 *
 * Everything above that floor is an estimate and is labelled as one. KV cache
 * scales with context length and quantization, and nothing here measures
 * either, so no prompt-length figure is invented.
 */

/** Measured facts about the host. Zeroes mean "could not measure". */
export interface MachineInfo {
  /** Physical RAM in bytes. */
  totalMemory: number;
  /** Available RAM in bytes, as the OS reports it. */
  freeMemory: number;
  /** Logical CPU count. */
  cpuCount: number;
  /** Free bytes on the volume holding the model directory. */
  diskFree: number;
  /** Bytes on that volume, when known. */
  diskTotal: number;
  /** True when RAM and disk figures came back as zeroes. */
  degraded: boolean;
}

/** What a weight needs, and whether this machine has it. */
export interface FitReport {
  /** Bytes the weights occupy. A hard floor: they must fit in RAM. */
  weightBytes: number;
  /** Estimated RAM for weights plus runtime overhead and a KV cache. */
  estimatedRam: number;
  /** Estimated RAM given a context window, when one is known. */
  estimatedRamAtContext?: number;
  /** True when the weights fit in total physical RAM. */
  fitsRam: boolean;
  /** True when there is room on the volume for the download. */
  fitsDisk: boolean;
  /**
   * Why the estimate says what it says, for the dialog to show.
   *
   * Empty when the machine could not be measured, which is different from
   * "it fits" and must not read as an all-clear.
   */
  notes: string[];
}

/**
 * Overhead on top of the weights: KV cache, the inference runtime's own
 * buffers, and the OS page cache holding the file.
 *
 * A single flat factor rather than a context-aware curve, because the inputs a
 * real curve needs - quantization, head count, layer count, batch size - are
 * not in the catalog. One number, stated as one number.
 */
export const RUNTIME_OVERHEAD = 1.3;

/**
 * KV cache bytes per token, for a rough context adjustment.
 *
 * This is the part that actually scales with context, and it is the reason a
 * 30K-context request needs more RAM than a 2K one for the same weight. The
 * value is a rough order of magnitude for a mid-size model on CPU; it is used
 * only to widen the estimate, never to decide fit on its own.
 */
const KV_BYTES_PER_TOKEN = 256 * 1024;

/**
 * Estimate what a weight needs and whether it fits here.
 *
 * `contextLength` is optional and, when given, only widens the estimate.
 */
export function assessFit(
  weightBytes: number,
  machine: Partial<MachineInfo>,
  options: { contextLength?: number } = {},
): FitReport {
  const totalMemory = machine.totalMemory ?? 0;
  const freeMemory = machine.freeMemory ?? 0;
  const diskFree = machine.diskFree ?? 0;

  const notes: string[] = [];

  // The floor. mmapping a weight larger than physical RAM does not load, so
  // this comparison is not a heuristic.
  const estimatedRam = Math.ceil(weightBytes * RUNTIME_OVERHEAD);
  const estimatedRamAtContext = options.contextLength
    ? estimatedRam + options.contextLength * KV_BYTES_PER_TOKEN
    : undefined;

  // Compare against the smaller of the two figures, and say which was used:
  // a model that fits in 64 GB but not in the 2 GB currently free will thrash
  // on a machine with room on paper.
  const bindingMemory = freeMemory > 0 && freeMemory < totalMemory ? freeMemory : totalMemory;
  const fitsRam = bindingMemory === 0 ? true : weightBytes <= bindingMemory;
  const fitsDisk = diskFree === 0 || weightBytes <= diskFree;

  if (totalMemory > 0 && weightBytes > totalMemory) {
    notes.push(
      'The weights are larger than this machine\'s physical memory, so this ' +
        'cannot load here no matter how much RAM is free.',
    );
  } else if (freeMemory > 0 && weightBytes > freeMemory) {
    notes.push(
      'The weights exceed currently free memory. They may still load if ' +
        'other applications release memory first.',
    );
  }

  if (diskFree > 0 && weightBytes > diskFree) {
    notes.push('There is not enough free disk space for the download.');
  }

  if (totalMemory === 0) {
    notes.push('Memory could not be measured, so this is not a fit check.');
  }

  return {
    weightBytes,
    estimatedRam,
    ...(estimatedRamAtContext === undefined ? {} : { estimatedRamAtContext }),
    fitsRam,
    fitsDisk,
    notes,
  };
}

/**
 * Narrow a machine reading that crossed a process boundary.
 *
 * Every field is coerced: a renderer that received a string, a negative, or a
 * NaN would otherwise propagate it into a fit comparison, where `weightBytes <=`
 * against NaN is false and a machine with plenty of RAM would be reported as
 * unable to load anything.
 */
export function sanitizeMachineInfo(raw: unknown): MachineInfo {
  const value = (raw ?? {}) as Partial<Record<keyof MachineInfo, unknown>>;
  const num = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : 0;
  const totalMemory = num(value.totalMemory);
  return {
    totalMemory,
    freeMemory: num(value.freeMemory),
    cpuCount: num(value.cpuCount),
    diskFree: num(value.diskFree),
    diskTotal: num(value.diskTotal),
    degraded: value.degraded === true || totalMemory === 0,
  };
}

/** Human-readable bytes, binary units, matching the catalog's GiB figures. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown';
  const gib = bytes / 1073741824;
  if (gib >= 10) return `${Math.round(gib)} GiB`;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1048576)} MB`;
}