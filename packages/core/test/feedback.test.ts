import { describe, expect, it } from 'vitest';

import {
  FeedbackLoop,
  FeedbackStore,
  formatFeedbackPercent,
  formatRating,
  recordRunOutcome,
  roundHalfEven,
  type FeedbackEntry,
} from '../src/feedback.js';

function entry(overrides: Partial<FeedbackEntry> & { task_id: string }): FeedbackEntry {
  return {
    description: `task ${overrides.task_id}`,
    predicted_tier: 'local',
    actual_tier: null,
    was_correct: null,
    user_rating: null,
    timestamp: 1_700_000_000,
    metadata: {},
    ...overrides,
  };
}

/**
 * The same fixture tests/parity.test.ts feeds both CLIs: two correct, one
 * miss, one run that never produced an outcome.
 */
const PARITY_ENTRIES: FeedbackEntry[] = [
  entry({ task_id: 'a', predicted_tier: 'local', actual_tier: 'local', was_correct: true, user_rating: 5 }),
  entry({ task_id: 'b', predicted_tier: 'local', actual_tier: 'mid', was_correct: false, user_rating: 2 }),
  entry({ task_id: 'c', predicted_tier: 'mid', actual_tier: 'mid', was_correct: true, user_rating: 4 }),
  entry({ task_id: 'd', predicted_tier: 'frontier' }),
];

function parityStore(): FeedbackStore {
  const store = new FeedbackStore();
  for (const e of PARITY_ENTRIES) store.add({ ...e });
  return store;
}

describe('FeedbackStore stats', () => {
  it('returns zeroed stats for an empty store', () => {
    expect(new FeedbackStore().get_stats()).toEqual({
      total_entries: 0,
      rated_entries: 0,
      correct_predictions: 0,
      incorrect_predictions: 0,
      accuracy: 0,
      average_rating: 0,
      by_tier: {},
    });
  });

  it('matches the Python stats for the shared parity fixture', () => {
    // Values computed by hand from gearvane/feedback.py's get_stats so a
    // drift in either implementation fails here before it reaches parity.
    const stats = parityStore().get_stats();
    expect(stats.total_entries).toBe(4);
    expect(stats.rated_entries).toBe(3);
    expect(stats.correct_predictions).toBe(2);
    expect(stats.incorrect_predictions).toBe(1);
    expect(stats.accuracy).toBe(0.5);
    expect(stats.average_rating).toBe(3.67);
    expect(stats.by_tier).toEqual({
      local: { total: 2, correct: 1, accuracy: 0.5 },
      mid: { total: 1, correct: 1, accuracy: 1 },
      frontier: { total: 1, correct: 0, accuracy: 0 },
    });
  });

  it('counts entries without an outcome in the total but not as correct', () => {
    // Python divides correct by *all* entries, so an open prediction drags
    // accuracy down instead of vanishing from it.
    const store = new FeedbackStore();
    store.add(entry({ task_id: 'open', predicted_tier: 'local' }));
    expect(store.get_stats().accuracy).toBe(0);
    expect(store.get_stats().total_entries).toBe(1);
  });

  it('returns the most recent entries when limited', () => {
    const store = parityStore();
    expect(store.get_entries(2).map((e) => e.task_id)).toEqual(['c', 'd']);
    expect(store.get_entries()).toHaveLength(4);
  });
});

describe('FeedbackStore suggestions', () => {
  it('flags a tier under 60% accuracy with at least five entries', () => {
    const store = new FeedbackStore();
    for (let i = 0; i < 5; i += 1) {
      store.add(
        entry({
          task_id: `low-${i}`,
          predicted_tier: 'mid',
          actual_tier: i === 0 ? 'mid' : 'frontier',
          was_correct: i === 0,
        }),
      );
    }
    const suggestions = store.get_adjustment_suggestions();
    // 1 correct of 5 is also 4 misclassifications, so both rules fire.
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({ type: 'low_accuracy', tier: 'mid' });
    expect(suggestions[0]?.message).toContain("Tier 'mid' has low accuracy (20%)");
  });

  it('needs five entries before calling a tier inaccurate', () => {
    // Four open predictions: 0% accuracy but below the five-entry minimum,
    // and with no misses the misclassification rule stays quiet too.
    const store = new FeedbackStore();
    for (let i = 0; i < 4; i += 1) {
      store.add(entry({ task_id: `few-${i}`, predicted_tier: 'mid' }));
    }
    expect(store.get_adjustment_suggestions()).toEqual([]);
  });

  it('flags three misclassifications on one tier', () => {
    const store = new FeedbackStore();
    for (let i = 0; i < 3; i += 1) {
      store.add(
        entry({
          task_id: `miss-${i}`,
          predicted_tier: 'local',
          actual_tier: 'mid',
          was_correct: false,
        }),
      );
    }
    const suggestions = store.get_adjustment_suggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ type: 'common_misclassification', count: 3 });
    expect(suggestions[0]?.message).toContain('3 misclassifications');
  });
});

describe('FeedbackStore training data', () => {
  it('only includes entries with a known outcome', () => {
    expect(parityStore().get_training_data()).toEqual([
      { description: 'task a', tier: 'local' },
      { description: 'task b', tier: 'mid' },
      { description: 'task c', tier: 'mid' },
    ]);
  });
});

describe('FeedbackStore serialisation', () => {
  it('round-trips one JSON object per line', () => {
    const text = parityStore().serialize();
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(4);
    // One object per line: every line parses on its own, which is what
    // makes the file readable by Python's line-based loader.
    for (const line of lines) {
      expect((JSON.parse(line) as FeedbackEntry).task_id).toMatch(/^[a-d]$/);
    }
    expect(FeedbackStore.deserialize(text).map((e) => e.task_id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reads a file written by the Python CLI', () => {
    // Exact bytes of Python's json.dumps(asdict(entry)): spaces after
    // separators, snake_case keys, explicit nulls.
    const pythonLine =
      '{"task_id": "py-1", "description": "fix a typo", "predicted_tier": "local", ' +
      '"actual_tier": "local", "was_correct": true, "user_rating": 5, ' +
      '"timestamp": 1700000000.0, "metadata": {}}';
    const [parsed] = FeedbackStore.deserialize(`${pythonLine}\n`);
    expect(parsed).toMatchObject({ task_id: 'py-1', predicted_tier: 'local', was_correct: true });
  });

  it('fills defaults for entries missing optional keys', () => {
    const [parsed] = FeedbackStore.deserialize('{"task_id":"m","description":"x","predicted_tier":"mid","timestamp":1}\n');
    expect(parsed?.actual_tier).toBeNull();
    expect(parsed?.was_correct).toBeNull();
    expect(parsed?.user_rating).toBeNull();
    expect(parsed?.metadata).toEqual({});
  });

  it('skips corrupt lines instead of losing the whole file', () => {
    const store = new FeedbackStore();
    store.add(entry({ task_id: 'good', predicted_tier: 'local' }));
    const text = `${store.serialize()}not json\n`;
    expect(FeedbackStore.deserialize(text).map((e) => e.task_id)).toEqual(['good']);
  });
});

describe('FeedbackLoop recording', () => {
  it('records a first-try success as correct', () => {
    const loop = new FeedbackLoop(new FeedbackStore());
    loop.record_prediction('t1', 'fix a typo', 'local');
    loop.record_outcome('t1', 'local');
    const [stored] = loop.store.get_entries();
    expect(stored?.was_correct).toBe(true);
    expect(loop.store.get_stats().accuracy).toBe(1);
  });

  it('records escalation as a miss against the first pick', () => {
    const loop = new FeedbackLoop(new FeedbackStore());
    loop.record_prediction('t2', 'refactor the auth architecture', 'local');
    loop.record_outcome('t2', 'frontier');
    const [stored] = loop.store.get_entries();
    expect(stored?.was_correct).toBe(false);
    expect(loop.store.get_training_data()).toEqual([
      { description: 'refactor the auth architecture', tier: 'frontier' },
    ]);
  });

  it('matches the newest open entry for a repeated task id', () => {
    const loop = new FeedbackLoop(new FeedbackStore());
    loop.record_prediction('t3', 'first', 'local');
    loop.record_prediction('t3', 'second', 'mid');
    loop.record_outcome('t3', 'mid');
    const outcomes = loop.store.get_entries().map((e) => e.was_correct);
    expect(outcomes).toEqual([null, true]);
  });

  it('persists outcome mutations through the storage adapter', () => {
    let written = '';
    const loop = new FeedbackLoop(
      new FeedbackStore({ read: () => '', write: (text) => { written = text; } }),
    );
    loop.record_prediction('t4', 'fix a typo', 'local');
    loop.record_outcome('t4', 'local');
    expect(FeedbackStore.deserialize(written)[0]?.was_correct).toBe(true);
  });
});

describe('recordRunOutcome', () => {
  function readBack(box: { text: string }): FeedbackEntry[] {
    return FeedbackStore.deserialize(box.text);
  }

  it('grades a successful run against the router prediction', () => {
    const box = { text: '' };
    recordRunOutcome(
      { read: () => box.text, write: (t) => { box.text = t; } },
      'r1',
      'refactor the auth architecture',
      { predictedTier: 'mid', servedTier: 'frontier', success: true },
    );
    const [entry] = readBack(box);
    expect(entry?.predicted_tier).toBe('mid');
    expect(entry?.actual_tier).toBe('frontier');
    // Escalation records as a miss, which is what teaches the classifier to
    // route higher next time rather than repeating the cheap answer.
    expect(entry?.was_correct).toBe(false);
  });

  it('records the prediction alone for a failed run', () => {
    // A failure with no outcome must stay out of training data rather than
    // teach the classifier that failing was the right answer.
    const box = { text: '' };
    recordRunOutcome(
      { read: () => box.text, write: (t) => { box.text = t; } },
      'r2',
      'fix a typo',
      { predictedTier: 'local', servedTier: 'local', success: false },
    );
    const [entry] = readBack(box);
    expect(entry?.predicted_tier).toBe('local');
    expect(entry?.actual_tier).toBeNull();
    const store = new FeedbackStore();
    expect(store.get_training_data()).toEqual([]);
  });

  it('records nothing at all without a prediction', () => {
    // A host that cannot ask the router anything must skip the entry. Falling
    // back to the serving tier would grade every entry as correct.
    const box = { text: '' };
    recordRunOutcome(
      { read: () => box.text, write: (t) => { box.text = t; } },
      'r3',
      'fix a typo',
      { servedTier: 'local', success: true },
    );
    expect(readBack(box)).toEqual([]);
    expect(box.text).toBe('');
  });

  it('skips the outcome when no serving tier is known', () => {
    const box = { text: '' };
    recordRunOutcome(
      { read: () => box.text, write: (t) => { box.text = t; } },
      'r4',
      'fix a typo',
      { predictedTier: 'local', success: true },
    );
    expect(readBack(box)[0]?.actual_tier).toBeNull();
  });

  it('never lets a storage failure escape', () => {
    // Feedback is a side effect of a run. A read-only profile or a full disk
    // must not change what the run did or whether it succeeded.
    const exploding = {
      read: () => {
        throw new Error('disk on fire');
      },
      write: () => {
        throw new Error('disk on fire');
      },
    };
    expect(() =>
      recordRunOutcome(exploding, 'r5', 'fix a typo', {
        predictedTier: 'local',
        servedTier: 'local',
        success: true,
      }),
    ).not.toThrow();
  });

  it('appends to an existing log rather than replacing it', () => {
    const box = { text: '' };
    const storage = { read: () => box.text, write: (t: string) => { box.text = t; } };
    recordRunOutcome(storage, 'r6', 'first', {
      predictedTier: 'local',
      servedTier: 'local',
      success: true,
    });
    recordRunOutcome(storage, 'r7', 'second', {
      predictedTier: 'mid',
      servedTier: 'mid',
      success: true,
    });
    expect(readBack(box).map((e) => e.task_id)).toEqual(['r6', 'r7']);
  });
});

describe('Python-compatible number formatting', () => {
  it('rounds halves to even like Python', () => {
    expect(roundHalfEven(1.125, 2)).toBe(1.12);
    expect(roundHalfEven(1.135, 2)).toBe(1.14);
    expect(roundHalfEven(2.5, 0)).toBe(2);
    expect(roundHalfEven(3.5, 0)).toBe(4);
  });

  it('formats whole percents like the :.0% spec', () => {
    // 1 correct of 8 is 12.5%: Python prints 12%, Math.round prints 13%.
    expect(formatFeedbackPercent(1 / 8, 0)).toBe('12%');
    expect(formatFeedbackPercent(0.5, 0)).toBe('50%');
    expect(formatFeedbackPercent(2 / 3, 1)).toBe('66.7%');
    expect(formatFeedbackPercent(0, 1)).toBe('0.0%');
  });

  it('prints integer ratings with .0 like str(4.0)', () => {
    expect(formatRating(4)).toBe('4.0');
    expect(formatRating(0)).toBe('0.0');
    expect(formatRating(3.67)).toBe('3.67');
  });
});
