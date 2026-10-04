/**
 * `feedback` and `train` commands for the TypeScript CLI.
 *
 * These mirror waypoint/cli.py's cmd_feedback and cmd_train line for line:
 * same config keys, same human-readable output, same --json shapes, same
 * exit codes. tests/parity.test.ts runs both CLIs against one shared
 * feedback file, so any drift here is caught rather than documented.
 *
 * File I/O lives here, not in @waypoint/core, so the core bundle stays
 * loadable in a browser and an Android webview.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  FeedbackLoop,
  FeedbackStore,
  LearnedClassifier,
  formatFeedbackPercent,
  formatRating,
  serializeWeights,
  type FeedbackStorage,
  type SerializedWeights,
  type Tier,
  type WaypointConfig,
} from '@waypoint/core';

import { flagNumber, type ParsedArgs } from './args.js';

/** Local tiers, in the order both CLIs print them. */
const TIERS: readonly Tier[] = ['local', 'mid', 'frontier'];

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * Where `feedback` reads entries from: logging.feedback_file, defaulting to
 * feedback.jsonl in the working directory. Mirrors Python's cmd_feedback,
 * which reads config["logging"]["feedback_file"]; relative paths resolve
 * against the working directory on both sides.
 */
export function feedbackFileFor(config: WaypointConfig): string {
  return config.logging.feedbackFile ?? 'feedback.jsonl';
}

/**
 * Where `train` reads entries from: learned_classifier.feedback_file first,
 * then logging.feedback_file. Mirrors Python's cmd_train fallback chain.
 */
export function trainFeedbackFileFor(config: WaypointConfig): string {
  return (
    config.learnedClassifier.feedbackFile ?? config.logging.feedbackFile ?? 'feedback.jsonl'
  );
}

/** fs-backed storage for the feedback file. Missing files read as empty. */
export function fileFeedbackStorage(path: string): FeedbackStorage {
  return {
    read(): string {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    },
    write(text: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    },
  };
}

/**
 * Load the trained model for routing.
 *
 * Returns undefined when the learned classifier is disabled, when no model
 * file exists, or when it cannot be parsed — the router then falls back to
 * heuristics, exactly like the Python router's "using heuristics only"
 * path. A corrupt file must never break `route`.
 */
export function loadLearnedModel(config: WaypointConfig): SerializedWeights | undefined {
  if (!config.learnedClassifier.enabled) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(config.learnedClassifier.modelFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as SerializedWeights;
  } catch {
    return undefined;
  }
}

export function cmdFeedback(config: WaypointConfig, json: boolean): number {
  const loop = new FeedbackLoop(new FeedbackStore(fileFeedbackStorage(feedbackFileFor(config))));
  const stats = loop.store.get_stats();

  if (json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return 0;
  }

  // Mirrors Python cmd_feedback exactly: "Entries:  N" (two spaces),
  // "Accuracy: N.N%", "Rating:   R", then sorted by-tier lines and
  // suggestions, each preceded by a blank line.
  process.stdout.write(`Entries:  ${stats.total_entries}\n`);
  process.stdout.write(`Accuracy: ${formatFeedbackPercent(stats.accuracy, 1)}\n`);
  process.stdout.write(`Rating:   ${formatRating(stats.average_rating)}\n`);

  const tiers = Object.keys(stats.by_tier).sort();
  if (tiers.length > 0) {
    process.stdout.write('\nBy tier:\n');
    for (const tier of tiers) {
      const data = stats.by_tier[tier] as { total: number; correct: number; accuracy: number };
      process.stdout.write(
        `  ${tier.padEnd(12)} ${data.correct}/${data.total} ` +
          `(${formatFeedbackPercent(data.accuracy, 0)})\n`,
      );
    }
  }

  const suggestions = loop.get_adjustment_suggestions();
  if (suggestions.length > 0) {
    process.stdout.write('\nSuggestions:\n');
    for (const suggestion of suggestions) {
      process.stdout.write(`  - ${suggestion.message}\n`);
    }
  }
  return 0;
}

export function cmdTrain(args: ParsedArgs, config: WaypointConfig, json: boolean): number {
  const feedbackPath = trainFeedbackFileFor(config);
  const modelPath = config.learnedClassifier.modelFile;

  // A missing file means no labelled feedback, not a crash: Python's
  // FeedbackStore skips loading when the path does not exist, trains on
  // nothing, and exits 1 with the same message.
  const store = new FeedbackStore(fileFeedbackStorage(feedbackPath));

  // Labels outside the three tiers can only come from a hand-edited or
  // corrupt file. Python raises on them; skipping keeps one bad line from
  // blocking training, and the line is still visible in `feedback`.
  const samples: Array<{ description: string; tier: Tier }> = [];
  for (const sample of store.get_training_data()) {
    if (isTier(sample.tier)) samples.push({ description: sample.description, tier: sample.tier });
  }

  const classifier = new LearnedClassifier({
    learningRate: flagNumber(args, 'learning-rate') ?? 0.5,
    epochs: flagNumber(args, 'epochs') ?? 50,
    l2: flagNumber(args, 'l2') ?? 0.001,
  });
  classifier.train(samples);

  if (!classifier.isTrained) {
    process.stderr.write(`No labelled feedback found at ${feedbackPath}\n`);
    process.stderr.write('Run some tasks and record outcomes before training.\n');
    return 1;
  }

  const serialized = serializeWeights(classifier.weights);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');

  if (json) {
    // Python's --json shape exactly: weights, bias, trained_on, accuracy.
    // serializeWeights also carries the camelCase alias for TS readers.
    process.stdout.write(
      `${JSON.stringify(
        {
          weights: serialized.weights,
          bias: serialized.bias,
          trained_on: serialized.trainedOn,
          accuracy: serialized.accuracy,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  // Mirrors Python cmd_train text: "Samples:  N" (two spaces), tier names
  // padded to 10, top 5 features per tier.
  process.stdout.write(`Model saved to ${modelPath}\n`);
  process.stdout.write(`Samples:  ${classifier.weights.trainedOn}\n`);
  process.stdout.write(`Accuracy: ${formatFeedbackPercent(classifier.weights.accuracy, 1)}\n`);
  process.stdout.write('\nStrongest features per tier:\n');
  for (const tier of TIERS) {
    const features = classifier.topFeatures(tier, 5);
    if (features.length === 0) continue;
    const rendered = features.map((f) => `${f.feature} (${formatRating(f.weight)})`).join(', ');
    process.stdout.write(`  ${tier.padEnd(10)} ${rendered}\n`);
  }
  return 0;
}

/**
 * Record a completed run into the feedback loop: the predicted tier is the
 * first attempt's tier (the router's initial pick), the actual tier is the
 * tier that served the request. Escalation therefore records as a miss,
 * which is what teaches the classifier to route higher next time. Failed
 * runs record the prediction with no outcome, so they never enter training
 * data. Storage failures are swallowed: feedback must never break a run.
 */
export function recordRunFeedback(
  config: WaypointConfig,
  taskId: string,
  description: string,
  result: { history?: Array<{ tier: Tier }>; tier?: Tier; success: boolean },
): void {
  try {
    const history = result.history ?? [];
    const predicted = history.length > 0 ? history[0]?.tier : result.tier;
    if (!predicted) return;
    const loop = new FeedbackLoop(new FeedbackStore(fileFeedbackStorage(feedbackFileFor(config))));
    loop.record_prediction(taskId, description, predicted);
    if (result.success && result.tier) {
      loop.record_outcome(taskId, result.tier);
    }
  } catch {
    // Feedback I/O must never change a run's exit code.
  }
}
