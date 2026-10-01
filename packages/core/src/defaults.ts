import type { WaypointConfig } from './types.js';

/**
 * Built-in default configuration.
 *
 * Mirrors the shape of config.example.yaml so the core is usable with no
 * config file at all. Costs are estimates; local models are free, hosted
 * models are not.
 */

/**
 * @param env Used only to detect which keys are present, never to embed them.
 */
export function defaultConfig(env: Record<string, string | undefined> = {}): WaypointConfig {
  const hasAnthropic = Boolean(env['ANTHROPIC_API_KEY']);
  const hasOpenRouter = Boolean(env['OPENROUTER_API_KEY']);

  return {
    tiers: {
      local: {
        name: 'local',
        description: 'Local models for simple tasks',
        providers: [
          {
            name: 'ollama',
            baseUrl: 'http://localhost:11434',
            models: ['qwen2.5-coder', 'llama3.2', 'deepseek-coder-v2'],
          },
        ],
        maxRetries: 2,
        costPerToken: 0,
      },
      mid: {
        name: 'mid',
        description: 'Mid-tier models for medium complexity',
        providers: hasOpenRouter
          ? [
              {
                name: 'openrouter',
                apiKeyEnv: 'OPENROUTER_API_KEY',
                models: ['anthropic/claude-3-haiku', 'google/gemini-flash'],
              },
            ]
          : [],
        maxRetries: 2,
        costPerToken: 0.0001,
      },
      frontier: {
        name: 'frontier',
        description: 'Frontier models for hard tasks',
        providers: hasAnthropic
          ? [
              {
                name: 'anthropic',
                apiKeyEnv: 'ANTHROPIC_API_KEY',
                models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
              },
            ]
          : [],
        maxRetries: 3,
        costPerToken: 0.005,
      },
    },
    router: {
      defaultTier: 'local',
      escalation: {
        enabled: true,
        maxAttemptsPerTier: 2,
        autoPromoteOnFailure: true,
        maxEscalations: 2,
      },
      manualOverride: null,
      heuristics: {
        simpleKeywords: [
          'typo',
          'spelling',
          'whitespace',
          'formatting',
          'lint',
          'rename',
          'comment',
          'readme',
          'documentation',
          'boilerplate',
          'template',
          'simple',
          'small',
          'fix',
        ],
        complexKeywords: [
          'architecture',
          'refactor',
          'optimize',
          'performance',
          'bottleneck',
          'security',
          'concurrency',
          'race condition',
          'deadlock',
          'memory leak',
          'distributed',
          'migration',
          'redesign',
          'scale',
          'debug',
          'investigate',
          'complex',
        ],
        complexFilePatterns: [
          '*.rs',
          '*.go',
          '*_test.*',
          'src/core/*',
          'src/engine/*',
        ],
        minFilesForComplex: 3,
      },
    },
    providers: {
      timeoutSeconds: 120,
      maxRetries: 2,
      retryBaseDelay: 1,
      retryMaxDelay: 30,
    },
    learnedClassifier: {
      enabled: false,
      modelFile: 'learned_model.json',
      minSamples: 10,
      blend: 0.5,
      learningRate: 0.5,
      epochs: 50,
    },
    safety: {
      requireApproval: [
        'git_push',
        'git_force_push',
        'deploy_production',
        'merge_pr',
        'delete_branch',
      ],
      spendLimits: {
        perSession: 10,
        perDay: 50,
        perTask: 5,
      },
      sandboxAllowed: ['git status', 'git log', 'git diff', 'ls', 'cat', 'pytest'],
      blockedCommands: ['rm -rf', 'sudo', 'chmod 777', 'dd if='],
    },
    logging: {
      enabled: true,
      level: 'INFO',
      file: 'waypoint.log',
      logRoutingDecisions: true,
      logEscalations: true,
      logCosts: true,
      feedbackFile: 'feedback.jsonl',
    },
  };
}