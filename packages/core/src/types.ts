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

export const COST_CLASSES = ['free', 'metered'] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export function isCostClass(value: string): value is CostClass {
  return (COST_CLASSES as readonly string[]).includes(value);
}

/**
 * Provider names that run on the user's own machine.
 *
 * A run through one of these cannot bill anybody, whatever tier it sits in.
 * Tiers are capability bands, and the mid and high bands deliberately hold
 * local weights -- so deriving cost from the tier bills the user for running
 * a model on their own GPU. That is what `safety spend` used to print:
 * "mid, metered, $0.0001/token (embedded, ...)".
 *
 * Kept as a literal rather than importing LOCAL_PROVIDER_NAMES from
 * providers.ts: types.ts is the lowest module in core and must not depend on
 * the provider layer. tests pin the two lists against each other.
 */
export const LOCAL_PROVIDER_NAMES_FOR_COST: readonly string[] = [
  'embedded',
  'ollama',
  'lm_studio',
  'llama_cpp',
  'llamacpp',
  'vllm',
  'localai',
  'gpt4all',
  'textgen',
];

/** The subset of provider fields that decide whether a run can bill. */
export interface CostBearingProvider {
  name: string;
  /** Cloud providers declare the env var holding the key. */
  apiKeyEnv?: string;
  /** The embedded provider carries a per-launch loopback token instead. */
  apiKey?: string;
}

/**
 * Cost class for one provider, derived from what it is rather than where it
 * sits.
 *
 * The rule is one sentence: a run costs money only if reaching the model
 * required a key that belongs to somebody else. Everything served from this
 * machine is free, so the tier it was filed under is irrelevant.
 *
 * `apiKeyEnv` is the signal rather than membership of a name list, so a
 * self-hosted provider the user configures is treated the way it actually
 * works. A local server reached without a key is free even if the config
 * carries a loopback token.
 */
export function costClassForProvider(provider: CostBearingProvider): CostClass {
  const local = LOCAL_PROVIDER_NAMES_FOR_COST.includes(provider.name.toLowerCase());
  if (local) return 'free';
  // No key variable means nothing to bill against.
  return provider.apiKeyEnv ? 'metered' : 'free';
}

/** True when any provider in the list can bill the user. */
export function anyProviderBills(providers: readonly CostBearingProvider[]): boolean {
  return providers.some((provider) => costClassForProvider(provider) === 'metered');
}

/**
 * Effective cost per token across a tier's providers.
 *
 * Only what a run would actually cost. A tier mixing local and cloud providers
 * reports the cloud rate, because that is the rate a run through the cloud one
 * would pay -- and the caller still reports local providers as free, so the
 * user sees which is which rather than a single blended number.
 */
export function tierCostPerToken(
  tier: { providers: readonly CostBearingProvider[]; costPerToken: number },
): number {
  return anyProviderBills(tier.providers) ? tier.costPerToken : 0;
}

/**
 * Configuration for a cost class.
 *
 * There is deliberately no cap field. Per-task, per-session and per-day USD
 * ceilings were removed: they were never enforced, they printed numbers that
 * looked like budgets, and a ceiling on a free run is a ceiling on zero. Run
 * safety is bounded by iterations and wall-clock time instead, which is a
 * safeguard against a runaway loop rather than a budget.
 */
export interface CostClassConfig {
  /** Human-readable name. */
  label: string;
  /** Whether this class can ever bill the user. */
  billable: boolean;
  /** Whether usage should be tracked even if not billed. */
  trackUsage: boolean;
  /** Reference rate in USD per token. An estimate, never charged. */
  defaultRate?: number;
}

/**
 * Default cost class configs.
 *
 * Two classes, because there are two real situations: a run that cannot cost
 * money, and a run that draws on somebody's key. 'capped' and 'premium' are
 * gone -- they carried per-day and per-session ceilings that were never
 * enforced and read as budgets nobody had agreed to.
 */
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
};

/**
 * The cost class configuration for a tier.
 *
 * Derived from the providers the tier holds, never from the tier's name. An
 * explicit `costClass` in config is still honoured, so a user who wants a
 * stricter classification can say so; what is gone is the silent default that
 * called anything in `frontier` billable.
 */
export function getCostClassConfig(
  tierConfig: {
    costClass?: CostClass;
    costPerToken: number;
    name: string;
    providers: readonly CostBearingProvider[];
  },
): CostClassConfig {
  const derived = anyProviderBills(tierConfig.providers) ? 'metered' : 'free';
  const costClass = tierConfig.costClass ?? derived;
  const base = DEFAULT_COST_CLASSES[costClass];

  // A tier with no billing provider has no rate, whatever it was configured
  // with: reporting a per-token price for a free run is the original bug.
  if (!anyProviderBills(tierConfig.providers)) {
    return { ...base, defaultRate: 0 };
  }
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
  /** USD per token, used to report what a run would cost. Zero for local. */
  costPerToken: number;
  /**
   * Cost class, overriding the value derived from this tier's providers.
   *
   * Normally leave it unset: `costClassForProvider` gets it right per provider,
   * which matters because a single tier holds both free local weights and
   * keyed cloud models.
   */
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