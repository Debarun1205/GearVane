/**
 * The surface the router playground needs from the engine.
 *
 * Kept as its own tiny entry point so the browser bundle carries the
 * classifier and nothing else. @gearvane/core is dependency-free, but its
 * index re-exports config, providers, and the orchestrator; pulling all of
 * that into a marketing page to compute one number would be silly.
 *
 * Types are stripped at build time, so annotations here are safe: esbuild
 * compiles this file and never serves it to a browser as-is.
 */

import { TaskClassifier } from '@gearvane/core';
import { defaultConfig } from '@gearvane/core';

export { TaskClassifier };

/**
 * A provider-agnostic view of a routing decision, for display.
 *
 * The playground must not claim to run anything, so it reports the decision
 * and nothing else: which tier, how confident, and the signals behind it.
 */
export interface PlaygroundDecision {
  tier: string;
  confidence: number;
  reasons: string[];
  /** Per-tier scores, so the reasoning is inspectable rather than asserted. */
  scores: Record<string, number>;
  /** The first model the shipped defaults would use in that tier. */
  model: string;
}

export interface PlaygroundInput {
  prompt: string;
  filesTouched: string[];
  errorLoops: number;
  testFailures: number;
}

/** Classify without escalating: a playground cannot observe a real failure. */
export function route(input: PlaygroundInput): PlaygroundDecision {
  const classifier = new TaskClassifier();
  const result = classifier.classify({
    description: input.prompt,
    filesTouched: input.filesTouched,
    errorLoops: input.errorLoops,
    testFailures: input.testFailures,
  });

  return {
    tier: result.tier,
    confidence: result.confidence,
    reasons: result.reasons,
    scores: result.scores as unknown as Record<string, number>,
    model: firstModelFor(result.tier as 'local' | 'mid' | 'frontier'),
  };
}

/**
 * The first model the shipped defaults name for a tier.
 *
 * Defaults are built with an empty environment, so only the embedded
 * provider appears - which is the honest answer for a browser: there are no
 * API keys here, so hosted tiers are not available to this page.
 */
function firstModelFor(tier: 'local' | 'mid' | 'frontier'): string {
  const config = defaultConfig({});
  const provider = config.tiers[tier]?.providers.find((p) => p.name === 'embedded');
  return provider?.models[0] ?? 'none configured';
}

/** Tier names, for the legend. Static, so it needs no engine to render. */
export const TIERS = ['local', 'mid', 'frontier'] as const;