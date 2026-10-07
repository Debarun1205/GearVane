/**
 * What the catalog can and cannot do on the machine asking.
 *
 * The catalog lists fifty weights so the choice is visible. That is not the
 * same as saying GearVane can install fifty weights for you: six of them are
 * between 24 and 67 GiB, which is not a download, it is a commitment to a
 * machine most people do not own. Offering a one-click install for a 67 GiB
 * file is not a feature, it is a trap with a progress bar.
 *
 * Weights are memory-mapped, so a weight only loads if the *file* fits in
 * physical RAM before anything else is considered -- the arithmetic floor the
 * fit check already uses. Past the threshold below, the honest answer is that
 * GearVane will not fetch it for you, and the row says so rather than
 * pretending the download would work.
 *
 * The threshold is derived rather than annotated per entry, so a future
 * catalog addition cannot accidentally ship with a one-click button for
 * something no consumer machine can hold.
 */

/** One catalog row, as models.json declares it. */
export interface CatalogEntry {
  id: string;
  file: string;
  url: string;
  bytes: number;
  use: string;
  bundled: boolean;
  license: string;
  licenseUrl: string;
}

const GIB = 1073741824;

/**
 * Above this, the weight is listed but not offered.
 *
 * Every one of the fifty catalogued weights now installs with one click, so
 * this ceiling rejects nothing today. It stays as a tripwire rather than a
 * rule with a use: weights are memory-mapped, so a file larger than physical
 * RAM cannot load, and a catalog addition above this line would be a weight
 * no consumer machine holds.
 *
 * The six entries that used to sit far above it -- deepseek-v3 at 67 GiB, the
 * nemotron ultras, mixtral-8x7b -- did not resolve at all: their repositories
 * returned 401 or did not contain the named file. They have been replaced with
 * verified weights, not merely marked remote, because R1 requires all fifty to
 * be installable and a 404 is not an installable weight.
 */
export const REMOTE_ONLY_BYTES = 20 * GIB;

/** True when this weight is listed but GearVane will not download it. */
export function isRemoteOnly(entry: Pick<CatalogEntry, 'bytes'>): boolean {
  return entry.bytes > REMOTE_ONLY_BYTES;
}

/** Human-readable size, in whichever unit keeps it readable. */
export function formatSize(bytes: number): string {
  if (bytes >= GIB) {
    const gib = bytes / GIB;
    return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GiB`;
  }
  return `${Math.round(bytes / 1048576)} MB`;
}

/**
 * The picker's right-hand detail for a row.
 *
 * A remote-only weight states the size and that it is not being fetched, so
 * the row never reads as a stalled or broken download button.
 */
export function rowDetail(entry: Pick<CatalogEntry, 'bytes'>): string {
  const size = formatSize(entry.bytes);
  return isRemoteOnly(entry) ? `${size} - remote, bring your own server` : size;
}

/**
 * Why a remote-only weight cannot be installed, for the install dialog and
 * for anyone reading the catalog rather than the picker.
 *
 * Kept as its own sentence so the claim is quotable and testable instead of
 * being implied by an absent button.
 */
export function remoteOnlyReason(bytes: number): string {
  return (
    `${formatSize(bytes)} is above the ${formatSize(REMOTE_ONLY_BYTES)} ceiling for a ` +
    'one-click install: weights are memory-mapped, so the file has to fit in ' +
    'physical RAM before context or anything else. GearVane will not start this ' +
    'download. Point your own llama.cpp or Ollama server at the file instead.'
  );
}
