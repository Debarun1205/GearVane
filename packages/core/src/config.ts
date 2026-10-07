import { parseYaml, YamlError } from './yaml.js';
import type { GearVaneConfig, CostClass } from './types.js';

/**
 * Loads and validates configuration.
 *
 * The config file is user-authored, so every field is treated as untrusted: a
 * malformed value must produce a clear error rather than a runtime surprise
 * deep inside routing.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TIER_NAMES = ['local', 'mid', 'frontier'] as const;

/**
 * Parse and validate config text.
 *
 * Only the fields the core actually reads are validated. Unknown keys are
 * ignored so a config written for a newer version still loads.
 */
export function parseConfig(
  text: string,
  format: 'yaml' | 'json' = 'yaml',
): GearVaneConfig {
  let raw: unknown;
  if (format === 'json') {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`Invalid JSON: ${(error as Error).message}`);
    }
  } else {
    try {
      raw = parseYaml(text);
    } catch (error) {
      if (error instanceof YamlError) {
        throw new ConfigError(`Invalid YAML: ${error.message}`);
      }
      throw error;
    }
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('Config must be a mapping at the top level');
  }

  const config = raw as Record<string, unknown>;

  const tiers: GearVaneConfig['tiers'] = {
    local: emptyTier(),
    mid: emptyTier(),
    frontier: emptyTier(),
  };

  const rawTiers = (config['tiers'] ?? {}) as Record<string, unknown>;
  for (const name of TIER_NAMES) {
    const entry = rawTiers[name];
    if (!entry || typeof entry !== 'object') continue;
    const tier = entry as Record<string, unknown>;
    tiers[name] = {
      name,
      description: str(tier['description'], ''),
      providers: normaliseProviders(tier['providers']),
      maxRetries: num(tier['max_retries'] ?? tier['maxRetries'], 2),
      costPerToken: num(tier['cost_per_token'] ?? tier['costPerToken'], 0),
      // Cost class: 'free' | 'metered'. Optional -- derived from the tier's
      // providers when omitted, which is what makes a local weight in `mid`
      // free rather than billable.
      costClass: (tier['cost_class'] ?? tier['costClass']) as CostClass | undefined,
    };
  }

  const rawRouter = (config['router'] ?? {}) as Record<string, unknown>;
  const rawEscalation = (rawRouter['escalation'] ?? {}) as Record<string, unknown>;

  const rawSafety = (config['safety'] ?? {}) as Record<string, unknown>;

  const rawProviders = (config['providers'] ?? {}) as Record<string, unknown>;
  // Accept both spellings: this is the only multi-word section name, and a
  // JSON config written in the core's camelCase style would otherwise lose
  // the entire section silently (tiers/router/providers/safety/logging are
  // spelled the same in both styles).
  const rawLearned = (config['learned_classifier'] ??
    config['learnedClassifier'] ?? {}) as Record<string, unknown>;
  const rawLogging = (config['logging'] ?? {}) as Record<string, unknown>;

  const defaultTier = str(rawRouter['default_tier'] ?? rawRouter['defaultTier'], 'mid');
  if (!TIER_NAMES.includes(defaultTier as (typeof TIER_NAMES)[number])) {
    throw new ConfigError(`router.default_tier must be one of ${TIER_NAMES.join(', ')}`);
  }

  return {
    tiers,
    router: {
      defaultTier: defaultTier as (typeof TIER_NAMES)[number],
      escalation: {
        enabled: bool(rawEscalation['enabled'], true),
        maxAttemptsPerTier: num(
          rawEscalation['max_attempts_per_tier'] ?? rawEscalation['maxAttemptsPerTier'],
          2,
        ),
        autoPromoteOnFailure: bool(
          rawEscalation['auto_promote_on_failure'] ?? rawEscalation['autoPromoteOnFailure'],
          true,
        ),
        maxEscalations: num(
          rawEscalation['max_escalations'] ?? rawEscalation['maxEscalations'],
          2,
        ),
      },
      manualOverride: nullableStr(rawRouter['manual_override'] ?? rawRouter['manualOverride']),
      heuristics: normaliseHeuristics(rawRouter['heuristics']),
    },
    providers: {
      timeoutSeconds: num(rawProviders['timeout_seconds'] ?? rawProviders['timeoutSeconds'], 120),
      maxRetries: num(rawProviders['max_retries'] ?? rawProviders['maxRetries'], 2),
      retryBaseDelay: num(
        rawProviders['retry_base_delay'] ?? rawProviders['retryBaseDelay'],
        1,
      ),
      retryMaxDelay: num(
        rawProviders['retry_max_delay'] ?? rawProviders['retryMaxDelay'],
        30,
      ),
    },
    learnedClassifier: {
      enabled: bool(rawLearned['enabled'], false),
      modelFile: str(rawLearned['model_file'] ?? rawLearned['modelFile'], 'learned_model.json'),
      minSamples: num(rawLearned['min_samples'] ?? rawLearned['minSamples'], 10),
      blend: num(rawLearned['blend'], 0.5),
      ...(rawLearned['learning_rate'] !== undefined
        ? { learningRate: num(rawLearned['learning_rate'], 0.5) }
        : {}),
      ...(rawLearned['epochs'] !== undefined ? { epochs: num(rawLearned['epochs'], 50) } : {}),
      // Optional per-model feedback file, mirroring Python's
      // learned_classifier.feedback_file fallback chain.
      ...(((rawLearned['feedback_file'] ?? rawLearned['feedbackFile']) !== undefined)
        ? {
            feedbackFile: str(
              rawLearned['feedback_file'] ?? rawLearned['feedbackFile'],
              'feedback.jsonl',
            ),
          }
        : {}),
    },
    safety: {
      requireApproval: strArray(rawSafety['require_approval'] ?? rawSafety['requireApproval']),
      sandboxAllowed: strArray(
        rawSafety['sandbox_allowed'] ?? rawSafety['sandboxAllowed'],
      ),
      blockedCommands: strArray(
        rawSafety['blocked_commands'] ?? rawSafety['blockedCommands'],
      ),
    },
    logging: {
      enabled: bool(rawLogging['enabled'], true),
      level: str(rawLogging['level'], 'INFO'),
      file: str(rawLogging['file'], 'gearvane.log'),
      logRoutingDecisions: bool(
        rawLogging['log_routing_decisions'] ?? rawLogging['logRoutingDecisions'],
        true,
      ),
      logEscalations: bool(
        rawLogging['log_escalations'] ?? rawLogging['logEscalations'],
        true,
      ),
      logCosts: bool(rawLogging['log_costs'] ?? rawLogging['logCosts'], true),
      feedbackFile: str(rawLogging['feedback_file'] ?? rawLogging['feedbackFile'], 'feedback.jsonl'),
    },
  };
}

function normaliseProviders(value: unknown): GearVaneConfig['tiers']['local']['providers'] {
  if (!Array.isArray(value)) return [];
  const providers: GearVaneConfig['tiers']['local']['providers'] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = str(record['name'], '');
    if (!name) continue;

    const provider: GearVaneConfig['tiers']['local']['providers'][number] = {
      name,
      models: strArray(record['models']),
    };

    const baseUrl = nullableStr(record['base_url'] ?? record['baseUrl']);
    if (baseUrl) provider.baseUrl = baseUrl;

    const apiKeyEnv = nullableStr(record['api_key_env'] ?? record['apiKeyEnv']);
    if (apiKeyEnv) provider.apiKeyEnv = apiKeyEnv;

    const completionsPath = nullableStr(record['completions_path'] ?? record['completionsPath']);
    if (completionsPath) provider.completionsPath = completionsPath;

    const modelsPath = nullableStr(record['models_path'] ?? record['modelsPath']);
    if (modelsPath) provider.modelsPath = modelsPath;

    providers.push(provider);
  }

  return providers;
}

function normaliseHeuristics(
  value: unknown,
): GearVaneConfig['router']['heuristics'] {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const out: NonNullable<GearVaneConfig['router']['heuristics']> = {};

  const simple = record['simple_keywords'] ?? record['simpleKeywords'];
  if (simple) out.simpleKeywords = strArray(simple);

  const complex = record['complex_keywords'] ?? record['complexKeywords'];
  if (complex) out.complexKeywords = strArray(complex);

  const patterns = record['complex_file_patterns'] ?? record['complexFilePatterns'];
  if (patterns) out.complexFilePatterns = strArray(patterns);

  const minFiles = record['min_files_for_complex'] ?? record['minFilesForComplex'];
  if (minFiles !== undefined) out.minFilesForComplex = num(minFiles, 3);

  return out;
}

function emptyTier(): GearVaneConfig['tiers']['local'] {
  return { name: 'local', description: '', providers: [], maxRetries: 2, costPerToken: 0 };
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : null;
}

function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export { TIER_NAMES };