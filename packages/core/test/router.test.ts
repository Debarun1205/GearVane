import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/defaults.js';
import { TierRouter } from '../src/router.js';
import type { TaskContext, WaypointConfig } from '../src/types.js';

const config = (): WaypointConfig => {
  const base = defaultConfig();
  return {
    ...base,
    tiers: {
      local: {
        name: 'local',
        description: 'Local',
        providers: [
          { name: 'ollama', models: ['llama3.2'], baseUrl: 'http://localhost:11434' },
        ],
        maxRetries: 2,
        costPerToken: 0,
      },
      mid: {
        name: 'mid',
        description: 'Mid',
        providers: [
          {
            name: 'openrouter',
            models: ['haiku', 'anthropic/claude-3-haiku'],
            baseUrl: 'https://openrouter.ai/api',
          },
        ],
        maxRetries: 2,
        costPerToken: 0,
      },
      frontier: {
        name: 'frontier',
        description: 'Frontier',
        providers: [
          {
            name: 'anthropic',
            models: ['claude-sonnet-4-20250514'],
            baseUrl: 'https://api.anthropic.com',
          },
        ],
        maxRetries: 3,
        costPerToken: 0,
      },
    },
    router: {
      ...base.router,
      escalation: { enabled: true, maxAttemptsPerTier: 2, autoPromoteOnFailure: true },
    },
  };
};

const ctx = (description: string, filesTouched: string[] = []): TaskContext => ({
  description,
  filesTouched,
  errorLoops: 0,
  testFailures: 0,
});

describe('TierRouter routing', () => {
  it('sends a simple task to local', () => {
    const router = new TierRouter(config());
    const decision = router.route('t1', ctx('Fix a typo in README', ['README.md']));
    expect(decision.tier).toBe('local');
    expect(decision.provider.name).toBe('ollama');
  });

  it('sends a complex task to frontier', () => {
    const router = new TierRouter(config());
    const decision = router.route(
      't2',
      ctx('Refactor the auth architecture for concurrency', ['a.ts', 'b.ts', 'c.ts']),
    );
    expect(decision.tier).toBe('frontier');
  });

  it('tracks task state', () => {
    const router = new TierRouter(config());
    router.route('t3', ctx('Fix a typo'));
    expect(router.getTaskState('t3')?.attempts).toBe(1);
    router.route('t3', ctx('Fix a typo'));
    expect(router.getTaskState('t3')?.attempts).toBe(2);
  });

  it('throws a clear error when no tiers are configured', () => {
    const empty = defaultConfig();
    empty.tiers = {
      local: { ...empty.tiers.local, providers: [] },
      mid: { ...empty.tiers.mid, providers: [] },
      frontier: { ...empty.tiers.frontier, providers: [] },
    };
    const router = new TierRouter(empty);
    expect(() => router.route('t', ctx('anything'))).toThrow(
      /No usable model tiers configured/,
    );
  });
});

describe('manual override', () => {
  it('honours a bare model name', () => {
    const cfg = config();
    cfg.router.manualOverride = 'claude-sonnet-4-20250514';
    const router = new TierRouter(cfg);
    const decision = router.route('t1', ctx('Fix a typo'));
    expect(decision.model).toBe('claude-sonnet-4-20250514');
    expect(decision.tier).toBe('frontier');
    expect(decision.confidence).toBe(1);
  });

  it('honours a provider-qualified name', () => {
    const cfg = config();
    cfg.router.manualOverride = 'anthropic/claude-sonnet-4-20250514';
    const router = new TierRouter(cfg);
    const decision = router.route('t2', ctx('Fix a typo'));
    expect(decision.model).toBe('claude-sonnet-4-20250514');
    expect(decision.provider.name).toBe('anthropic');
  });

  it('honours an OpenRouter-style id containing slashes', () => {
    const cfg = config();
    cfg.router.manualOverride = 'openrouter/anthropic/claude-3-haiku';
    const router = new TierRouter(cfg);
    const decision = router.route('t3', ctx('Fix a typo'));
    expect(decision.model).toBe('anthropic/claude-3-haiku');
    expect(decision.provider.name).toBe('openrouter');
  });

  it('falls back visibly when the override matches nothing', () => {
    // Regression: an unmatched override used to look honoured, which is worse
    // than a warning because the user believes a model is pinned.
    const cfg = config();
    cfg.router.manualOverride = 'does-not-exist';
    const router = new TierRouter(cfg);
    const decision = router.route('t4', ctx('Fix a typo', ['README.md']));

    expect(decision.tier).toBe('local');
    expect(decision.reasons.join(' ')).toMatch(/matched no configured model/);
    expect(decision.reasons.join(' ')).not.toMatch(/^Manual override:/);
  });
});

describe('escalation', () => {
  it('does not escalate after a single failure', () => {
    const router = new TierRouter(config());
    router.route('t1', ctx('Fix a typo', ['README.md']));
    router.reportFailure('t1');
    const decision = router.route('t1', ctx('Fix a typo', ['README.md']));
    expect(decision.tier).toBe('local');
    expect(decision.escalated).toBe(false);
  });

  it('escalates once maxAttemptsPerTier failures accumulate', () => {
    const cfg = config();
    cfg.router.escalation.maxAttemptsPerTier = 1;
    const router = new TierRouter(cfg);

    const first = router.route('t2', ctx('Fix a typo', ['README.md']));
    expect(first.tier).toBe('local');

    router.reportFailure('t2');
    const second = router.route('t2', ctx('Fix a typo', ['README.md']));
    expect(second.tier).toBe('mid');
    expect(second.escalated).toBe(true);
  });

  it('resets failures after a success', () => {
    const cfg = config();
    cfg.router.escalation.maxAttemptsPerTier = 1;
    const router = new TierRouter(cfg);

    router.route('t3', ctx('Fix a typo', ['README.md']));
    router.reportFailure('t3');
    router.reportSuccess('t3');
    const decision = router.route('t3', ctx('Fix a typo', ['README.md']));
    expect(decision.escalated).toBe(false);
  });

  it('stops escalating at the top tier', () => {
    const cfg = config();
    cfg.router.escalation.maxAttemptsPerTier = 1;
    const router = new TierRouter(cfg);

    router.route('t4', ctx('Refactor the architecture', ['a.rs', 'b.rs', 'c.rs']));
    router.reportFailure('t4');
    const decision = router.route('t4', ctx('Refactor the architecture', ['a.rs', 'b.rs', 'c.rs']));
    expect(decision.tier).toBe('frontier');
    // frontier is the highest tier, so there is nowhere to escalate.
    expect(decision.escalated).toBe(false);
  });

  it('honours escalation being disabled', () => {
    const cfg = config();
    cfg.router.escalation.enabled = false;
    cfg.router.escalation.maxAttemptsPerTier = 1;
    const router = new TierRouter(cfg);

    router.route('t5', ctx('Fix a typo', ['README.md']));
    router.reportFailure('t5');
    const decision = router.route('t5', ctx('Fix a typo', ['README.md']));
    expect(decision.tier).toBe('local');
  });
});

describe('provider selection', () => {
  it('round-robins across providers in a tier', () => {
    const cfg = config();
    cfg.tiers.local.providers = [
      { name: 'ollama', models: ['a'], baseUrl: 'http://localhost:11434' },
      { name: 'lm_studio', models: ['b'], baseUrl: 'http://localhost:1234' },
    ];
    const router = new TierRouter(cfg);

    const names = [
      router.route('t', ctx('Fix a typo', ['README.md'])).provider.name,
      router.route('t', ctx('Fix a typo', ['README.md'])).provider.name,
      router.route('t', ctx('Fix a typo', ['README.md'])).provider.name,
    ];
    expect(names).toEqual(['ollama', 'lm_studio', 'ollama']);
  });

  it('lists configured tiers', () => {
    const router = new TierRouter(config());
    expect(router.getConfiguredTiers()).toEqual(['local', 'mid', 'frontier']);
  });
});