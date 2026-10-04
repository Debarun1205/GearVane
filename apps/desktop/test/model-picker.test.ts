import { describe, expect, it } from 'vitest';

import {
  AUTO_INSTALL_LIMIT,
  planSelection,
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
