import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_FILE_NAME,
  feedbackFileIn,
  fileFeedbackStorage,
  predictedTierFor,
  recordAgentRun,
  runSucceeded,
  servedTierFor,
} from '../src/feedback-host.js';
import { FeedbackStore, defaultConfig, type FeedbackEntry } from '../../../packages/core/src/index.js';

/**
 * The recorder exists because the desktop app used to record nothing at all.
 * The tests below therefore assert what lands in the log, not just that a
 * call did not throw: an empty log is exactly the bug being fixed.
 */

const config = defaultConfig();

/** A configured provider/model pair to use as a stand-in for a real run. */
const SERVED = (() => {
  for (const [tier, entry] of Object.entries(config.tiers)) {
    const provider = entry.providers[0];
    const model = provider?.models[0];
    if (provider && model) return { tier, provider: provider.name, model };
  }
  throw new Error('the default config has no configured provider');
})();

/** A shared box the recorder writes through, so read() sees later writes. */
function emptyLog(): { text: string; read: () => FeedbackEntry[] } {
  const box = {
    text: '',
    read: () => FeedbackStore.deserialize(box.text),
  };
  return box;
}

describe('servedTierFor', () => {
  it('finds the tier a provider/model pair belongs to', () => {
    expect(servedTierFor(config.tiers, SERVED.provider, SERVED.model)).toBe(SERVED.tier);
  });

  it('returns undefined for a pair that is not configured', () => {
    // A stale label must never be recorded as fact.
    expect(servedTierFor(config.tiers, 'no-such-provider', 'no-such-model')).toBeUndefined();
  });

  it('does not match on provider alone', () => {
    expect(servedTierFor(config.tiers, SERVED.provider, 'no-such-model')).toBeUndefined();
  });
});

describe('runSucceeded', () => {
  it('counts a completed run as a success', () => {
    expect(runSucceeded('completed')).toBe(true);
  });

  it('counts a stop, a cancellation, and an error as failures', () => {
    // A cancelled run says nothing about tier choice: the user changed their
    // mind. Training on it would teach the classifier that quitting was right.
    expect(runSucceeded('cancelled')).toBe(false);
    expect(runSucceeded('model_error')).toBe(false);
    expect(runSucceeded('max_iterations')).toBe(false);
    expect(runSucceeded('repeated_tool_call')).toBe(false);
  });
});

describe('predictedTierFor', () => {
  it('returns a tier for a plain prompt', () => {
    expect(['local', 'mid', 'frontier']).toContain(predictedTierFor(config, 'fix a typo'));
  });

  it('does not leak escalation state between calls', () => {
    // Two predictions for the same prompt must agree. A shared router would
    // carry the first run's attempt counter into the second.
    const first = predictedTierFor(config, 'refactor the auth architecture');
    const second = predictedTierFor(config, 'refactor the auth architecture');
    expect(second).toBe(first);
  });
});

describe('recordAgentRun', () => {
  it('grades the run against the router prediction, not against itself', () => {
    // The regression this whole change exists to prevent: recording the
    // serving tier as the prediction would mark every entry correct and make
    // `gearvane feedback` report a meaningless 100% accuracy.
    const log = emptyLog();
    recordAgentRun(config, fileFeedbackStorageFor(log), 'fix a typo', {
      provider: SERVED.provider,
      model: SERVED.model,
      stopReason: 'completed',
    });
    const [entry] = log.read();
    expect(entry).toBeDefined();
    expect(entry?.description).toBe('fix a typo');
    expect(entry?.actual_tier).toBe(SERVED.tier);
    expect(entry?.predicted_tier).toBeTruthy();
    expect(entry?.predicted_tier).not.toBe('');
  });

  it('records a cancelled run as a prediction with no outcome', () => {
    const log = emptyLog();
    recordAgentRun(config, fileFeedbackStorageFor(log), 'fix a typo', {
      provider: SERVED.provider,
      model: SERVED.model,
      stopReason: 'cancelled',
    });
    const [entry] = log.read();
    expect(entry?.predicted_tier).toBeTruthy();
    expect(entry?.actual_tier).toBeNull();
  });
});

describe('fileFeedbackStorage', () => {
  it('round-trips through a real file named feedback.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gearvane-feedback-'));
    const path = feedbackFileIn(dir);
    expect(path.endsWith(FEEDBACK_FILE_NAME)).toBe(true);

    const storage = fileFeedbackStorage(path);
    // A first run has no file yet and must not need one.
    expect(storage.read()).toBe('');

    recordAgentRun(config, storage, 'build a static site', {
      provider: SERVED.provider,
      model: SERVED.model,
      stopReason: 'completed',
    });

    const entries = FeedbackStore.deserialize(readFileSync(path, 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.description).toBe('build a static site');
  });

  it('appends across sessions instead of truncating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gearvane-feedback-'));
    const storage = fileFeedbackStorage(feedbackFileIn(dir));
    for (const description of ['first', 'second', 'third']) {
      recordAgentRun(config, storage, description, {
        provider: SERVED.provider,
        model: SERVED.model,
        stopReason: 'completed',
      });
    }
    const entries = FeedbackStore.deserialize(storage.read());
    expect(entries.map((e) => e.description)).toEqual(['first', 'second', 'third']);
  });
});

/** Storage backed by an in-memory box, so tests do not need a temp dir. */
function fileFeedbackStorageFor(log: { text: string }): {
  read(): string;
  write(text: string): void;
} {
  return {
    read: () => log.text,
    write: (text: string) => {
      log.text = text;
    },
  };
}
