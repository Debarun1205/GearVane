/**
 * The app's model-facing controller.
 *
 * Holds one Orchestrator and turns app actions into provider calls. Free of
 * Electron and DOM types so it can be unit tested with a stubbed provider,
 * and reused unchanged in the Android webview.
 */

import {
  HealthChecker,
  Orchestrator,
  SafetyManager,
  type ExecutionResult,
  type HealthResult,
  type RoutingDecision,
  type SpendStatus,
  type TaskContext,
  type GearVaneConfig,
} from '@gearvane/core';

export interface ControllerOptions {
  config: GearVaneConfig;
  /** Supplies API keys. Defaults to the ambient environment. */
  env?: Record<string, string | undefined>;
  /** Injected for tests. */
  createClient?: ConstructorParameters<typeof Orchestrator>[1] extends {
    createClient?: infer T;
  }
    ? T
    : never;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Above this latency a reachable model is reported degraded. */
  latencyThresholdMs?: number;
}

export interface SubmitOptions {
  taskId: string;
  prompt: string;
  filesTouched?: string[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  signal?: AbortSignal;
  onToken?: (token: string, accumulated: string) => void;
  /**
   * Pin this run to one model: "provider/model" or a bare model name.
   * Absent means auto-route, the default. Mirrors the router's
   * manualOverride without touching the shared config.
   */
  model?: string;
}

export interface PreviewResult {
  tier: string;
  provider: string;
  model: string;
  confidence: number;
  reasons: string[];
}

export class AppController {
  private readonly orchestrator: Orchestrator;
  private readonly health: HealthChecker;
  private readonly safety: SafetyManager;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly options: ControllerOptions) {
    this.orchestrator = this.makeOrchestrator(options.config);

    this.health = new HealthChecker(options.config, this.orchestrator.router, {
      timeoutMs: options.timeoutMs ?? 5000,
      latencyThresholdMs: options.latencyThresholdMs ?? 30_000,
      // Keys reach the probes as well as execution, so the Health dialog
      // reflects the same credentials the chat uses.
      env: options.env ?? readEnvironment(),
      // Forwarded so health probes use the same client construction as
      // execution. Without this the checker builds its own clients and hits
      // the network even when a factory was injected.
      ...(options.createClient ? { createClient: options.createClient } : {}),
    });

    this.safety = new SafetyManager(options.config.safety);
  }

  /**
   * Build an orchestrator, optionally pinned to one model.
   *
   * A pin clones the config with the router's manualOverride rather than
   * mutating shared state, so concurrent Auto and pinned runs cannot leak
   * into each other.
   */
  private makeOrchestrator(config: GearVaneConfig, model?: string): Orchestrator {
    const scoped =
      model === undefined
        ? config
        : { ...config, router: { ...config.router, manualOverride: model } };
    return new Orchestrator(scoped, {
      env: this.options.env ?? readEnvironment(),
      ...(this.options.createClient ? { createClient: this.options.createClient } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl as never } : {}),
    });
  }

  /**
   * Show which tier would handle a prompt, without spending anything.
   *
   * The UI calls this while the user is still typing so the chosen tier can
   * be shown before they commit. A pinned model previews through the same
   * override the run would take.
   */
  preview(prompt: string, filesTouched: string[] = [], model?: string): PreviewResult {
    const decision = this.decision(prompt, filesTouched, model);
    return {
      tier: decision.tier,
      provider: decision.provider.name,
      model: decision.model,
      confidence: decision.confidence,
      reasons: decision.reasons,
    };
  }

  private decision(prompt: string, filesTouched: string[], model?: string): RoutingDecision {
    const context: TaskContext = {
      description: prompt,
      filesTouched,
      errorLoops: 0,
      testFailures: 0,
    };
    // A distinct id per preview so repeated previews do not accumulate
    // escalation state that would distort the next real request.
    const router =
      model === undefined
        ? this.orchestrator.router
        : this.makeOrchestrator(this.options.config, model).router;
    return router.route(`preview-${Date.now()}`, context);
  }

  /** Run a request and return the result. */
  async submit(options: SubmitOptions): Promise<ExecutionResult> {
    const controller = new AbortController();
    this.inFlight.set(options.taskId, controller);

    try {
      if (options.stream) {
        return await this.submitStreaming(options, controller.signal);
      }

      const result = await this.makeOrchestrator(this.options.config, options.model).execute(
        options.taskId,
        options.prompt,
        {
          filesTouched: options.filesTouched ?? [],
          maxTokens: options.maxTokens ?? 2048,
          temperature: options.temperature ?? 0,
          ...(options.system ? { system: options.system } : {}),
          signal: controller.signal,
        },
      );

      return result;
    } finally {
      this.inFlight.delete(options.taskId);
    }
  }

  private async submitStreaming(
    options: SubmitOptions,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    let content = '';

    const iterator = this.makeOrchestrator(this.options.config, options.model).executeStream(
      options.taskId,
      options.prompt,
      {
        filesTouched: options.filesTouched ?? [],
        maxTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0,
        ...(options.system ? { system: options.system } : {}),
        signal,
      },
    );

    for await (const token of iterator) {
      content += token;
      options.onToken?.(token, content);
    }

    return {
      taskId: options.taskId,
      success: true,
      content,
      attempts: 1,
      escalated: false,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - started,
      confidence: 0,
      reasons: ['streamed response; usage is not reported by every provider'],
      history: [
        { attempt: 1, tier: 'local', model: 'unknown', success: true },
      ],
    };
  }

  /** Cancel an in-flight request. */
  cancel(taskId: string): boolean {
    const controller = this.inFlight.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Abort everything, used when the window closes. */
  cancelAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  async checkHealth(signal?: AbortSignal): Promise<HealthResult[]> {
    return this.health.checkAll(signal);
  }

  spendStatus(): SpendStatus {
    return this.orchestrator.spend.getStatus();
  }

  costStats(): ReturnType<Orchestrator['cost']['getStats']> {
    return this.orchestrator.cost.getStats();
  }

  /** Exposed so the UI can preview a gated command before running it. */
  gate(command: string): ReturnType<SafetyManager['check']> {
    return this.safety.check(command);
  }

  getRouter(): Orchestrator['router'] {
    return this.orchestrator.router;
  }
}

function readEnvironment(): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env ?? {};
}