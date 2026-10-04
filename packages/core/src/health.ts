import { ProviderFactory, type ProviderClient } from './providers.js';
import type { TierRouter } from './router.js';
import type { GearVaneConfig } from './types.js';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthResult {
  model: string;
  provider: string;
  status: HealthStatus;
  latencyMs: number;
  message: string;
}

export interface HealthOptions {
  /** Consecutive failures before a model reports unhealthy. */
  failureThreshold?: number;
  /** Above this latency a reachable model is reported degraded. */
  latencyThresholdMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /**
   * Supplies API keys to the probed clients. Without this, hosted models
   * probe anonymously and report unhealthy even when a key exists, which
   * is exactly what the app's bring-your-own-keys dialog would show.
   */
  env?: Record<string, string | undefined>;
  createClient?: (providerName: string, model: string) => ProviderClient | undefined;
}

/**
 * Probes each configured model and reports availability.
 *
 * A model with no probe reports `unknown` rather than `healthy`. Reporting
 * healthy without contacting anything produces a false green, which is worse
 * than reporting nothing.
 */
export class HealthChecker {
  private readonly results = new Map<string, HealthResult>();
  private readonly failures = new Map<string, number>();
  private readonly failureThreshold: number;
  private readonly latencyThresholdMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly config: GearVaneConfig,
    private readonly router?: TierRouter,
    private readonly options: HealthOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.latencyThresholdMs = options.latencyThresholdMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Every model referenced by the config, deduplicated. */
  models(): Array<{ provider: string; model: string }> {
    const seen = new Map<string, { provider: string; model: string }>();
    for (const tier of Object.values(this.config.tiers)) {
      for (const provider of tier.providers) {
        for (const model of provider.models) {
          const key = `${provider.name}/${model}`;
          if (!seen.has(key)) seen.set(key, { provider: provider.name, model });
        }
      }
    }
    return [...seen.values()];
  }

  async checkAll(signal?: AbortSignal): Promise<HealthResult[]> {
    return Promise.all(this.models().map((m) => this.check(m.provider, m.model, signal)));
  }

  async check(
    providerName: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<HealthResult> {
    const key = `${providerName}/${model}`;
    const started = this.now();

    const client = this.clientFor(providerName, model);
    if (!client) {
      const result: HealthResult = {
        model,
        provider: providerName,
        status: 'unknown',
        latencyMs: 0,
        message: 'No provider configuration found',
      };
      this.results.set(key, result);
      return result;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;

      let reachable: boolean;
      try {
        reachable = await client.healthCheck(combined);
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = this.now() - started;
      let status: HealthStatus;
      let message: string;

      if (reachable) {
        this.failures.set(key, 0);
        status = 'healthy';
        message = 'Endpoint reachable';
      } else {
        const count = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, count);
        status = count < this.failureThreshold ? 'degraded' : 'unhealthy';
        message = `Endpoint unreachable (${count} consecutive failures)`;
      }

      if (status === 'healthy' && latencyMs > this.latencyThresholdMs) {
        status = 'degraded';
        message = `High latency: ${Math.round(latencyMs)}ms`;
      }

      const result: HealthResult = { model, provider: providerName, status, latencyMs, message };
      this.results.set(key, result);
      return result;
    } catch (error) {
      const count = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, count);
      const result: HealthResult = {
        model,
        provider: providerName,
        status: count < this.failureThreshold ? 'degraded' : 'unhealthy',
        latencyMs: this.now() - started,
        message: error instanceof Error ? error.message : String(error),
      };
      this.results.set(key, result);
      return result;
    }
  }

  private clientFor(providerName: string, model: string): ProviderClient | undefined {
    if (this.options.createClient) {
      return this.options.createClient(providerName, model);
    }

    for (const tier of Object.values(this.config.tiers)) {
      for (const provider of tier.providers) {
        if (provider.name === providerName && provider.models.includes(model)) {
          return new ProviderFactory({ timeoutMs: this.timeoutMs, env: this.options.env }).create(
            provider,
            model,
          );
        }
      }
    }
    return undefined;
  }

  getResults(): HealthResult[] {
    return [...this.results.values()];
  }

  healthy(): string[] {
    return this.getResults()
      .filter((r) => r.status === 'healthy')
      .map((r) => `${r.provider}/${r.model}`);
  }

  unhealthy(): string[] {
    return this.getResults()
      .filter((r) => r.status === 'unhealthy' || r.status === 'degraded')
      .map((r) => `${r.provider}/${r.model}`);
  }
}