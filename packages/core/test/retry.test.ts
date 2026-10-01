import { describe, expect, it, vi } from 'vitest';

import {
  CircuitBreaker,
  RetryExhaustedError,
  calculateDelay,
  withRetry,
  type RetryConfig,
} from '../src/retry.js';
import { ProviderError } from '../src/providers.js';

const config = (overrides: Partial<RetryConfig> = {}): RetryConfig => ({
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  strategy: 'fixed',
  sleep: async () => {},
  random: () => 0.5,
  ...overrides,
});

describe('calculateDelay', () => {
  it('is constant for the fixed strategy', () => {
    const cfg = config({ strategy: 'fixed', baseDelayMs: 2 });
    expect(calculateDelay(0, cfg)).toBe(2);
    expect(calculateDelay(5, cfg)).toBe(2);
  });

  it('doubles for the exponential strategy', () => {
    const cfg = config({ strategy: 'exponential', baseDelayMs: 1 });
    expect(calculateDelay(0, cfg)).toBe(1);
    expect(calculateDelay(1, cfg)).toBe(2);
    expect(calculateDelay(2, cfg)).toBe(4);
  });

  it('caps exponential delay', () => {
    const cfg = config({ strategy: 'exponential', baseDelayMs: 1, maxDelayMs: 5 });
    expect(calculateDelay(10, cfg)).toBe(5);
  });

  it('keeps jittered delay within bounds', () => {
    const cfg = config({ strategy: 'exponential_with_jitter', baseDelayMs: 1, maxDelayMs: 10 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      for (let i = 0; i < 20; i += 1) {
        const delay = calculateDelay(attempt, cfg);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(10);
      }
    }
  });

  it('varies across calls', () => {
    // Deliberately no `random` override, so the real RNG is used.
    const cfg = config({ strategy: 'exponential_with_jitter' });
    delete (cfg as Partial<typeof cfg>).random;

    const values = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      values.add(calculateDelay(3, cfg));
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it('is deterministic when a random source is injected', () => {
    const cfg = config({ strategy: 'exponential_with_jitter', random: () => 0.5 });
    expect(calculateDelay(3, cfg)).toBe(calculateDelay(3, cfg));
  });
});

describe('withRetry', () => {
  it('returns the first success', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, config())).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('recovers after transient failures', async () => {
    let calls = 0;
    const operation = async () => {
      calls += 1;
      if (calls < 3) throw new ProviderError('timeout', { retryable: true });
      return 'recovered';
    };
    await expect(withRetry(operation, config({ maxRetries: 5 }))).resolves.toBe(
      'recovered',
    );
    expect(calls).toBe(3);
  });

  it('gives up after exhausting retries', async () => {
    let calls = 0;
    const operation = async () => {
      calls += 1;
      throw new ProviderError('always', { retryable: true });
    };
    await expect(withRetry(operation, config({ maxRetries: 2 }))).rejects.toThrow(
      RetryExhaustedError,
    );
    expect(calls).toBe(3);
  });

  it('does not retry a permanent failure', async () => {
    // Regression: a bad API key would previously burn every retry.
    let calls = 0;
    const operation = async () => {
      calls += 1;
      throw new ProviderError('bad request', { retryable: false });
    };
    await expect(withRetry(operation, config({ maxRetries: 5 }))).rejects.toThrow(
      ProviderError,
    );
    expect(calls).toBe(1);
  });

  it('reports each retry', async () => {
    const events: number[] = [];
    let calls = 0;
    const operation = async () => {
      calls += 1;
      if (calls < 2) throw new ProviderError('x', { retryable: true });
      return 'ok';
    };
    await withRetry(
      operation,
      config({ onRetry: (attempt) => events.push(attempt) }),
    );
    expect(events).toEqual([1]);
  });

  it('wraps the final error', async () => {
    const operation = async () => {
      throw new ProviderError('boom', { retryable: true });
    };
    await expect(withRetry(operation, config({ maxRetries: 1 }))).rejects.toMatchObject({
      name: 'RetryExhaustedError',
      attempts: 2,
    });
  });
});

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    expect(new CircuitBreaker().canExecute()).toBe(true);
  });

  it('opens after the failure threshold', () => {
    const breaker = new CircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canExecute()).toBe(false);
  });

  it('resets its counter on success', () => {
    const breaker = new CircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });

  it('half-opens after the recovery window', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 100, () => now);
    breaker.recordFailure();
    expect(breaker.canExecute()).toBe(false);

    now = 150;
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.state).toBe('half_open');

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });

  it('re-opens if the probe fails', () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 100, () => now);
    breaker.recordFailure();
    now = 150;
    expect(breaker.canExecute()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
  });

  it('rejects work while open without calling through', async () => {
    const breaker = new CircuitBreaker(1);
    breaker.recordFailure();
    const operation = vi.fn();
    await expect(breaker.run(operation)).rejects.toThrow('Circuit breaker is open');
    expect(operation).not.toHaveBeenCalled();
  });

  it('records success and failure through run', async () => {
    const breaker = new CircuitBreaker(2);
    await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.failureCount).toBe(0);

    await expect(
      breaker.run(async () => {
        throw new Error('bad');
      }),
    ).rejects.toThrow('bad');
    expect(breaker.failureCount).toBe(1);
  });
});