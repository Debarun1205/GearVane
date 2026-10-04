import { describe, expect, it } from 'vitest';

import { defaultConfig, type Completion, type GearVaneConfig } from '@gearvane/core';

import { AppController } from '../src/controller.js';

const ok = (content = 'done'): Completion => ({
  content,
  model: 'm',
  usage: { tokensIn: 5, tokensOut: 7 },
  finishReason: 'stop',
  toolCalls: [],
});

class FakeClient {
  constructor(private readonly results: Array<Completion | Error>) {}

  async complete(): Promise<Completion> {
    const next = this.results.shift();
    if (!next) throw new Error('exhausted');
    if (next instanceof Error) throw next;
    return next;
  }

  async *stream(): AsyncGenerator<string> {
    yield 'tok';
  }
}

const config = (): GearVaneConfig => {
  const base = defaultConfig();
  return {
    ...base,
    tiers: {
      local: {
        name: 'local',
        description: 'Local',
        providers: [{ name: 'ollama', models: ['qwen2.5-coder'] }],
        maxRetries: 2,
        costPerToken: 0,
      },
      mid: { ...base.tiers.mid, providers: [] },
      frontier: { ...base.tiers.frontier, providers: [] },
    },
    providers: { timeoutSeconds: 5, maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0 },
  };
};

const controllerWith = (
  results: Array<Completion | Error>,
): AppController =>
  new AppController({
    config: config(),
    env: {},
    createClient: () => new FakeClient(results),
  });

describe('preview', () => {
  it('reports the tier without contacting a provider', () => {
    // The UI shows this while the user types, so it must not spend anything.
    let created = 0;
    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => {
        created += 1;
        return new FakeClient([ok()]);
      },
    });

    const preview = controller.preview('fix a typo in the readme');
    expect(preview.tier).toBe('local');
    expect(preview.model).toBe('qwen2.5-coder');
    expect(preview.reasons.length).toBeGreaterThan(0);
    expect(created).toBe(0);
  });

  it('does not accumulate escalation state across previews', () => {
    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => new FakeClient([ok()]),
    });

    // Repeated previews must keep agreeing, which they only do if each is
    // routed from a clean state.
    const first = controller.preview('refactor the architecture for concurrency');
    for (let i = 0; i < 5; i += 1) {
      expect(controller.preview('refactor the architecture for concurrency').tier).toBe(
        first.tier,
      );
    }
  });
});

describe('submit', () => {
  it('returns a successful result', async () => {
    const controller = controllerWith([ok('hello')]);
    const result = await controller.submit({ taskId: 't1', prompt: 'fix a typo' });

    expect(result.success).toBe(true);
    expect(result.content).toBe('hello');
    expect(result.tier).toBe('local');
  });

  it('reports a failure without throwing', async () => {
    const controller = controllerWith([
      new Error('nope'),
      new Error('nope'),
      new Error('nope'),
    ]);
    const result = await controller.submit({ taskId: 't1', prompt: 'fix a typo' });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('clears the in-flight entry when finished', async () => {
    const controller = controllerWith([ok()]);
    await controller.submit({ taskId: 't1', prompt: 'fix a typo' });
    expect(controller.inFlightCount()).toBe(0);
  });

  it('tracks an in-flight request', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => ({
        complete: async () => {
          await gate;
          return ok();
        },
        stream: async function* () {
          yield '';
        },
      }) as never,
    });

    const pending = controller.submit({ taskId: 't1', prompt: 'hi' });
    expect(controller.inFlightCount()).toBe(1);

    release?.();
    await pending;
    expect(controller.inFlightCount()).toBe(0);
  });

  it('cancels an in-flight request', async () => {
    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () =>
        ({
          complete: async (_p: string, options?: { signal?: AbortSignal }) =>
            new Promise<Completion>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            }),
          stream: async function* () {
            yield '';
          },
        }) as never,
    });

    const pending = controller.submit({ taskId: 't1', prompt: 'hi' });
    expect(controller.cancel('t1')).toBe(true);

    const result = await pending;
    expect(result.success).toBe(false);
  });

  it('reports nothing to cancel for an unknown task', () => {
    expect(controllerWith([]).cancel('nope')).toBe(false);
  });
});

describe('streaming submit', () => {
  it('delivers tokens and returns the accumulated text', async () => {
    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () =>
        ({
          complete: async () => ok(),
          stream: async function* () {
            yield 'a ';
            yield 'b ';
          },
        }) as never,
    });

    const tokens: string[] = [];
    const snapshots: string[] = [];

    const result = await controller.submit({
      taskId: 't1',
      prompt: 'hi',
      stream: true,
      onToken: (token, accumulated) => {
        tokens.push(token);
        snapshots.push(accumulated);
      },
    });

    expect(tokens).toEqual(['a ', 'b ']);
    expect(snapshots).toEqual(['a ', 'a b ']);
    expect(result.content).toBe('a b ');
    expect(result.success).toBe(true);
  });

  it('streams with no callback without crashing', async () => {
    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () =>
        ({
          complete: async () => ok(),
          stream: async function* () {
            yield 'x';
          },
        }) as never,
    });

    const result = await controller.submit({ taskId: 't1', prompt: 'hi', stream: true });
    expect(result.content).toBe('x');
  });
});

describe('budget and safety', () => {
  it('exposes the configured limits', () => {
    const limits = controllerWith([]).limits();
    expect(limits.perTask).toBeGreaterThan(0);
    expect(limits.perSession).toBeGreaterThan(0);
  });

  it('reports spend', () => {
    const status = controllerWith([]).spendStatus();
    expect(status).toHaveProperty('sessionRemaining');
  });

  it('gates a push command', () => {
    const request = controllerWith([]).gate('git push origin main');
    expect(request.operation).toBe('git_push');
    expect(request.status).toBe('pending');
  });

  it('denies a blocked command', () => {
    expect(controllerWith([]).gate('rm -rf /').status).toBe('denied');
  });
});

describe('health', () => {
  it('reports every configured model', async () => {
    const controller = new AppController({
      config: config(),
      env: {},
      // A generous latency threshold keeps the assertion about reachability
      // rather than about how loaded the machine is during the run.
      timeoutMs: 10_000,
      createClient: () => ({
        healthCheck: async () => true,
        complete: async () => ok(),
        stream: async function* () {
          yield '';
        },
      }) as never,
    });

    const results = await controller.checkHealth();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('healthy');
  });
});