import { classifyGlob } from './globs.js';
import type { ClassificationResult, TaskContext, Tier } from './types.js';

/**
 * Multinomial logistic regression over hashed task-description features.
 *
 * Implemented directly rather than via a framework so the core keeps no
 * runtime dependencies and can run in a browser or Android webview.
 */

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/**
 * Bag-of-features vector for a description.
 *
 * Words and bigrams are prefixed differently so a bigram can never collide
 * with a single token.
 */
export function featuresFor(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(`w:${token}`, (counts.get(`w:${token}`) ?? 0) + 1);
  }

  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const key = `b:${tokens[i]}_${tokens[i + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/**
 * Scale a feature vector to unit L2 norm.
 *
 * Without this, raw token counts let logit magnitudes grow without bound,
 * softmax saturates on one class, and the gradient for the correct class
 * collapses to zero, so training stalls at chance accuracy.
 */
export function normalize(features: Map<string, number>): Map<string, number> {
  let total = 0;
  for (const value of features.values()) total += value * value;
  if (total === 0) return features;

  const scale = 1 / Math.sqrt(total);
  const out = new Map<string, number>();
  for (const [name, value] of features) out.set(name, value * scale);
  return out;
}

const TIER_KEYS: readonly Tier[] = ['local', 'mid', 'frontier'];

export interface LearnedWeights {
  /** tier -> feature -> weight */
  weights: Record<Tier, Map<string, number>>;
  bias: Record<Tier, number>;
  trainedOn: number;
  accuracy: number;
}

export function emptyWeights(): LearnedWeights {
  return {
    weights: { local: new Map(), mid: new Map(), frontier: new Map() },
    bias: { local: 0, mid: 0, frontier: 0 },
    trainedOn: 0,
    accuracy: 0,
  };
}

export interface SerializedWeights {
  weights: Record<Tier, Record<string, number>>;
  bias: Record<Tier, number>;
  trainedOn: number;
  /**
   * Alias for the Python engine, whose LearnedWeights.to_dict writes
   * `trained_on`. Emitted on save and accepted on load so model files are
   * interchangeable between the two CLIs.
   */
  trained_on?: number;
  accuracy: number;
}

export function serializeWeights(weights: LearnedWeights): SerializedWeights {
  const out: Record<Tier, Record<string, number>> = {
    local: {},
    mid: {},
    frontier: {},
  };
  for (const tier of TIER_KEYS) {
    for (const [name, weight] of weights.weights[tier]) {
      out[tier][name] = weight;
    }
  }
  return {
    weights: out,
    bias: { ...weights.bias },
    trainedOn: weights.trainedOn,
    // The Python engine writes `trained_on`; emit both keys so a model file
    // written by either CLI loads in the other. Python's from_dict ignores
    // the camelCase extra, and deserializeWeights below reads either.
    trained_on: weights.trainedOn,
    accuracy: weights.accuracy,
  };
}

export function deserializeWeights(data: SerializedWeights): LearnedWeights {
  const weights = emptyWeights();
  for (const tier of TIER_KEYS) {
    for (const [name, weight] of Object.entries(data.weights?.[tier] ?? {})) {
      weights.weights[tier].set(name, weight);
    }
    weights.bias[tier] = data.bias?.[tier] ?? 0;
  }
  weights.trainedOn = data.trainedOn ?? data.trained_on ?? 0;
  weights.accuracy = data.accuracy ?? 0;
  return weights;
}

export interface LearnedClassifierOptions {
  learningRate?: number;
  epochs?: number;
  l2?: number;
}

export class LearnedClassifier {
  weights: LearnedWeights = emptyWeights();

  private readonly learningRate: number;
  private readonly epochs: number;
  private readonly l2: number;

  constructor(options: LearnedClassifierOptions = {}) {
    this.learningRate = options.learningRate ?? 0.5;
    this.epochs = options.epochs ?? 50;
    this.l2 = options.l2 ?? 0.001;
  }

  get isTrained(): boolean {
    return this.weights.trainedOn > 0;
  }

  private scores(features: Map<string, number>): Record<Tier, number> {
    const result = { local: 0, mid: 0, frontier: 0 };
    for (const tier of TIER_KEYS) {
      let score = this.weights.bias[tier];
      const tierWeights = this.weights.weights[tier];
      for (const [name, value] of features) {
        score += (tierWeights.get(name) ?? 0) * value;
      }
      result[tier] = score;
    }
    return result;
  }

  private softmax(scores: Record<Tier, number>): Record<Tier, number> {
    // Subtract the max for numerical stability before exponentiating.
    const max = Math.max(scores.local, scores.mid, scores.frontier);
    const exps = {
      local: Math.exp(scores.local - max),
      mid: Math.exp(scores.mid - max),
      frontier: Math.exp(scores.frontier - max),
    };
    const total = exps.local + exps.mid + exps.frontier;
    if (total === 0) return { local: 1 / 3, mid: 1 / 3, frontier: 1 / 3 };
    return {
      local: exps.local / total,
      mid: exps.mid / total,
      frontier: exps.frontier / total,
    };
  }

  predictProba(description: string): Record<Tier, number> {
    if (!this.isTrained) {
      return { local: 1 / 3, mid: 1 / 3, frontier: 1 / 3 };
    }
    return this.softmax(this.scores(normalize(featuresFor(description))));
  }

  predict(description: string): { tier: Tier; confidence: number } {
    const probabilities = this.predictProba(description);
    const best = TIER_KEYS.reduce((a, b) =>
      probabilities[a] >= probabilities[b] ? a : b,
    );
    return { tier: best, confidence: probabilities[best] };
  }

  train(samples: ReadonlyArray<{ description: string; tier: Tier }>): LearnedWeights {
    if (samples.length === 0) return this.weights;

    this.weights = emptyWeights();

    const prepared = samples.map((sample) => ({
      features: normalize(featuresFor(sample.description)),
      trueIndex: TIER_KEYS.indexOf(sample.tier),
    }));

    for (let epoch = 0; epoch < this.epochs; epoch += 1) {
      // Reverse every other pass so training does not depend on input order.
      const order =
        epoch % 2 === 1 ? [...prepared].reverse() : prepared;

      for (const { features, trueIndex } of order) {
        const probabilities = this.softmax(this.scores(features));

        for (const tier of TIER_KEYS) {
          const target = TIER_KEYS.indexOf(tier) === trueIndex ? 1 : 0;

          // Gradient ascent on the log-likelihood needs (y - p). Using
          // (p - y) would descend away from the correct class and training
          // would settle at chance accuracy.
          const error = target - probabilities[tier];

          this.weights.bias[tier] += this.learningRate * error;

          const tierWeights = this.weights.weights[tier];
          for (const [name, value] of features) {
            tierWeights.set(
              name,
              (tierWeights.get(name) ?? 0) + this.learningRate * error * value,
            );
          }
        }
      }

      if (this.l2 > 0) {
        for (const tier of TIER_KEYS) {
          const tierWeights = this.weights.weights[tier];
          for (const [name, weight] of tierWeights) {
            tierWeights.set(name, weight * (1 - this.l2));
          }
        }
      }
    }

    // Mark trained before scoring: predict delegates to predictProba, which
    // returns a uniform distribution while trainedOn is still zero, which
    // would score every sample wrong.
    this.weights.trainedOn = samples.length;

    let correct = 0;
    for (const sample of samples) {
      if (this.predict(sample.description).tier === sample.tier) correct += 1;
    }
    this.weights.accuracy = correct / samples.length;

    return this.weights;
  }

  /** Strongest positive weights for a tier, for inspecting what was learned. */
  topFeatures(tier: Tier, n = 10): Array<{ feature: string; weight: number }> {
    const ranked = [...this.weights.weights[tier].entries()]
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
    return ranked.map(([feature, weight]) => ({
      feature,
      weight: Math.round(weight * 10_000) / 10_000,
    }));
  }
}

export interface HybridClassifierOptions {
  learned?: LearnedClassifier;
  minSamples?: number;
  blend?: number;
  heuristic: { classify(context: TaskContext): ClassificationResult };
}

/**
 * Blends the learned model with the heuristics.
 *
 * The learned model only gets weight once it has enough training data, so a
 * fresh install behaves exactly as before. When the two disagree the
 * heuristic tier wins at reduced confidence, so a poorly trained model
 * degrades gracefully instead of silently rerouting work.
 */
export class HybridClassifier {
  private readonly learned: LearnedClassifier;
  private readonly minSamples: number;
  private readonly blend: number;
  private readonly heuristic: {
    classify(context: TaskContext): ClassificationResult;
  };

  constructor(options: HybridClassifierOptions) {
    this.learned = options.learned ?? new LearnedClassifier();
    this.minSamples = options.minSamples ?? 10;
    this.blend = options.blend ?? 0.5;
    this.heuristic = options.heuristic;
  }

  get learnedReady(): boolean {
    return this.learned.weights.trainedOn >= this.minSamples;
  }

  classify(context: TaskContext): ClassificationResult {
    const heuristic = this.heuristic.classify(context);

    if (!this.learnedReady) {
      return {
        ...heuristic,
        reasons: [
          ...heuristic.reasons,
          `Learned model not active (${this.learned.weights.trainedOn}/${this.minSamples} samples)`,
        ],
      };
    }

    const probabilities = this.learned.predictProba(context.description);
    const best = TIER_KEYS.reduce((a, b) =>
      probabilities[a] >= probabilities[b] ? a : b,
    );
    const learnedConfidence = probabilities[best];
    const agree = best === heuristic.tier;

    let combined = this.blend * learnedConfidence + (1 - this.blend) * heuristic.confidence;
    let tier = heuristic.tier;
    if (!agree) {
      tier = heuristic.tier;
      combined *= 0.75;
    }

    return {
      tier,
      confidence: Math.round(Math.min(combined, 1) * 100) / 100,
      reasons: [
        ...heuristic.reasons,
        `Learned model favoured ${best} (${Math.round(learnedConfidence * 100)}%); ` +
          (agree ? 'agreed with heuristics' : 'overridden by heuristics'),
      ],
      scores: heuristic.scores,
    };
  }
}

export type { ClassificationResult, TaskContext };
export { classifyGlob };