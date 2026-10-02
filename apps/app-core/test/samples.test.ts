import { describe, expect, it } from 'vitest';

import { TaskClassifier } from '@waypoint/core';

import { SAMPLE_PROMPTS, sampleById, samplesByTier } from '../src/samples.js';

const classifier = new TaskClassifier();

describe('sample prompts', () => {
  it('exposes a non-trivial set', () => {
    expect(SAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every sample a unique id', () => {
    const ids = SAMPLE_PROMPTS.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every sample a title, prompt, and rationale', () => {
    for (const sample of SAMPLE_PROMPTS) {
      expect(sample.title.length).toBeGreaterThan(0);
      expect(sample.prompt.length).toBeGreaterThan(10);
      expect(sample.why.length).toBeGreaterThan(10);
    }
  });

  it('covers all three tiers', () => {
    const grouped = samplesByTier();
    for (const tier of ['local', 'mid', 'frontier'] as const) {
      expect(grouped[tier].length).toBeGreaterThan(0);
    }
  });

  it('routes each sample to the tier it claims', () => {
    // The samples are the first thing a new user sees, so a sample that
    // claims "local" but routes to "frontier" is actively misleading.
    const mismatches: string[] = [];

    for (const sample of SAMPLE_PROMPTS) {
      const result = classifier.classify({
        description: sample.prompt,
        filesTouched: [],
        errorLoops: 0,
        testFailures: 0,
      });
      if (result.tier !== sample.expectedTier) {
        mismatches.push(
          `${sample.id}: expected ${sample.expectedTier}, got ${result.tier}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('finds a sample by id', () => {
    const first = SAMPLE_PROMPTS[0];
    expect(sampleById(first?.id ?? '')).toEqual(first);
  });

  it('returns undefined for an unknown id', () => {
    expect(sampleById('nope')).toBeUndefined();
  });

  it('keeps each tier group in source order', () => {
    const grouped = samplesByTier();
    const localIds = grouped.local.map((sample) => sample.id);
    expect(localIds).toEqual(
      SAMPLE_PROMPTS.filter((s) => s.expectedTier === 'local').map((s) => s.id),
    );
  });
});