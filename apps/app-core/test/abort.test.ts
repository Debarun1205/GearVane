import { describe, expect, it } from 'vitest';

import { defaultConfig, type Completion, type GearVaneConfig } from '@gearvane/core';

import { AppController } from '../src/controller.js';

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
    safety: {
      ...base.safety,
      
    },
  };
};

const ok: Completion = {
  content: 'done',
  model: 'm',
  usage: { tokensIn: 5, tokensOut: 7 },
  finishReason: 'stop',
  toolCalls: [],
};

describe('abort handling', () => {
  it('does not retry after a cancellation', async () => {
    // Regression: cancelling caused the orchestrator to re-issue the request.
    // The replacement call never sees a fresh abort event, so it hung until
    // the test timed out.
    let completeCalls = 0;

    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => ({
        complete: (
          _prompt: string,
          options?: { signal?: AbortSignal },
        ): Promise<Completion> => {
          completeCalls += 1;
          return new Promise<Completion>((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        stream: async function* () {
          yield '';
        },
      }) as never,
    });

    const pending = controller.submit({ taskId: 't1', prompt: 'hi' });
    expect(controller.cancel('t1')).toBe(true);

    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toBe('cancelled');
    // One call, not one per escalation attempt.
    expect(completeCalls).toBe(1);
  });

  it('reports cancellation without escalating', async () => {
    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => ({
        complete: (_p: string, options?: { signal?: AbortSignal }) => {
          const signal = options?.signal;
          if (signal?.aborted) return Promise.reject(new Error('aborted'));
          return new Promise<Completion>((_r, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        stream: async function* () {
          yield '';
        },
      }) as never,
    });

    const pending = controller.submit({ taskId: 't2', prompt: 'hi' });
    controller.cancel('t2');
    const result = await pending;

    expect(result.attempts).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.error).toBe('cancelled');
  });

  it('still retries genuine provider failures', async () => {
    // Cancelling must not disable escalation for real faults.
    let calls = 0;

    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => ({
        complete: async (): Promise<Completion> => {
          calls += 1;
          throw new Error('provider exploded');
        },
        stream: async function* () {
          yield '';
        },
      }) as never,
    });

    const result = await controller.submit({ taskId: 't3', prompt: 'hi' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('All attempts failed');
    expect(calls).toBeGreaterThan(1);
  });

  it('cancels every request at once', async () => {
    const makeClient = () => ({
      complete: (_p: string, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        if (signal?.aborted) return Promise.reject(new Error('aborted'));
        return new Promise<Completion>((_r, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
      stream: async function* () {
        yield '';
      },
    });

    const controller = new AppController({
      config: config(),
      env: {},
      createClient: () => makeClient() as never,
    });

    const first = controller.submit({ taskId: 'a', prompt: 'hi' });
    const second = controller.submit({ taskId: 'b', prompt: 'hi' });
    expect(controller.inFlightCount()).toBe(2);

    controller.cancelAll();

    const [a, b] = await Promise.all([first, second]);
    expect(a.error).toBe('cancelled');
    expect(b.error).toBe('cancelled');
    expect(controller.inFlightCount()).toBe(0);
  });
});