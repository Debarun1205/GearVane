/**
 * Feedback loop for improving classification accuracy over time.
 *
 * Mirrors gearvane/feedback.py exactly: same FeedbackEntry schema, same
 * stats keys, same suggestion messages, same training-data format. Core runs
 * unchanged in Node, a browser, an Electron renderer, and an Android
 * webview. The only host capability it needs is `fetch`; file I/O is
 * provided by the host CLI via injected storage callbacks.
 */

/**
 * Snake-case keys match the Python FeedbackEntry dataclass fields exactly.
 * This keeps the JSONL file interchangeable between the Python and
 * TypeScript CLIs: either engine can read a file the other wrote, which
 * tests/parity.test.ts pins by running both `feedback --json` commands
 * against one shared fixture.
 */
export interface FeedbackEntry {
  task_id: string;
  description: string;
  predicted_tier: string;
  actual_tier?: string | null;
  was_correct?: boolean | null;
  user_rating?: number | null;
  timestamp: number;
  metadata: Record<string, unknown>;
}

/**
 * Injected storage adapter so FeedbackStore stays browser-safe (no
 * node:fs in the core bundle). The host CLI provides an fs-backed
 * implementation; without one the store is purely in-memory.
 */
export interface FeedbackStorage {
  /** Returns the full JSONL text, or '' when the file does not exist. */
  read(): string;
  /** Write JSONL text, creating parent directories as needed. */
  write(text: string): void;
}

/**
 * Round half to even, mirroring Python's round() and the % format spec.
 *
 * Python uses banker's rounding (round(1.125, 2) is 1.12, not 1.13), so a
 * plain Math.round would diverge on exact halves. Exact halves only arise
 * from exactly representable binary fractions here (ratings and counts are
 * integers), where the scaled diff is exactly 0.5.
 */
export function roundHalfEven(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  const diff = scaled - lower;
  if (diff < 0.5) return lower / factor;
  if (diff > 0.5) return (lower + 1) / factor;
  return (lower % 2 === 0 ? lower : lower + 1) / factor;
}

/**
 * Format a 0..1 fraction as a percentage, mirroring Python's
 * f"{fraction:.{decimals}%}" (half-even rounding, then a % suffix).
 */
export function formatFeedbackPercent(fraction: number, decimals: number): string {
  return `${roundHalfEven(fraction * 100, decimals).toFixed(decimals)}%`;
}

/**
 * Format an average rating, mirroring Python's str(round(avg, 2)).
 *
 * Python prints integer-valued floats with a trailing ".0" (str(4.0) is
 * "4.0"), while String(4) is "4", so the integer case needs toFixed(1).
 */
export function formatRating(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

export interface TierAccuracy {
  total: number;
  correct: number;
  accuracy: number;
}

export interface FeedbackStats {
  total_entries: number;
  rated_entries: number;
  correct_predictions: number;
  incorrect_predictions: number;
  accuracy: number;
  average_rating: number;
  by_tier: Record<string, TierAccuracy>;
}

export interface AdjustmentSuggestion {
  type: 'low_accuracy' | 'common_misclassification';
  tier: string;
  accuracy?: number;
  count?: number;
  message: string;
}

/** Fill missing keys with Python's dataclass defaults (None/{}). */
function normaliseEntry(data: FeedbackEntry): FeedbackEntry {
  return {
    task_id: data.task_id,
    description: data.description,
    predicted_tier: data.predicted_tier,
    actual_tier: data.actual_tier ?? null,
    was_correct: data.was_correct ?? null,
    user_rating: data.user_rating ?? null,
    timestamp: data.timestamp,
    metadata: data.metadata ?? {},
  };
}

/**
 * FeedbackStore keeps entries in memory and persists via an injected
 * FeedbackStorage. When no storage is given the store is purely in-memory
 * (browser-safe).
 */
export class FeedbackStore {
  /** Entries held in RAM. */
  entries: FeedbackEntry[] = [];

  private readonly storage: FeedbackStorage | undefined;

  constructor(storage?: FeedbackStorage) {
    this.storage = storage;
    if (this.storage) {
      this.entries = FeedbackStore.deserialize(this.storage.read());
    }
  }

  /** Append an entry and persist when a storage adapter exists. */
  add(entry: FeedbackEntry): void {
    this.entries.push(entry);
    this.persist();
  }

  /** Write the current entries through the storage adapter, if any. */
  persist(): void {
    if (this.storage) {
      this.storage.write(this.serialize());
    }
  }

  /** Get a copy of all entries (optionally limited to the most recent N). */
  get_entries(limit?: number): FeedbackEntry[] {
    if (limit) return this.entries.slice(-limit);
    return this.entries.slice();
  }

  /**
   * Serialize all entries to JSONL text: one JSON object per line, exactly
   * like Python's per-entry json.dumps. Multi-line pretty printing would
   * break line-based parsing on the next load.
   */
  serialize(): string {
    if (this.entries.length === 0) return '';
    return `${this.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  }

  /**
   * Deserialize JSONL text into entries.
   *
   * Blank lines are skipped and corrupt lines are dropped. Python raises on
   * a corrupt line instead; dropping is a deliberate hardening so one bad
   * line cannot hide the whole feedback history from `feedback` and `train`.
   */
  static deserialize(text: string): FeedbackEntry[] {
    const entries: FeedbackEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(normaliseEntry(JSON.parse(trimmed) as FeedbackEntry));
      } catch {
        // Skip corrupt lines (see above).
      }
    }
    return entries;
  }

  /** Mirror Python FeedbackStore.get_stats() exactly. */
  get_stats(): FeedbackStats {
    const total = this.entries.length;
    if (total === 0) {
      return {
        total_entries: 0,
        rated_entries: 0,
        correct_predictions: 0,
        incorrect_predictions: 0,
        accuracy: 0,
        average_rating: 0,
        by_tier: {},
      };
    }

    const rated = this.entries.filter(
      (entry) => entry.user_rating !== null && entry.user_rating !== undefined,
    );
    const correct = this.entries.filter((entry) => entry.was_correct === true);
    const incorrect = this.entries.filter((entry) => entry.was_correct === false);

    // Average over rated entries only, rounded half-even to 2 decimals.
    const ratings = rated.map((entry) => entry.user_rating as number);
    const average_rating =
      ratings.length > 0
        ? roundHalfEven(ratings.reduce((a, b) => a + b, 0) / ratings.length, 2)
        : 0;

    // Accuracy by predicted tier, in first-seen order like Python's dict.
    const tierStats: Record<string, { total: number; correct: number }> = {};
    for (const entry of this.entries) {
      const tier = entry.predicted_tier;
      if (!tierStats[tier]) tierStats[tier] = { total: 0, correct: 0 };
      const stats = tierStats[tier] as { total: number; correct: number };
      stats.total += 1;
      if (entry.was_correct === true) stats.correct += 1;
    }

    const by_tier: Record<string, TierAccuracy> = {};
    for (const [tier, stats] of Object.entries(tierStats)) {
      by_tier[tier] = {
        total: stats.total,
        correct: stats.correct,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
      };
    }

    return {
      total_entries: total,
      rated_entries: rated.length,
      correct_predictions: correct.length,
      incorrect_predictions: incorrect.length,
      accuracy: correct.length / total,
      average_rating,
      by_tier,
    };
  }

  /** Mirror Python FeedbackLoop.get_adjustment_suggestions() exactly. */
  get_adjustment_suggestions(): AdjustmentSuggestion[] {
    const stats = this.get_stats();
    const suggestions: AdjustmentSuggestion[] = [];

    // Tiers under 60% accuracy with at least 5 entries.
    for (const [tier, tierStats] of Object.entries(stats.by_tier)) {
      if (tierStats.accuracy < 0.6 && tierStats.total >= 5) {
        suggestions.push({
          type: 'low_accuracy',
          tier,
          accuracy: tierStats.accuracy,
          message:
            `Tier '${tier}' has low accuracy ` +
            `(${formatFeedbackPercent(tierStats.accuracy, 0)}). Consider ` +
            'adjusting keywords or thresholds.',
        });
      }
    }

    // Tiers with at least 3 misclassifications.
    const misclassified = this.entries.filter((entry) => entry.was_correct === false);
    const byTierMisclass: Record<string, number> = {};
    for (const entry of misclassified) {
      byTierMisclass[entry.predicted_tier] = (byTierMisclass[entry.predicted_tier] ?? 0) + 1;
    }
    for (const [tier, count] of Object.entries(byTierMisclass)) {
      if (count >= 3) {
        suggestions.push({
          type: 'common_misclassification',
          tier,
          count,
          message: `Tier '${tier}' has ${count} misclassifications. Review recent tasks for patterns.`,
        });
      }
    }

    return suggestions;
  }

  /** Mirror Python FeedbackLoop.get_training_data() exactly. */
  get_training_data(): Array<{ description: string; tier: string }> {
    const samples: Array<{ description: string; tier: string }> = [];
    for (const entry of this.entries) {
      if (entry.actual_tier) {
        samples.push({ description: entry.description, tier: entry.actual_tier });
      }
    }
    return samples;
  }
}

/** Mirror Python FeedbackLoop exactly. */
export class FeedbackLoop {
  /** The store whose entries this loop manages. */
  readonly store: FeedbackStore;

  constructor(store: FeedbackStore) {
    this.store = store;
  }

  /**
   * Record a classification prediction.
   *
   * Creates an entry with no outcome yet and persists it, so an interrupted
   * run still leaves the prediction behind.
   */
  record_prediction(task_id: string, description: string, predicted_tier: string): FeedbackEntry {
    const entry: FeedbackEntry = {
      task_id,
      description,
      predicted_tier,
      actual_tier: null,
      was_correct: null,
      user_rating: null,
      timestamp: Date.now() / 1000,
      metadata: {},
    };
    this.store.add(entry);
    return entry;
  }

  /**
   * Record the actual outcome for a prediction.
   *
   * Finds the newest entry with the matching task_id that has no outcome
   * yet, then sets actual_tier, was_correct (predicted == actual), and
   * optionally user_rating, and persists the mutation.
   */
  record_outcome(task_id: string, actual_tier: string, user_rating?: number): void {
    const entries = this.store.get_entries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as FeedbackEntry;
      if (entry.task_id === task_id && entry.actual_tier == null) {
        entry.actual_tier = actual_tier;
        entry.was_correct = entry.predicted_tier === actual_tier;
        if (user_rating !== undefined) entry.user_rating = user_rating;
        this.store.persist();
        break;
      }
    }
  }

  /**
   * Analyze feedback and suggest classification adjustments.
   *
   * Delegates to the store, mirroring Python where the method lives on
   * FeedbackLoop.
   */
  get_adjustment_suggestions(): AdjustmentSuggestion[] {
    return this.store.get_adjustment_suggestions();
  }

  /**
   * Feedback entries with known outcomes, formatted for classifier
   * training. Delegates to the store, mirroring Python.
   */
  get_training_data(): Array<{ description: string; tier: string }> {
    return this.store.get_training_data();
  }
}
