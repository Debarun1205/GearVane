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

export interface AttemptRecord {
  attempt: number;
  tier: Tier;
  model: string;
  success: boolean;
  costUsd?: number;
  error?: string;
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
}