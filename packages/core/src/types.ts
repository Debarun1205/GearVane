/**
 * Shared types for the GearVane core.
 *
 * These mirror the Python dataclasses so behaviour stays comparable across
 * the two implementations. Where Python was permissive with `Any` config
 * access, the TypeScript port is deliberately stricter: an unknown tier or
 * provider name is a type error rather than a runtime surprise.
 */



/** Model tiers, ordered from cheapest to most capable. */
export const TIERS = ['local', 'mid', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * Cost classes: a granular cost classification independent of capability tiers.
 *
 * A tier (local/mid/frontier) describes capability. A cost class describes
 * billing characteristics. They are orthogonal:
 *
 * - A local model might be free (cost_class: 'free') or require a license fee
 * - A mid-tier model might be pay-per-token (cost_class: 'metered') or have a
 *   monthly cap (cost_class: 'capped')
 * - A frontier model might be expensive pay-per-token (cost_class: 'premium')
 *
 * This allows the router to make cost-aware decisions without conflating
 * capability with cost.
 */

export const COST_CLASSES = ['free', 'metered', 'capped', 'premium'] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export function isCostClass(value: string): value is CostClass {
  return (COST_CLASSES as readonly string[]).includes(value);
}

/** Default cost class for a tier when not explicitly configured. */
export function defaultCostClassForTier(tier: string): CostClass {
  switch (tier) {
    case 'local':
      return 'free';
    case 'mid':
      return 'metered';
    case 'frontier':
      return 'premium';
    default:
      return 'metered';
  }
}

/** Configuration for a cost class. */
export interface CostClassConfig {
  /** Human-readable name. */
  label: string;
  /** Whether this class can ever bill the user. */
  billable: boolean;
  /** Whether usage should be tracked even if not billed. */
  trackUsage: boolean;
  /** Default rate in USD per token (for metered/premium). */
  defaultRate?: number;
  /** Optional cap for capped classes (USD per session). */
  capPerSession?: number;
  /** Optional cap for capped classes (USD per day). */
  capPerDay?: number;
  /** Optional cap for capped classes (USD per task). */
  capPerTask?: number;
}

/** Default cost class configs. */
export const DEFAULT_COST_CLASSES: Record<CostClass, CostClassConfig> = {
  free: {
    label: 'Free',
    billable: false,
    trackUsage: true,
  },
  metered: {
    label: 'Pay-per-token',
    billable: true,
    trackUsage: true,
    defaultRate: 0.0001,
  },
  capped: {
    label: 'Capped monthly',
    billable: true,
    trackUsage: true,
    defaultRate: 0.001,
    capPerSession: 10.0,
    capPerDay: 50.0,
    capPerTask: 5.0,
  },
  premium: {
    label: 'Premium',
    billable: true,
    trackUsage: true,
    defaultRate: 0.005,
  },
};

/**
 * Get the cost class configuration, falling back to the tier default.
 */
export function getCostClassConfig(
  tierConfig: { costClass?: CostClass; costPerToken: number; name: string },
): CostClassConfig {
  const costClass = tierConfig.costClass ?? defaultCostClassForTier(tierConfig.name);
  const base = DEFAULT_COST_CLASSES[costClass];

  // If the tier specifies a custom rate, merge it in.
  if (tierConfig.costPerToken !== undefined && tierConfig.costPerToken !== base.defaultRate) {
    return { ...base, defaultRate: tierConfig.costPerToken };
  }
  return base;
}

export interface ProviderConfig {
  name: string;
  models: string[];
  /** Overrides the provider's default base URL. */
  baseUrl?: string;
  /**
   * A key carried in the config itself. Only the embedded provider uses
   * this, for the per-launch loopback bearer token the desktop main
   * process injects at runtime. Cloud providers keep using `apiKeyEnv`:
   * a config file on disk must never hold a user secret.
   */
  apiKey?: string;
  /** Name of the env var holding the API key. Never the key itself. */
  apiKeyEnv?: string;
  /**
   * Path of the chat completions endpoint, relative to the base URL.
   *
   * Needed because not every OpenAI-compatible API puts it at
   * `/v1/chat/completions`: Meta serves it at `/chat/completions` under a
   * `/v1` base, and Gemini at `/chat/completions` under `/v1beta/openai`.
   */
  completionsPath?: string;
  /**
   * Path of the model listing endpoint, relative to the base URL.
   *
   * Same reason as above, for health checks and `models` commands.
   */
  modelsPath?: string;
}

export interface TierConfig {
  name: Tier;
  description: string;
  providers: ProviderConfig[];
  maxRetries: number;
  /** USD per token. Zero for local models. */
  costPerToken: number;
  /** Cost class: 'free' | 'metered' | 'capped' | 'premium'.
   *  Determines billing behaviour independent of capability tier. */
  costClass?: CostClass;
}

export interface EscalationConfig {
  enabled: boolean;
  maxAttemptsPerTier: number;
  autoPromoteOnFailure: boolean;
  /** Upper bound on promotions per task. */
  maxEscalations?: number;
}

export interface HeuristicsConfig {
  simpleKeywords?: string[];
  complexKeywords?: string[];
  /**
   * File patterns that raise complexity. Both glob and regex syntax are
   * accepted: a pattern that is not valid regex is treated as a glob, so
   * "*.rs" matches "src/main.rs".
   */
  complexFilePatterns?: string[];
  minFilesForComplex?: number;
}

export interface RouterConfig {
  defaultTier: Tier;
  escalation: EscalationConfig;
  /** Bare name, "provider/model", or an OpenRouter-style id. */
  manualOverride: string | null;
  heuristics?: HeuristicsConfig;
}

export interface LearnedClassifierConfig {
  enabled: boolean;
  modelFile: string;
  minSamples: number;
  blend: number;
  learningRate?: number;
  epochs?: number;
  /**
   * Per-model feedback file override, mirroring Python's
   * learned_classifier.feedback_file (which falls back to
   * logging.feedback_file). Absent unless the user sets it.
   */
  feedbackFile?: string;
}

export interface SafetyConfig {
  requireApproval: string[];
  sandboxAllowed: string[];
  blockedCommands: string[];
}

export interface ProviderRuntimeConfig {
  timeoutSeconds: number;
  maxRetries: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
}

export interface LoggingConfig {
  enabled: boolean;
  level: string;
  file: string;
  logRoutingDecisions: boolean;
  logEscalations: boolean;
  logCosts: boolean;
  feedbackFile?: string;
}

export interface GearVaneConfig {
  tiers: Record<Tier, TierConfig>;
  router: RouterConfig;
  providers: ProviderRuntimeConfig;
  learnedClassifier: LearnedClassifierConfig;
  safety: SafetyConfig;
  logging: LoggingConfig;
}

/** Signals used to classify a task into a tier. */
export interface TaskContext {
  description: string;
  filesTouched: string[];
  errorLoops: number;
  testFailures: number;
  previousTier?: Tier;
  previousAttempts?: number;
}

export interface ClassificationResult {
  tier: Tier;
  /** 0..1 */
  confidence: number;
  reasons: string[];
  scores: Record<Tier, number>;
}

export interface RoutingDecision {
  tier: Tier;
  provider: ProviderConfig;
  model: string;
  confidence: number;
  reasons: string[];
  escalated: boolean;
  attempt: number;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export interface Completion {
  content: string;
  model: string;
  usage: Usage;
  finishReason: string;
  toolCalls: ToolCall[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

import type { VerificationSummary } from './verification.js';

export interface AttemptRecord {
  attempt: number;
  tier: Tier;
  model: string;
  success: boolean;
  costUsd?: number;
  error?: string;
  /**
   * Whether this attempt's answer passed an injected verifier.
   *
   * Absent means no verifier ran, which is not the same as false. `false` is a
   * failed check and is recorded as a failed attempt; absent means nothing
   * checked it.
   */
  verified?: boolean;
}

export interface ExecutionResult {
  taskId: string;
  success: boolean;
  content: string;
  tier?: Tier;
  provider?: string;
  model?: string;
  attempts: number;
  escalated: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  confidence: number;
  reasons: string[];
  error?: string;
  history: AttemptRecord[];
  /**
   * The verifier's verdict, when one ran.
   *
   * Absent means no verifier was supplied - not that the answer was confirmed.
   * `outcome: 'unknown'` means a check was attempted and could not conclude,
   * which is deliberately distinct from a pass.
   */
  verification?: VerificationSummary;
}