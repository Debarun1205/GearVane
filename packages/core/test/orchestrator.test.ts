import { describe, expect, it, vi } from 'vitest';

import { defaultConfig } from '../src/defaults.js';
import { Orchestrator, SpendTracker } from '../src/orchestrator.js';
import { ProviderError } from '../src/providers.js';
import type { Completion, ProviderConfig, GearVaneConfig } from '../src/types.js';

const cfg = (overrides: Partial<GearVaneConfig> = {}): GearVaneConfig => {
  const base = defaultConfig();
  return {
    ...base,
    tiers: {
      local: {
        name: 'local',
        description: 'Local',
        providers: [{ name: 'ollama', models: ['llama3.2'], baseUrl: 'http://localhost:11434' }],
        maxRetries: 2,
        costPerToken: 0,
      },
      mid: {
        name: 'mid',
        description: 'Mid',
        providers: [{ name: 'openrouter', models: ['haiku'], baseUrl: 'https://openrouter.ai/api' }],
        maxRetries: 2,
        costPerToken: 0,
      },
      frontier: {
        name: 'frontier',
        description: 'Frontier',
        providers: [{ name: 'anthropic', models: ['claude'], baseUrl: 'https://api.anthropic.com' }],
        maxRetries: 3,
        costPerToken: 0,
      },
    },
    providers: { timeoutSeconds: 5, maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0 },
    safety: {
      ...base.safety,
      spendLimits: { perSession: 100, perDay: 100, perTask: 100 },
    },
    ...overrides,
  };
};

const ok = (content = 'done', tokensIn = 10, tokensOut = 20): Completion => ({
  content,
  model: 'm',
  usage: { tokensIn, tokensOut },
  finishReason: 'stop',
  toolCalls: [],
});

class FakeClient {
  results: Array<Completion | Error> = [ok()];
  calls: Array<Record<string, unknown>> = [];

  constructor(results?: Array<Completion | Error>) {
    if (results) this.results = results;
  }

  async complete(prompt: string, options?: Record<string, unknown>): Promise<Completion> {
    this.calls.push({ prompt, ...options });
    const next = this.results.shift();
    if (!next) throw new Error('FakeClient exhausted');
    if (next instanceof Error) throw next;
    return next;
  }

  async *stream(): AsyncGenerator<string> {
    yield 'he';
    yield 'llo';
  }
}

describe('Orchestrator success path', () => {
  it('returns the completion', async () => {
    const client = new FakeClient([ok('hello')]);
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo');

    expect(result.success).toBe(true);
    expect(result.content).toBe('hello');
    expect(result.attempts).toBe(1);
  });

  it('routes a simple task to local', async () => {
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient() });
    const result = await orch.execute('t1', 'fix a typo', { filesTouched: ['README.md'] });
    expect(result.tier).toBe('local');
    expect(result.provider).toBe('ollama');
  });

  it('routes a complex task to frontier', async () => {
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient() });
    const result = await orch.execute(
      't2',
      'refactor the auth architecture for scale',
      { filesTouched: ['a.ts', 'b.ts', 'c.ts'] },
    );
    expect(result.tier).toBe('frontier');
  });

  it('records cost from the tier rate', async () => {
    const config = cfg();
    config.tiers.frontier!.costPerToken = 0.01;
    const orch = new Orchestrator(config, {
      createClient: () => new FakeClient([ok('x', 100, 200)]),
    });
    const result = await orch.execute('t3', 'refactor the architecture for concurrency at scale', {
      filesTouched: ['a.ts', 'b.ts', 'c.ts'],
    });
    expect(result.costUsd).toBeCloseTo(3, 6);
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(200);
  });

  it('records a successful attempt in the history', async () => {
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient() });
    const result = await orch.execute('t4', 'fix a typo');
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.success).toBe(true);
  });

  it('passes generation options through', async () => {
    const client = new FakeClient();
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    await orch.execute('t5', 'fix a typo', { system: 'be brief', temperature: 0.3 });
    expect(client.calls[0]?.['system']).toBe('be brief');
    expect(client.calls[0]?.['temperature']).toBe(0.3);
  });
});

describe('Orchestrator escalation', () => {
  it('recovers on a later attempt', async () => {
    const clients = [
      new FakeClient([new ProviderError('transient', { retryable: false })]),
      new FakeClient([ok('recovered')]),
    ];
    let i = 0;
    const orch = new Orchestrator(cfg(), { createClient: () => clients[i++]! });

    const result = await orch.execute('t1', 'fix a typo', { filesTouched: ['README.md'] });
    expect(result.success).toBe(true);
    expect(result.content).toBe('recovered');
    expect(result.attempts).toBe(2);
    expect(result.history[0]?.success).toBe(false);
    expect(result.history[1]?.success).toBe(true);
  });

  it('promotes the tier after repeated failures', async () => {
    const config = cfg();
    config.router.escalation.maxAttemptsPerTier = 1;
    const names: string[] = [];
    const orch = new Orchestrator(config, {
      createClient: (provider: ProviderConfig) => {
        names.push(provider.name);
        return new FakeClient(
          names.length === 1
            ? [new ProviderError('boom', { retryable: false })]
            : [ok()],
        );
      },
    });

    const result = await orch.execute('t2', 'fix a typo', { filesTouched: ['README.md'] });
    expect(result.success).toBe(true);
    expect(names[0]).toBe('ollama');
    expect(names[1]).toBe('openrouter');
    expect(result.escalated).toBe(true);
  });

  it('reports failure when every attempt fails', async () => {
    const orch = new Orchestrator(cfg(), {
      createClient: () =>
        new FakeClient([new ProviderError('always', { retryable: false })]),
    });
    const result = await orch.execute('t3', 'fix a typo');
    expect(result.success).toBe(false);
    expect(result.error).toBe('All attempts failed');
    expect(result.content).toBe('');
    expect(result.history.every((h) => !h.success)).toBe(true);
  });

  it('does not retry a permanent failure inside one attempt', async () => {
    const config = cfg();
    config.providers.maxRetries = 3;
    const client = new FakeClient([new ProviderError('bad request', { retryable: false })]);
    const orch = new Orchestrator(config, { createClient: () => client });
    const result = await orch.execute('t4', 'fix a typo');

    expect(result.success).toBe(false);
    // One provider call per orchestrator attempt, not maxRetries calls.
    expect(client.calls.length).toBe(result.history.length);
    expect(result.history.length).toBeLessThan(4);
  });

  it('retries a transient failure inside one attempt', async () => {
    const config = cfg();
    config.providers.maxRetries = 2;
    const client = new FakeClient([
      new ProviderError('timeout', { retryable: true }),
      ok('ok after retry'),
    ]);
    const orch = new Orchestrator(config, { createClient: () => client });
    const result = await orch.execute('t5', 'fix a typo');

    expect(result.success).toBe(true);
    expect(client.calls.length).toBe(2);
  });
});

describe('Orchestrator budget gate', () => {
  it('refuses a task that cannot fit the budget', async () => {
    const config = cfg();
    config.tiers.local!.costPerToken = 0.01;
    config.safety.spendLimits = { perSession: 0.01, perDay: 0.01, perTask: 0.01 };

    const createClient = vi.fn(() => new FakeClient());
    const orch = new Orchestrator(config, { createClient });
    const result = await orch.execute('t1', 'fix a typo');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Budget exceeded/);
    // The provider must not be contacted at all.
    expect(createClient).not.toHaveBeenCalled();
  });

  it('allows a free local model through a zero budget', async () => {
    const config = cfg();
    config.safety.spendLimits = { perSession: 0, perDay: 0, perTask: 0 };
    const orch = new Orchestrator(config, { createClient: () => new FakeClient() });
    const result = await orch.execute('t1', 'fix a typo', { filesTouched: ['README.md'] });
    expect(result.success).toBe(true);
  });

  it('blocks an expensive tier that exceeds the task budget', async () => {
    const config = cfg();
    config.tiers.frontier!.costPerToken = 0.01;
    config.safety.spendLimits = { perSession: 1000, perDay: 1000, perTask: 5 };
    const orch = new Orchestrator(config, { createClient: () => new FakeClient() });
    const result = await orch.execute('t1', 'refactor the architecture for scale', {
      filesTouched: ['a.ts', 'b.ts', 'c.ts'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Budget exceeded/);
  });
});

describe('Orchestrator streaming', () => {
  it('yields tokens', async () => {
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient() });
    const tokens: string[] = [];
    for await (const token of orch.executeStream('t1', 'fix a typo')) {
      tokens.push(token);
    }
    expect(tokens).toEqual(['he', 'llo']);
  });
});

describe('SpendTracker', () => {
  it('allows spending within all limits', () => {
    const tracker = new SpendTracker({ perSession: 10, perDay: 50, perTask: 5 });
    expect(tracker.canSpend(5, 'a')).toBe(true);
    tracker.recordSpend(5, 'a');
    expect(tracker.canSpend(0.1, 'a')).toBe(false);
  });

  it('resets the per-task budget when the task changes', () => {
    // Regression: per-task spend accumulated forever, so one expensive task
    // blocked every later task.
    const tracker = new SpendTracker({ perSession: 100, perDay: 100, perTask: 5 });
    tracker.recordSpend(5, 'a');
    expect(tracker.canSpend(0.1, 'a')).toBe(false);
    expect(tracker.canSpend(5, 'b')).toBe(true);
  });

  it('enforces the session limit across tasks', () => {
    const tracker = new SpendTracker({ perSession: 10, perDay: 50, perTask: 5 });
    tracker.recordSpend(5, 'a');
    tracker.recordSpend(5, 'b');
    expect(tracker.canSpend(0.1, 'c')).toBe(false);
  });

  it('reports remaining budget', () => {
    const tracker = new SpendTracker({ perSession: 10, perDay: 50, perTask: 5 });
    tracker.recordSpend(2.5, 'a');
    const status = tracker.getStatus();
    expect(status.sessionSpend).toBeCloseTo(2.5);
    expect(status.sessionRemaining).toBeCloseTo(7.5);
    expect(status.taskSpend).toBeCloseTo(2.5);
  });

  it('expires day-bucket entries after 24 hours', () => {
    let now = 1_000_000;
    const tracker = new SpendTracker({ perSession: 100, perDay: 5, perTask: 100 }, () => now);
    tracker.recordSpend(4, 'a');
    expect(tracker.getStatus().dayRemaining).toBeCloseTo(1);

    now += 86_400_001;
    expect(tracker.getStatus().dayRemaining).toBeCloseTo(5);
  });

  it('resets the session', () => {
    const tracker = new SpendTracker({ perSession: 10, perDay: 10, perTask: 10 });
    tracker.recordSpend(5, 'a');
    tracker.resetSession();
    expect(tracker.getStatus().sessionSpend).toBe(0);
  });
});