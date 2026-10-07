import { describe, expect, it } from 'vitest';

import {
  REMOTE_ONLY_BYTES,
  formatSize,
  isRemoteOnly,
  remoteOnlyReason,
  rowDetail,
} from '../src/catalog.js';
import CATALOG from '../src/models.json';

interface Entry {
  id: string;
  bytes: number;
}

const entries = CATALOG as Entry[];

/**
 * The catalog lists fifty weights; that is not a claim that GearVane can
 * install fifty weights for you. These tests pin the boundary between the two,
 * because the failure mode is a 67 GiB download the user only discovers after
 * committing to it.
 */
describe('installability ceiling', () => {
  it('keeps every downloadable weight under the ceiling', () => {
    // R1: all fifty install with one click. Six entries used to sit at
    // 24-67 GiB and four of those repositories did not resolve at all; they are
    // now verified weights under the ceiling, so nothing is listed-but-not-
    // installable.
    const tooBig = entries.filter((e) => e.bytes > REMOTE_ONLY_BYTES);
    expect(tooBig.map((e) => e.id)).toEqual([]);
  });

  it('offers a download for the weights people can actually run', () => {
    // The bundled model and a normal small weight both stay installable, so
    // the ceiling never quietly becomes "nothing installs".
    expect(isRemoteOnly({ bytes: 270590592 })).toBe(false);
    expect(isRemoteOnly({ bytes: 1_500_000_000 })).toBe(false);
  });

  it('refuses the weights no consumer machine can hold', () => {
    // Weights are memory-mapped, so a file larger than RAM cannot load at all.
    expect(isRemoteOnly({ bytes: 24 * 1073741824 })).toBe(true);
    expect(isRemoteOnly({ bytes: 67.2 * 1073741824 })).toBe(true);
  });

  it('states the ceiling rather than leaving an unexplained gap', () => {
    const reason = remoteOnlyReason(67.2 * 1073741824);
    expect(reason).toContain('67 GiB');
    expect(reason).toContain('20 GiB');
    // The reason has to be actionable, not just a refusal.
    expect(reason).toMatch(/llama\.cpp|Ollama/i);
  });
});

describe('row labels', () => {
  it('says why a remote weight has no download', () => {
    // Otherwise an absent button reads as a bug or a stalled transfer.
    expect(rowDetail({ bytes: 26 * 1073741824 })).toContain('remote');
    expect(rowDetail({ bytes: 26 * 1073741824 })).toContain('bring your own server');
  });

  it('leaves an ordinary weight as a plain size', () => {
    const detail = rowDetail({ bytes: 270590592 });
    expect(detail).not.toContain('remote');
    expect(detail).toMatch(/258 MB/);
  });

  it('scales the unit so a 67 GiB row is not 68771801728 MB', () => {
    expect(formatSize(67.2 * 1073741824)).toBe('67 GiB');
    expect(formatSize(1.5 * 1073741824)).toBe('1.5 GiB');
    expect(formatSize(270590592)).toBe('258 MB');
  });
});
