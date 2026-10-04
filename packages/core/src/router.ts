import { TaskClassifier, type TaskClassifierOptions } from './classifier.js';
import {
  HybridClassifier,
  LearnedClassifier,
  deserializeWeights,
} from './learned-classifier.js';
import type { SerializedWeights } from './learned-classifier.js';
import type {
  ClassificationResult,
  ProviderConfig,
  RoutingDecision,
  TaskContext,
  Tier,
  TierConfig,
  GearVaneConfig,
} from './types.js';

export type TierOrder = readonly Tier[];

const TIER_ORDER: TierOrder = ['local', 'mid', 'frontier'];

interface TaskState {
  attempts: number;
  failures: number;
  tier: Tier | null;
}

export interface RouterOptions {
  /** Injected for tests; defaults to the heuristic or hybrid classifier. */
  classifier?: { classify(context: TaskContext): ClassificationResult };
  /**
   * Pre-trained model. When supplied and learnedClassifier.enabled is set,
   * the router builds a HybridClassifier around the heuristics.
   */
  learnedModel?: SerializedWeights;
}

/**
 * Routes tasks to a tier, escalating on repeated failure.
 *
 * Provider choice within a tier is round-robin so load spreads across
 * endpoints that offer the same model.
 */
export class TierRouter {
  readonly classifier: { classify(context: TaskContext): ClassificationResult };

  private readonly tiers = new Map<Tier, TierConfig>();
  private readonly tasks = new Map<string, TaskState>();
  private readonly escalationEnabled: boolean;
  private readonly maxAttemptsPerTier: number;
  private readonly defaultTier: Tier;
  private readonly manualOverride: string | null;

  constructor(config: GearVaneConfig, options: RouterOptions = {}) {
    const heuristics: TaskClassifierOptions = config.router.heuristics ?? {};
    const heuristic = new TaskClassifier({ ...heuristics });

    // The learned model only engages when explicitly enabled *and* trained,
    // so a fresh install behaves exactly as it did before.
    const learnedConfig = config.learnedClassifier;
    const learned =
      options.learnedModel && learnedConfig?.enabled
        ? Object.assign(new LearnedClassifier(), {
            weights: deserializeWeights(options.learnedModel),
          })
        : undefined;

    this.classifier =
      options.classifier ??
      (learned && learned.isTrained
        ? new HybridClassifier({
            learned,
            heuristic,
            minSamples: learnedConfig?.minSamples ?? 10,
            blend: learnedConfig?.blend ?? 0.5,
          })
        : heuristic);

    this.escalationEnabled = config.router.escalation.enabled;
    this.maxAttemptsPerTier = config.router.escalation.maxAttemptsPerTier;
    this.defaultTier = config.router.defaultTier;
    this.manualOverride = config.router.manualOverride;

    for (const tier of TIER_ORDER) {
      const entry = config.tiers[tier];
      if (entry) {
        this.tiers.set(tier, {
          ...entry,
          providers: entry.providers.map((provider) => ({ ...provider })),
        });
      }
    }
  }

  /**
   * Resolve a manual override to a tier, provider, and model.
   *
   * Accepts a bare model name ("gpt-4o"), a qualified name
   * ("anthropic/claude-sonnet-4"), or an OpenRouter-style id
   * ("openrouter/anthropic/claude-3-haiku"). Returns undefined when the
   * override matches nothing configured.
   */
  resolveOverride(
    override: string,
  ): { tier: Tier; provider: ProviderConfig; model: string } | undefined {
    const trimmed = override.trim();

    let providerHint: string | undefined;
    let modelName = trimmed;

    if (trimmed.includes('/')) {
      // A provider name may itself contain a slash, so match the longest
      // configured provider prefix before splitting.
      for (const tier of this.tiers.values()) {
        for (const provider of tier.providers) {
          const prefix = `${provider.name}/`;
          if (trimmed.startsWith(prefix)) {
            providerHint = provider.name;
            modelName = trimmed.slice(prefix.length);
            break;
          }
        }
      }
      if (providerHint === undefined) {
        const slash = trimmed.indexOf('/');
        providerHint = trimmed.slice(0, slash);
        modelName = trimmed.slice(slash + 1);
      }
    }

    for (const [tier, tierConfig] of this.tiers) {
      for (const provider of tierConfig.providers) {
        if (providerHint && provider.name !== providerHint) continue;
        for (const model of provider.models) {
          if (model === modelName) {
            return { tier, provider, model };
          }
        }
      }
    }

    return undefined;
  }

  route(taskId: string, context: TaskContext): RoutingDecision {
    if (this.manualOverride) {
      const resolved = this.resolveOverride(this.manualOverride);
      if (resolved) {
        return {
          tier: resolved.tier,
          provider: resolved.provider,
          model: resolved.model,
          confidence: 1,
          reasons: [`Manual override: ${this.manualOverride}`],
          escalated: false,
          attempt: 1,
        };
      }
      // An override that matches nothing must not silently degrade to normal
      // routing: the user explicitly asked for a model. Fall through with a
      // reason that makes the miss visible.
    }

    let state = this.tasks.get(taskId);
    if (!state) {
      state = { attempts: 0, failures: 0, tier: null };
      this.tasks.set(taskId, state);
    }
    state.attempts += 1;

    const classification = this.classifier.classify(context);
    const reasons = [...classification.reasons];

    if (this.manualOverride && !this.resolveOverride(this.manualOverride)) {
      reasons.push(
        `Manual override '${this.manualOverride}' matched no configured model; ` +
          'falling back to automatic routing',
      );
    }

    let tier = classification.tier;
    let escalated = false;

    if (this.escalationEnabled && state.failures >= this.maxAttemptsPerTier) {
      const index = TIER_ORDER.indexOf(tier);
      if (index >= 0 && index < TIER_ORDER.length - 1) {
        const next = TIER_ORDER[index + 1];
        if (next) {
          reasons.push(`Escalating from ${tier} to ${next} after repeated failures`);
          tier = next;
          escalated = true;
          state.failures = 0;
        }
      }
    }

    let tierConfig = this.tiers.get(tier);
    if (!tierConfig || tierConfig.providers.length === 0) {
      reasons.push(
        `No config for tier ${tier}, falling back to ${this.defaultTier}`,
      );
      tier = this.defaultTier;
      tierConfig = this.tiers.get(tier);
    }

    if (!tierConfig || tierConfig.providers.length === 0) {
      throw new Error(
        'No usable model tiers configured. Add at least one provider under ' +
          "'tiers' in your config.",
      );
    }

    const provider =
      tierConfig.providers[(state.attempts - 1) % tierConfig.providers.length];
    const model = provider?.models[0] ?? '';

    state.tier = tier;

    return {
      tier,
      provider: provider as ProviderConfig,
      model,
      confidence: classification.confidence,
      reasons,
      escalated,
      attempt: state.attempts,
    };
  }

  reportFailure(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (state) state.failures += 1;
  }

  reportSuccess(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (state) state.failures = 0;
  }

  getTaskState(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  getConfiguredTiers(): Tier[] {
    return [...this.tiers.keys()];
  }
}