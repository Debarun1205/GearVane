import { describe, expect, it } from 'vitest';

import { DEFAULT_EFFORT, EFFORTS, effortById, maxIterationsFor, maxTokensFor } from '../src/effort.js';

describe('effort', () => {
  it('offers the six Eigent-style efforts in order', () => {
    expect(EFFORTS.map((effort) => effort.label)).toEqual([
      'Low',
      'Default',
      'Medium',
      'High',
      'Extra High',
      'Max',
    ]);
    expect(DEFAULT_EFFORT).toBe('default');
  });

  it('maps effort to real budgets', () => {
    expect(maxTokensFor('low')).toBe(512);
    expect(maxTokensFor('default')).toBe(2048);
    expect(maxTokensFor('max')).toBe(32768);
    expect(maxIterationsFor('low')).toBe(5);
    expect(maxIterationsFor('max')).toBe(50);
    // Iteration budgets never exceed what the agent host accepts.
    for (const effort of EFFORTS) {
      expect(effort.maxIterations).toBeLessThanOrEqual(50);
    }
  });

  it('falls back to Default on anything unknown', () => {
    expect(effortById('nope').id).toBe('default');
    expect(maxTokensFor('')).toBe(2048);
  });
});
