/**
 * Waypoint core: tier routing, escalation, provider clients, cost control.
 *
 * Runs unchanged in Node, a browser, an Electron renderer, and an Android
 * webview. The only host capability it needs is `fetch`, which all of them
 * provide.
 */

export * from './types.js';
export {
  classifyGlob,
  compilePattern,
  globToRegexSource,
  globToSegmentRegexSource,
} from './globs.js';
export { parseYaml, parseScalar, YamlError } from './yaml.js';
export { ConfigError, parseConfig, TIER_NAMES } from './config.js';
export {
  DEFAULT_COMPLEX_FILE_PATTERNS,
  DEFAULT_COMPLEX_KEYWORDS,
  DEFAULT_SIMPLE_KEYWORDS,
  TaskClassifier,
  type TaskClassifierOptions,
} from './classifier.js';
export {
  HybridClassifier,
  LearnedClassifier,
  deserializeWeights,
  emptyWeights,
  featuresFor,
  normalize,
  serializeWeights,
  tokenize,
  type HybridClassifierOptions,
  type LearnedClassifierOptions,
  type LearnedWeights,
  type SerializedWeights,
} from './learned-classifier.js';
export { TierRouter, type RouterOptions } from './router.js';
export {
  AnthropicClient,
  DEFAULT_API_PATHS,
  DEFAULT_BASE_URLS,
  OllamaClient,
  OpenAICompatClient,
  ProviderError,
  ProviderFactory,
  ProviderClient,
  setFetchImpl,
  toOpenAITool,
  type ClientFactoryOptions,
  type CompleteOptions,
  type ConversationMessage,
  type FetchLike,
  type ToolDefinition,
} from './providers.js';
export {
  CircuitBreaker,
  RetryExhaustedError,
  calculateDelay,
  withRetry,
  type BreakerState,
  type RetryConfig,
  type RetryStrategy,
} from './retry.js';
export {
  BudgetExceededError,
  CostTracker,
  Orchestrator,
  SpendTracker,
  type BudgetExceeded,
  type CostStats,
  type ExecuteOptions,
  type OrchestratorOptions,
  type SpendStatus,
  type StreamingClient,
} from './orchestrator.js';
export {
  SafetyManager,
  type ApprovalRequest,
  type ApprovalStatus,
  type GatedOperation,
} from './safety.js';
export {
  HealthChecker,
  type HealthOptions,
  type HealthResult,
  type HealthStatus,
} from './health.js';
export { defaultConfig } from './defaults.js';

export const VERSION = '0.3.0';