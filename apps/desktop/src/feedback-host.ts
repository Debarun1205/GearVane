/**
 * Where the desktop app records what its runs actually cost in routing terms.
 *
 * The CLI closed its feedback loop in `packages/cli/src/bin.ts` and nowhere
 * else, so the app a visitor downloads never recorded a single entry: the
 * learned classifier stayed empty for exactly the people most likely to use
 * it. This is that missing recorder.
 *
 * ## The prediction, and why it is computed rather than observed
 *
 * The IDE agent does not route. `resolveIdeModel` in ide-agent-host.ts takes
 * the first configured provider, or the one the user picked, and hands the run
 * straight to the harness. There is therefore no router decision to grade
 * against -- recording "we picked what we picked" would mark every entry
 * correct and quietly inflate the accuracy numbers `gearvane feedback` prints.
 *
 * So the router is asked what it *would* have chosen, and that answer is used
 * purely as the prediction. It is never acted on: the model that runs is
 * still the one `resolveIdeModel` chose. What gets recorded is a genuine
 * disagreement between the heuristic and reality -- "the router would have
 * said frontier, the app served this on local and it worked" -- which is
 * exactly the signal that teaches the classifier to stop overshooting.
 *
 * The router sees only the prompt. The CLI's router also sees files touched,
 * error loops, and test failures as a run proceeds; none of those exist
 * before the app starts a run, so supplying them would mean predicting with
 * the answer. Entries recorded here are therefore slightly pessimistic
 * predictions, and are not directly comparable to the CLI's.
 *
 * ## Storage
 *
 * `feedback.jsonl` under the per-user app directory, so it is per-device and
 * survives restarts, matching where the key vault and models already live. The
 * file format is the CLI's JSONL exactly, so `gearvane feedback --json` can
 * read a file the app wrote and vice versa.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  TierRouter,
  recordRunOutcome,
  type FeedbackStorage,
  type GearVaneConfig,
} from '@gearvane/core';
import type { StopReason } from '@gearvane/harness';

/** Same file name and JSONL shape the CLI's `feedback` and `train` read. */
export const FEEDBACK_FILE_NAME = 'feedback.jsonl';

/**
 * Did the run actually do the job?
 *
 * `cancelled` is a failure for training purposes: the user stopped it, which
 * says nothing about whether the tier was right, so it records the
 * prediction with no outcome and stays out of the training data rather than
 * teaching the classifier that stopping early was a success.
 */
export function runSucceeded(stopReason: StopReason): boolean {
  return stopReason === 'completed';
}

/** The feedback file inside a given per-user directory. */
export function feedbackFileIn(directory: string): string {
  return join(directory, FEEDBACK_FILE_NAME);
}

/** The feedback file in this install's per-user directory. */
export function userDataFeedbackFile(): string {
  return feedbackFileIn(app.getPath('userData'));
}

/**
 * fs-backed feedback storage. A missing or unreadable file reads as empty,
 * which is what makes a first run work without a setup step.
 */
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
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text, 'utf8');
    },
  };
}

/**
 * The tier a provider/model pair belongs to, or undefined when the pair is
 * not configured. Looking it up rather than trusting a caller-supplied tier
 * keeps a stale label from being recorded as fact.
 */
export function servedTierFor(
  tiers: GearVaneConfig['tiers'],
  provider: string,
  model: string,
): string | undefined {
  for (const [tierName, tier] of Object.entries(tiers)) {
    for (const entry of tier.providers) {
      if (entry.name === provider && entry.models.includes(model)) {
        return tierName;
      }
    }
  }
  return undefined;
}

/**
 * What the router would pick for this prompt, asked on a throwaway instance.
 *
 * A fresh router per call keeps its per-task escalation counters out of the
 * way: this is a prediction, not a routing session, and one run's counter must
 * not leak into the next run's prediction.
 */
export function predictedTierFor(
  config: GearVaneConfig,
  description: string,
): string | undefined {
  try {
    const router = new TierRouter(config);
    return router.route(`predict-${description.length}`, {
      description,
      filesTouched: [],
      errorLoops: 0,
      testFailures: 0,
    }).tier;
  } catch {
    // No prediction is better than a wrong one: recordRunOutcome skips the
    // entry entirely rather than grading the classifier against itself.
    return undefined;
  }
}

/**
 * Record one finished agent run.
 *
 * Call this only for runs that reached a model. A run rejected during
 * validation never talked to anything, so it is not evidence about routing.
 */
export function recordAgentRun(
  config: GearVaneConfig,
  storage: FeedbackStorage,
  description: string,
  outcome: { provider: string; model: string; stopReason: StopReason },
): void {
  recordRunOutcome(storage, `app-${Date.now().toString(36)}`, description, {
    predictedTier: predictedTierFor(config, description),
    servedTier: servedTierFor(config.tiers, outcome.provider, outcome.model),
    success: runSucceeded(outcome.stopReason),
  });
}
