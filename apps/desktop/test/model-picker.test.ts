import { describe, expect, it } from 'vitest';

import {
  AUTO_INSTALL_LIMIT,
  groupEntries,
  matchesQuery,
  planSelection,
  progressLabel,
  type ModelPickerEntry,
} from '../src/model-picker.js';

const weight = (bytes: number, present = false): ModelPickerEntry => ({
  id: 'm',
  label: 'm',
  present,
  download: { bytes },
});

describe('planSelection', () => {
  it('selects an on-disk weight without installing', async () => {
    const entry = weight(1e9, true);
    const plan = await planSelection(entry, async () => {
      throw new Error('must not ask for an installed weight');
    });
    expect(plan).toEqual({ install: false, select: true });
  });

  it('selects a non-downloadable row immediately', async () => {
    const entry: ModelPickerEntry = { id: '', label: 'Auto' };
    const plan = await planSelection(entry, async () => {
      throw new Error('Auto has nothing to install');
    });
    expect(plan).toEqual({ install: false, select: true });
  });

  it('auto-installs a weight under the limit without asking', async () => {
    const entry = weight(AUTO_INSTALL_LIMIT - 1);
    const plan = await planSelection(entry, async () => {
      throw new Error('small weights must not ask');
    });
    expect(plan).toEqual({ install: true, select: true });
  });

  it('asks before installing a weight at or above the limit', async () => {
    const entry = weight(AUTO_INSTALL_LIMIT);
    const plan = await planSelection(entry, async () => true);
    expect(plan).toEqual({ install: true, select: true });
  });

  it('drops the selection when the user declines a large weight', async () => {
    const entry = weight(AUTO_INSTALL_LIMIT);
    const plan = await planSelection(entry, async () => false);
    expect(plan).toEqual({ install: false, select: false });
  });
});


describe('matchesQuery', () => {
  const entry: ModelPickerEntry = {
    id: 'qwen2.5-coder-7b',
    label: 'qwen2.5-coder-7b',
    detail: '4.4 GB',
    license: 'Apache-2.0',
  };

  it('shows everything for an empty query', () => {
    expect(matchesQuery(entry, '')).toBe(true);
    expect(matchesQuery(entry, '   ')).toBe(true);
  });

  it('matches on the label, ignoring case', () => {
    expect(matchesQuery(entry, 'QWEN')).toBe(true);
    expect(matchesQuery(entry, 'qwen2.5-coder')).toBe(true);
  });

  it('matches on the size and the licence, not just the name', () => {
    // A user looking for a licence, or checking what a weight costs them in
    // disk, should not have to remember the model name to find it.
    expect(matchesQuery(entry, 'apache')).toBe(true);
    expect(matchesQuery(entry, '4.4')).toBe(true);
  });

  it('narrows on multiple terms rather than widening', () => {
    // Every term must match, so "qwen coder" finds fewer rows than "qwen".
    // A substring match on the joined string would do the opposite.
    expect(matchesQuery(entry, 'qwen coder')).toBe(true);
    expect(matchesQuery(entry, 'qwen llama')).toBe(false);
  });

  it('rejects a query that matches nothing', () => {
    expect(matchesQuery(entry, 'gemma')).toBe(false);
  });

  it('does not let whitespace split a model name', () => {
    // A user typing "qwen2.5  coder" with a stray space should still find it.
    expect(matchesQuery({ id: 'a b', label: 'a b' }, 'a  b')).toBe(true);
  });
});

describe('groupEntries', () => {
  it('keeps adjacent rows under one heading', () => {
    const rows: ModelPickerEntry[] = [
      { id: '1', label: '1', group: 'code' },
      { id: '2', label: '2', group: 'code' },
      { id: '3', label: '3', group: 'general' },
    ];
    expect(groupEntries(rows).map((g) => g.group)).toEqual(['code', 'general']);
    expect(groupEntries(rows)[0]?.entries).toHaveLength(2);
  });

  it('omits a heading for rows with no group', () => {
    // Auto carries no group, and an empty heading above it would be a
    // meaningless label.
    const groups = groupEntries([{ id: '', label: 'Auto' }]);
    expect(groups).toEqual([{ group: '', entries: [{ id: '', label: 'Auto' }] }]);
  });

  it('does not merge two runs of the same group', () => {
    // The catalog is ordered by group, so a repeated name later in the list is
    // a distinct section, not a continuation.
    const rows: ModelPickerEntry[] = [
      { id: '1', label: '1', group: 'code' },
      { id: '2', label: '2', group: 'general' },
      { id: '3', label: '3', group: 'code' },
    ];
    expect(groupEntries(rows).map((g) => g.group)).toEqual(['code', 'general', 'code']);
  });
});

describe('progressLabel', () => {
  it('reports bytes against a known total', () => {
    expect(progressLabel('qwen3-1.7b', { done: 157286400, total: 314572800 })).toBe(
      'Installing qwen3-1.7b — 150 MB of 300 MB (50%)',
    );
  });

  it('never reports more than 100 percent', () => {
    // A server that over-reports content-length must not produce "112%".
    const label = progressLabel('m', { done: 200, total: 100 });
    expect(label).toContain('(100%)');
  });

  it('does not claim a percentage when the total is unknown', () => {
    // A server that sends no content-length gives total 0, and "0%" would be
    // a lie rather than an admission of not knowing.
    const label = progressLabel('m', { done: 1048576, total: 0 });
    expect(label).toBe('Installing m — 1 MB so far');
    expect(label).not.toContain('%');
  });
});
