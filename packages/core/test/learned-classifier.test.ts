import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/defaults.js';
import { HealthChecker } from '../src/health.js';
import {
  HybridClassifier,
  LearnedClassifier,
  deserializeWeights,
  featuresFor,
  normalize,
  serializeWeights,
  tokenize,
} from '../src/learned-classifier.js';
import { TaskClassifier } from '../src/classifier.js';
import type { ProviderClient } from '../src/providers.js';
import type { TaskContext, Tier, WaypointConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// feature extraction
// ---------------------------------------------------------------------------

describe('feature extraction', () => {
  it('lowercases and splits into tokens', () => {
    expect(tokenize('Fix A Typo')).toEqual(['fix', 'a', 'typo']);
  });

  it('produces word and bigram features', () => {
    const features = featuresFor('fix typo');
    expect(features.get('w:fix')).toBe(1);
    expect(features.get('w:typo')).toBe(1);
    expect(features.get('b:fix_typo')).toBe(1);
  });

  it('counts repeated words', () => {
    expect(featuresFor('fix fix typo').get('w:fix')).toBe(2);
  });

  it('is deterministic', () => {
    expect([...featuresFor('fix typo')]).toEqual([...featuresFor('fix typo')]);
  });

  it('normalises to unit length', () => {
    // Without normalisation, softmax saturates and training stalls at chance.
    const features = normalize(featuresFor('fix a typo in the readme'));
    const sumSquares = [...features.values()].reduce((sum, v) => sum + v * v, 0);
    expect(sumSquares).toBeCloseTo(1, 6);
  });

  it('leaves an empty vector alone', () => {
    const empty = new Map<string, number>();
    expect(normalize(empty).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// learned classifier
// ---------------------------------------------------------------------------

const SAMPLES: Array<{ description: string; tier: Tier }> = [
  { description: 'fix a typo in the readme', tier: 'local' },
  { description: 'update the changelog typo', tier: 'local' },
  { description: 'rename this variable for clarity', tier: 'local' },
  { description: 'fix spelling in the documentation', tier: 'local' },
  { description: 'simple formatting change in the readme', tier: 'local' },
  { description: 'add a comment to this function', tier: 'local' },
  { description: 'fix a typo in the template', tier: 'local' },
  { description: 'small readme formatting fix', tier: 'local' },
  { description: 'add pagination to the user list endpoint', tier: 'mid' },
  { description: 'wire up the new settings form to the api', tier: 'mid' },
  { description: 'update the dashboard chart colours', tier: 'mid' },
  { description: 'add validation to the signup form', tier: 'mid' },
  { description: 'update the api response for list endpoints', tier: 'mid' },
  { description: 'add loading state to the profile page', tier: 'mid' },
  { description: 'render the recent activity list', tier: 'mid' },
  { description: 'add a retry to the http client wrapper', tier: 'mid' },
  { description: 'refactor the authentication architecture', tier: 'frontier' },
  { description: 'optimize the database performance bottleneck', tier: 'frontier' },
  { description: 'investigate a concurrency race condition', tier: 'frontier' },
  { description: 'redesign the distributed migration system', tier: 'frontier' },
  { description: 'optimize the query performance at scale', tier: 'frontier' },
  { description: 'investigate the memory leak under concurrency', tier: 'frontier' },
  { description: 'refactor the architecture for security', tier: 'frontier' },
  { description: 'scale the distributed system architecture', tier: 'frontier' },
];

const ctx = (description: string, filesTouched: string[] = []): TaskContext => ({
  description,
  filesTouched,
  errorLoops: 0,
  testFailures: 0,
});

describe('LearnedClassifier', () => {
  it('predicts uniformly before training', () => {
    const clf = new LearnedClassifier();
    const probabilities = clf.predictProba('anything');
    expect(probabilities.local).toBeCloseTo(1 / 3);
    expect(probabilities.mid).toBeCloseTo(1 / 3);
    expect(probabilities.frontier).toBeCloseTo(1 / 3);
    expect(clf.isTrained).toBe(false);
  });

  it('ignores an empty training set', () => {
    const clf = new LearnedClassifier();
    clf.train([]);
    expect(clf.isTrained).toBe(false);
  });

  it('learns to separate the three tiers', () => {
    // Regression: the gradient sign was inverted, so training settled at
    // chance accuracy (33%) no matter the hyper-parameters.
    const clf = new LearnedClassifier({ learningRate: 0.5, epochs: 50 });
    const weights = clf.train(SAMPLES);
    expect(weights.trainedOn).toBe(SAMPLES.length);
    expect(weights.accuracy).toBeGreaterThan(0.8);
  });

  it('predicts the right tier for a simple task', () => {
    const clf = new LearnedClassifier({ learningRate: 0.5, epochs: 50 });
    clf.train(SAMPLES);
    expect(clf.predict('fix a typo in the readme').tier).toBe('local');
  });

  it('predicts the right tier for a complex task', () => {
    const clf = new LearnedClassifier({ learningRate: 0.5, epochs: 50 });
    clf.train(SAMPLES);
    expect(clf.predict('refactor the authentication architecture').tier).toBe('frontier');
  });

  it('returns probabilities that sum to one', () => {
    const clf = new LearnedClassifier();
    clf.train(SAMPLES);
    const probabilities = clf.predictProba('fix a typo');
    const total = probabilities.local + probabilities.mid + probabilities.frontier;
    expect(total).toBeCloseTo(1);
  });

  it('is deterministic across runs', () => {
    const a = new LearnedClassifier({ learningRate: 0.5, epochs: 50 });
    const b = new LearnedClassifier({ learningRate: 0.5, epochs: 50 });
    a.train(SAMPLES);
    b.train(SAMPLES);
    expect(a.predictProba('fix a typo')).toEqual(b.predictProba('fix a typo'));
  });

  it('reports its strongest features', () => {
    const clf = new LearnedClassifier();
    clf.train(SAMPLES);
    const top = clf.topFeatures('frontier', 5);
    expect(top.length).toBeGreaterThan(0);
    const weights = top.map((entry) => entry.weight);
    expect([...weights].sort((x, y) => y - x)).toEqual(weights);
    expect(weights.every((weight) => weight > 0)).toBe(true);
  });

  it('round-trips through serialisation', () => {
    const clf = new LearnedClassifier();
    clf.train(SAMPLES);
    const restored = new LearnedClassifier();
    restored.weights = deserializeWeights(serializeWeights(clf.weights));

    expect(restored.weights.trainedOn).toBe(clf.weights.trainedOn);
    expect(restored.predict('fix a typo')).toEqual(clf.predict('fix a typo'));
  });

  it('tolerates partial serialised data', () => {
    const restored = deserializeWeights({
      weights: { local: {}, mid: {}, frontier: {} },
      bias: { local: 0, mid: 0, frontier: 0 },
      trainedOn: 0,
      accuracy: 0,
    });
    expect(restored.trainedOn).toBe(0);
  });
});

describe('HybridClassifier', () => {
  it('uses heuristics only until it has enough samples', () => {
    const hybrid = new HybridClassifier({
      learned: Object.assign(new LearnedClassifier(), {
        weights: Object.assign(new LearnedClassifier().train(SAMPLES.slice(0, 5)).weights, {
          trainedOn: 5,
        }),
      }),
      heuristic: new TaskClassifier(),
      minSamples: 10,
    });

    const result = hybrid.classify(ctx('fix a typo in the readme', ['README.md']));
    expect(result.tier).toBe('local');
    expect(result.reasons.join(' ')).toMatch(/not active/);
  });

  it('engages the learned model once trained', () => {
    const learned = new LearnedClassifier();
    learned.train(SAMPLES);
    const hybrid = new HybridClassifier({
      learned,
      heuristic: new TaskClassifier(),
      minSamples: 8,
    });
    expect(hybrid.learnedReady).toBe(true);

    const result = hybrid.classify(ctx('fix a typo in the readme'));
    expect(result.tier).toBe('local');
    expect(result.reasons.join(' ')).toMatch(/Learned model/);
  });

  it('defers to the heuristics on disagreement', () => {
    // Train on the inverse so the learned model disagrees with the heuristic.
    const inverted = SAMPLES.map((sample) => ({
      description: sample.description,
      tier: sample.tier === 'local' ? 'frontier' : 'local',
    }));

    const learned = new LearnedClassifier();
    learned.train(inverted);

    const hybrid = new HybridClassifier({
      learned,
      heuristic: new TaskClassifier(),
      minSamples: 8,
    });

    const result = hybrid.classify(ctx('fix a typo in the readme', ['README.md']));
    expect(result.tier).toBe('local');
    expect(result.reasons.join(' ')).toMatch(/overridden by heuristics/);
  });

  it('keeps confidence within bounds', () => {
    const learned = new LearnedClassifier();
    learned.train(SAMPLES);
    const hybrid = new HybridClassifier({ learned, heuristic: new TaskClassifier() });

    for (const description of ['fix a typo', 'refactor the architecture']) {
      const result = hybrid.classify(ctx(description));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

function healthConfig(): WaypointConfig {
  const config = defaultConfig();
  config.tiers.local!.providers = [
    { name: 'ollama', models: ['a', 'b'], baseUrl: 'http://localhost:11434' },
  ];
  config.tiers.mid!.providers = [];
  config.tiers.frontier!.providers = [];
  return config;
}

const fakeClient = (reachable: boolean, latencyMs = 0): ProviderClient =>
  ({
    providerName: 'fake',
    baseUrl: '',
    model: '',
    complete: async () => {
      throw new Error('unused');
    },
    stream: async function* () {
      yield '';
    },
    healthCheck: async () => {
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return reachable;
    },
    listModels: async () => [],
  }) as unknown as ProviderClient;

describe('HealthChecker', () => {
  it('lists every model referenced by the config', () => {
    const checker = new HealthChecker(healthConfig());
    expect(checker.models().map((m) => m.model)).toEqual(['a', 'b']);
  });

  it('reports healthy for a reachable model', async () => {
    const checker = new HealthChecker(healthConfig(), undefined, {
      createClient: () => fakeClient(true),
    });
    const results = await checker.checkAll();
    expect(results.every((r) => r.status === 'healthy')).toBe(true);
  });

  it('degrades first, then reports unhealthy after repeated failures', async () => {
    const checker = new HealthChecker(healthConfig(), undefined, {
      failureThreshold: 2,
      createClient: () => fakeClient(false),
    });

    const first = await checker.check('ollama', 'a');
    expect(first.status).toBe('degraded');

    const second = await checker.check('ollama', 'a');
    expect(second.status).toBe('unhealthy');
  });

  it('resets the failure count after a success', async () => {
    let reachable = false;
    const checker = new HealthChecker(healthConfig(), undefined, {
      failureThreshold: 2,
      createClient: () => fakeClient(reachable),
    });

    await checker.check('ollama', 'a');
    reachable = true;
    await checker.check('ollama', 'a');
    reachable = false;

    const afterReset = await checker.check('ollama', 'a');
    expect(afterReset.status).toBe('degraded');
  });

  it('degrades a reachable but slow model', async () => {
    const checker = new HealthChecker(healthConfig(), undefined, {
      latencyThresholdMs: 1,
      createClient: () => fakeClient(true, 15),
    });
    const result = await checker.check('ollama', 'a');
    expect(result.status).toBe('degraded');
    expect(result.message).toMatch(/latency/i);
  });

  it('reports unknown rather than healthy for an unconfigured model', async () => {
    // A false green is worse than reporting nothing.
    const checker = new HealthChecker(healthConfig());
    const result = await checker.check('nonexistent', 'model');
    expect(result.status).toBe('unknown');
  });

  it('reports unhealthy when the probe throws', async () => {
    const checker = new HealthChecker(healthConfig(), undefined, {
      failureThreshold: 1,
      createClient: () =>
        ({
          providerName: 'boom',
          healthCheck: async () => {
            throw new Error('probe exploded');
          },
        }) as unknown as ProviderClient,
    });
    const result = await checker.check('ollama', 'a');
    expect(result.status).toBe('unhealthy');
  });

  it('separates healthy from unhealthy lists', async () => {
    let reachable = true;
    const checker = new HealthChecker(healthConfig(), undefined, {
      createClient: (_provider, model) => fakeClient(reachable && model === 'a'),
    });

    await checker.check('ollama', 'a');
    reachable = false;
    await checker.check('ollama', 'b');

    expect(checker.healthy()).toEqual(['ollama/a']);
    expect(checker.unhealthy()).toEqual(['ollama/b']);
  });
});