import { ProviderError } from './providers.js';

export type RetryStrategy = 'fixed' | 'exponential' | 'exponential_with_jitter';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  strategy: RetryStrategy;
  /** Random source, injected so jitter is deterministic under test. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Backoff delay before the given attempt.
 *
 * Jitter uses the full-jitter strategy from the AWS Architecture blog:
 * picking uniformly from [0, capped] avoids the thundering-herd retry
 * spike that pure exponential backoff causes across many clients.
 */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  const random = config.random ?? Math.random;

  switch (config.strategy) {
    case 'fixed':
      return config.baseDelayMs;

    case 'exponential': {
      const delay = config.baseDelayMs * 2 ** attempt;
      return Math.min(delay, config.maxDelayMs);
    }

    case 'exponential_with_jitter': {
      const exponential = config.baseDelayMs * 2 ** attempt;
      const capped = Math.min(exponential, config.maxDelayMs);
      return random() * capped;
    }

    default:
      return config.baseDelayMs;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying transient failures with backoff.
 *
 * Only errors that are `retryable` are retried. A bad API key fails
 * immediately rather than consuming every attempt, which matters because
 * callers typically surface the final error to a user.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  const sleep = config.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) throw error;

      if (attempt >= config.maxRetries) break;

      const delay = calculateDelay(attempt, config);
      config.onRetry?.(attempt + 1, delay, error);
      if (delay > 0) await sleep(delay);
    }
  }

  throw new RetryExhaustedError(
    `Operation failed after ${config.maxRetries + 1} attempts`,
    lastError,
    config.maxRetries + 1,
  );
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  return false;
}

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly lastError: unknown,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Circuit breaker to stop hammering a failing endpoint.
 *
 * While open, calls are rejected without a network round trip. After
 * `recoveryMs` the breaker half-opens and lets one probe through; success
 * closes it, failure re-opens it.
 */
export class CircuitBreaker {
  state: BreakerState = 'closed';
  failureCount = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (this.now() - this.lastFailureAt > this.recoveryMs) {
        this.state = 'half_open';
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    if (this.state === 'half_open') this.state = 'closed';
  }

  recordFailure(): void {
    this.failureCount += 1;
    this.lastFailureAt = this.now();
    if (this.failureCount >= this.failureThreshold) this.state = 'open';
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error('Circuit breaker is open');
    }
    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}