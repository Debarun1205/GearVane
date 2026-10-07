/**
 * What to provision on first launch, and what to skip.
 *
 * Four weights are meant to be ready at first boot. Two are inside the
 * installer. The other two -- one mid, one high, 9.04 GiB -- are fetched in the
 * background on first launch, with no prompt: the user installed the app, which
 * is the permission, and a prompt on first boot for something the app already
 * promises would be asking about something already decided.
 *
 * What it must not do is start a transfer the machine cannot finish. Two of
 * these checks exist because the alternative is a 9 GiB download that fills a
 * disk or thrashes a machine, discovered after the fact:
 *
 *   free disk < size + margin     the file plus room to write it
 *   RAM < the weight file         weights are mmapped, so a file larger than
 *                                 physical memory cannot load at all
 *
 * The margin is deliberately generous. Reserving exactly the file size means
 * the download succeeds and leaves a volume at zero bytes, which on Windows is
 * a machine that then cannot write its own logs or swap.
 *
 * A skipped weight is not an error and is not silent: it comes back with a
 * reason the picker shows, so the user learns why the mid tier is empty rather
 * than concluding the app is broken.
 */
import { assessFit, type MachineInfo } from './hardware.js';

/** Ready-at-first-boot weights that are not inside the installer. */
export interface ProvisionCandidate {
  id: string;
  file: string;
  url: string;
  revision: string;
  sha256: string;
  bytes: number;
}

/**
 * Head-room to keep on the volume while a weight is downloading.
 *
 * 2 GiB. Not derived: this is a judgement about how much room an OS needs to
 * stay usable, and there is no formula for it. Stated as one number rather than
 * spread through the code so it can be argued with.
 */
export const DISK_SAFETY_MARGIN = 2 * 1073741824;

export type ProvisionDecision =
  | { id: string; action: 'fetch'; bytes: number }
  | {
      id: string;
      action: 'skip';
      bytes: number;
      /** One sentence, for the picker. Never a bare "no". */
      reason: string;
    };

export interface ProvisionPlan {
  decisions: ProvisionDecision[];
  /** Total bytes the plan will actually transfer. */
  planned: number;
  /** Total bytes skipped, so a caller can say "not because of you". */
  skipped: number;
}

/**
 * Decide, per candidate, whether to fetch it here.
 *
 * Pure: it takes the candidates and a machine reading and returns the plan. It
 * makes no network calls and touches no disk, which is what lets
 * tools/check-first-boot.mjs run it against a temp directory and a fake machine
 * without launching the app.
 *
 * `present` is the set already on disk. A candidate that is already there is
 * skipped with a different reason -- not "skipped" at all, really, so it is
 * reported as such rather than as a failure to provision.
 */
export function planProvisioning(
  candidates: readonly ProvisionCandidate[],
  machine: MachineInfo,
  present: ReadonlySet<string> = new Set(),
): ProvisionPlan {
  const decisions: ProvisionDecision[] = [];

  for (const entry of candidates) {
    if (present.has(entry.id)) {
      decisions.push({
        id: entry.id,
        action: 'skip',
        bytes: 0,
        reason: 'Already downloaded.',
      });
      continue;
    }

    const fit = assessFit(entry.bytes, machine);

    // The arithmetic floor first: a weight larger than physical RAM cannot
    // load, so there is no point spending disk on it.
    if (!fit.fitsRam) {
      decisions.push({
        id: entry.id,
        action: 'skip',
        bytes: entry.bytes,
        reason:
          `Needs ${formatGiB(entry.bytes)} of memory to load, and this machine ` +
          `has ${formatGiB(bindingMemory(machine))}. Weights are memory-mapped, ` +
          'so a file larger than RAM cannot run here.',
      });
      continue;
    }

    if (machine.diskFree > 0 && machine.diskFree < entry.bytes + DISK_SAFETY_MARGIN) {
      decisions.push({
        id: entry.id,
        action: 'skip',
        bytes: entry.bytes,
        reason:
          `Needs ${formatGiB(entry.bytes + DISK_SAFETY_MARGIN)} of free disk ` +
          `(the weight plus ${formatGiB(DISK_SAFETY_MARGIN)} to keep the volume ` +
          `usable), and this volume has ${formatGiB(machine.diskFree)} free.`,
      });
      continue;
    }

    decisions.push({ id: entry.id, action: 'fetch', bytes: entry.bytes });
  }

  return {
    decisions,
    planned: decisions.reduce((sum, d) => sum + (d.action === 'fetch' ? d.bytes : 0), 0),
    skipped: decisions.reduce((sum, d) => sum + (d.action === 'skip' ? d.bytes : 0), 0),
  };
}

/**
 * The memory figure fit is judged against: free where it is the smaller of the
 * two, total otherwise. Matches assessFit, and used only to phrase the reason.
 */
function bindingMemory(machine: MachineInfo): number {
  return machine.freeMemory > 0 && machine.freeMemory < machine.totalMemory
    ? machine.freeMemory
    : machine.totalMemory;
}

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'an unknown amount of';
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
