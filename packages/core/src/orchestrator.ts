import { ProviderError, ProviderFactory } from './providers.js';
import { RetryExhaustedError, withRetry, type RetryConfig } from './retry.js';
import { TierRouter } from './router.js';
import type { SerializedWeights } from './learned-classifier.js';
import type {
  AttemptRecord,
  ExecutionResult,
  ProviderConfig,
  RoutingDecision,
  TaskContext,
  WaypointConfig,
} from './types.js';

export interface BudgetExceeded extends Error {
  name: 'BudgetExceeded';
}

/** Raised when a task's estimated cost cannot fit the remaining budget. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

export interface SpendLimits {
  perSession: number;
  perDay: number;
  perTask: number;
}

export interface SpendStatus {
  sessionSpend: number;
  daySpend: number;
  taskSpend: number;
  sessionRemaining: number;
  dayRemaining: number;
  taskRemaining: number;
}

/**
 * Tracks spend against per-task, per-session, and per-day ceilings.
 *
 * Per-task spend resets when the task id changes. The Python implementation
 * originally never reset it, so one expensive task blocked every later task
 * for the life of the process; this version resets on task change.
 */
export class SpendTracker {
  sessionSpend = 0;
  daySpend = 0;
  taskSpend = 0;

  private currentTaskId: string | null = null;
  private readonly dayEntries: Array<{ at: number; amount: number }> = [];

  constructor(
    readonly limits: SpendLimits,
    private readonly now: () => number = Date.now,
  ) {}

  startTask(taskId: string): void {
    if (this.currentTaskId !== taskId) {
      this.taskSpend = 0;
      this.currentTaskId = taskId;
    }
  }

  /** Drop day-bucket entries older than 24h and fold them into daySpend. */
  private pruneDay(): void {
    const cutoff = this.now() - 86_400_000;
    while (this.dayEntries.length > 0 && (this.dayEntries[0]?.at ?? 0) < cutoff) {
      this.dayEntries.shift();
    }
    this.daySpend = this.dayEntries.reduce((sum, entry) => sum + entry.amount, 0);
  }

  canSpend(amount: number, taskId?: string): boolean {
    if (taskId !== undefined) this.startTask(taskId);
    this.pruneDay();
    return (
      this.sessionSpend + amount <= this.limits.perSession &&
      this.daySpend + amount <= this.limits.perDay &&
      this.taskSpend + amount <= this.limits.perTask
    );
  }

  recordSpend(amount: number, taskId?: string): void {
    if (taskId !== undefined) this.startTask(taskId);
    this.sessionSpend += amount;
    this.taskSpend += amount;
    this.dayEntries.push({ at: this.now(), amount });
    this.daySpend += amount;
  }

  resetSession(): void {
    this.sessionSpend = 0;
    this.daySpend = 0;
    this.taskSpend = 0;
    this.dayEntries.length = 0;
    this.currentTaskId = null;
  }

  getStatus(): SpendStatus {
    this.pruneDay();
    return {
      sessionSpend: round(this.sessionSpend),
      daySpend: round(this.daySpend),
      taskSpend: round(this.taskSpend),
      sessionRemaining: round(this.limits.perSession - this.sessionSpend),
      dayRemaining: round(this.limits.perDay - this.daySpend),
      taskRemaining: round(this.limits.perTask - this.taskSpend),
    };
  }
}

export interface CostStats {
  totalCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  costByTier: Record<string, number>;
  costByModel: Record<string, number>;
}

/** Accumulates token cost per tier and per model. */
export class CostTracker {
  private calls = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private readonly tierCost = new Map<string, number>();
  private readonly modelCost = new Map<string, number>();

  recordUsage(tier: string, model: string, tokensIn: number, tokensOut: number): number {
    const rate = this.rates.get(tier) ?? 0;
    const cost = (tokensIn + tokensOut) * rate;

    this.calls += 1;
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.tierCost.set(tier, (this.tierCost.get(tier) ?? 0) + cost);
    this.modelCost.set(model, (this.modelCost.get(model) ?? 0) + cost);

    return cost;
  }

  private readonly rates = new Map<string, number>();

  setCostPerToken(tier: string, rate: number): void {
    this.rates.set(tier, rate);
  }

  /** USD per token for a tier, or 0 when the tier is unknown or free. */
  getCostPerToken(tier: string): number {
    return this.rates.get(tier) ?? 0;
  }

  /** Always returns the same keys so callers need no special case. */
  getStats(): CostStats {
    const costByTier: Record<string, number> = {};
    for (const [tier, cost] of this.tierCost) costByTier[tier] = round(cost);

    const costByModel: Record<string, number> = {};
    for (const [model, cost] of this.modelCost) costByModel[model] = round(cost);

    return {
      totalCalls: this.calls,
      totalTokensIn: this.tokensIn,
      totalTokensOut: this.tokensOut,
      totalCostUsd: round(
        [...this.tierCost.values()].reduce((sum, cost) => sum + cost, 0),
      ),
      costByTier,
      costByModel,
    };
  }

  reset(): void {
    this.calls = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.tierCost.clear();
    this.modelCost.clear();
  }
}

export interface ExecuteOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  filesTouched?: string[];
  errorLoops?: number;
  testFailures?: number;
}

export interface OrchestratorOptions {
  /** Supplies API keys to the provider factory. */
  env?: Record<string, string | undefined>;
  fetchImpl?: ConstructorParameters<typeof ProviderFactory>[0] extends {
    fetchImpl?: infer T;
  }
    ? T
    : never;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Injected for tests. */
  createClient?: (provider: ProviderConfig, model?: string) => unknown;
  /** Pre-trained model weights. When supplied and learnedClassifier.enabled
   * is set, the router builds a HybridClassifier around the heuristics. */
  learnedModel?: SerializedWeights;
}

export type StreamingClient = {
  stream(prompt: string, options?: Record<string, unknown>): AsyncIterable<string>;
};

/**
 * Routes and executes tasks, with escalation, retries, and budget gates.
 *
 * This is the piece the Python version lacked when it shipped: the router
 * produced decisions but nothing acted on them.
 */
export class Orchestrator {
  readonly router: TierRouter;
  readonly spend: SpendTracker;
  readonly cost = new CostTracker();

  private readonly providers: ProviderFactory;
  private readonly maxEscalations: number;
  private readonly retryConfig: RetryConfig;
  private readonly createClient: (provider: ProviderConfig, model?: string) => unknown;

  constructor(config: WaypointConfig, options: OrchestratorOptions = {}) {
    this.router = new TierRouter(config, { learnedModel: options.learnedModel });
    this.spend = new SpendTracker(config.safety.spendLimits, options.now);
    this.providers = new ProviderFactory({
      env: options.env ?? {},
      timeoutMs: config.providers.timeoutSeconds * 1000,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    this.maxEscalations = config.router.escalation.maxEscalations ?? 2;
    this.retryConfig = {
      maxRetries: config.providers.maxRetries,
      baseDelayMs: config.providers.retryBaseDelay * 1000,
      maxDelayMs: config.providers.retryMaxDelay * 1000,
      strategy: 'exponential_with_jitter',
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.random ? { random: options.random } : {}),
    };

    for (const [tier, tierConfig] of Object.entries(config.tiers)) {
      this.cost.setCostPerToken(tier, tierConfig.costPerToken);
    }

    this.createClient =
      options.createClient ??
      ((provider, model) => this.providers.create(provider, model));
  }

  /**
   * Route and run a task, retrying and escalating as needed.
   */
  async execute(
    taskId: string,
    prompt: string,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const history: AttemptRecord[] = [];
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let errorLoops = options.errorLoops ?? 0;
    let escalatedAny = false;

    for (let attempt = 0; attempt <= this.maxEscalations; attempt += 1) {
      const context: TaskContext = {
        description: prompt,
        filesTouched: options.filesTouched ?? [],
        errorLoops,
        testFailures: options.testFailures ?? 0,
      };

      const decision = this.router.route(taskId, context);
      if (decision.escalated) escalatedAny = true;

      const maxTokens = options.maxTokens ?? 2048;
      const unitCost = this.rateFor(decision.tier);
      const estimated = unitCost * maxTokens;

      // Budget gate runs before any tokens are spent.
      if (!this.spend.canSpend(estimated, taskId)) {
        return {
          taskId,
          success: false,
          content: '',
          tier: decision.tier,
          provider: decision.provider.name,
          model: decision.model,
          attempts: attempt + 1,
          escalated: escalatedAny,
          costUsd: round(totalCost),
          tokensIn: totalIn,
          tokensOut: totalOut,
          durationMs: Date.now() - startedAt,
          confidence: decision.confidence,
          reasons: decision.reasons,
          error: `Budget exceeded: $${estimated.toFixed(4)} would exceed the limit`,
          history,
        };
      }

      try {
        const completion = await this.callWithRetry(decision, prompt, options);

        const cost = unitCost * (completion.usage.tokensIn + completion.usage.tokensOut);
        totalCost += cost;
        totalIn += completion.usage.tokensIn;
        totalOut += completion.usage.tokensOut;

        this.cost.recordUsage(
          decision.tier,
          decision.model,
          completion.usage.tokensIn,
          completion.usage.tokensOut,
        );
        this.spend.recordSpend(cost, taskId);
        this.router.reportSuccess(taskId);

        history.push({
          attempt: attempt + 1,
          tier: decision.tier,
          model: decision.model,
          success: true,
          costUsd: round(cost),
        });

        return {
          taskId,
          success: true,
          content: completion.content,
          tier: decision.tier,
          provider: decision.provider.name,
          model: decision.model,
          attempts: attempt + 1,
          escalated: escalatedAny,
          costUsd: round(totalCost),
          tokensIn: totalIn,
          tokensOut: totalOut,
          durationMs: Date.now() - startedAt,
          confidence: decision.confidence,
          reasons: decision.reasons,
          history,
        };
      } catch (error) {
        // An abort is the caller cancelling, not a provider fault. Retrying
        // would re-issue a request the user already cancelled, and the
        // replacement call never sees a fresh abort event, so it hangs.
        if (options.signal?.aborted) {
          history.push({
            attempt: attempt + 1,
            tier: decision.tier,
            model: decision.model,
            success: false,
            error: 'cancelled',
          });
          return {
            taskId,
            success: false,
            content: '',
            tier: decision.tier,
            provider: decision.provider.name,
            model: decision.model,
            attempts: attempt + 1,
            escalated: escalatedAny,
            costUsd: round(totalCost),
            tokensIn: totalIn,
            tokensOut: totalOut,
            durationMs: Date.now() - startedAt,
            confidence: decision.confidence,
            reasons: decision.reasons,
            error: 'cancelled',
            history,
          };
        }

        const message = describeError(error);

        this.router.reportFailure(taskId);
        history.push({
          attempt: attempt + 1,
          tier: decision.tier,
          model: decision.model,
          success: false,
          error: message,
        });

        // Feed the failure into the next classification so escalation is
        // driven by observed errors, not only caller hints.
        errorLoops += 1;
      }
    }

    return {
      taskId,
      success: false,
      content: '',
      attempts: this.maxEscalations + 1,
      escalated: escalatedAny,
      costUsd: round(totalCost),
      tokensIn: totalIn,
      tokensOut: totalOut,
      durationMs: Date.now() - startedAt,
      confidence: 0,
      reasons: [],
      error: 'All attempts failed',
      history,
    };
  }

  /**
   * Route a task and stream the response.
   *
   * Streaming responses are not budget-gated, since usage is unknown until
   * the stream completes; the caller sees the tokens either way.
   */
  async *executeStream(
    taskId: string,
    prompt: string,
    options: ExecuteOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const context: TaskContext = {
      description: prompt,
      filesTouched: options.filesTouched ?? [],
      errorLoops: options.errorLoops ?? 0,
      testFailures: options.testFailures ?? 0,
    };

    const decision = this.router.route(taskId, context);
    const client = this.createClient(decision.provider, decision.model) as StreamingClient;

    const completeOptions: Record<string, unknown> = {
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 2048,
    };
    if (options.system) completeOptions['system'] = options.system;
    if (options.signal) completeOptions['signal'] = options.signal;

    for await (const token of client.stream(prompt, completeOptions)) {
      yield token;
    }
  }

  private rateFor(tier: string): number {
    return this.cost.getCostPerToken(tier);
  }

  private async callWithRetry(
    decision: RoutingDecision,
    prompt: string,
    options: ExecuteOptions,
  ) {
    const client = this.createClient(
      decision.provider,
      decision.model,
    ) as {
      complete: (
        prompt: string,
        options?: Record<string, unknown>,
      ) => Promise<{
        content: string;
        usage: { tokensIn: number; tokensOut: number };
      }>;
    };

    const completeOptions: Record<string, unknown> = {
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 2048,
    };
    if (options.system) completeOptions['system'] = options.system;
    if (options.signal) completeOptions['signal'] = options.signal;

    return withRetry(
      () => client.complete(prompt, completeOptions),
      this.retryConfig,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof RetryExhaustedError) {
    return `${error.message}: ${describeError(error.lastError)}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}