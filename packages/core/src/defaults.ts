import type { GearVaneConfig } from './types.js';

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
export function defaultConfig(env: Record<string, string | undefined> = {}): GearVaneConfig {
  const hasAnthropic = Boolean(env['ANTHROPIC_API_KEY']);
  const hasOpenRouter = Boolean(env['OPENROUTER_API_KEY']);
  const hasMeta = Boolean(env['MODEL_API_KEY']);

  return {
    tiers: {
      local: {
        name: 'local',
        description: 'Local models for simple tasks',
        // Every server speaks an OpenAI-compatible API except Ollama, which
        // has its own client. Model IDs are exemplars of what to pull, not
        // an inventory: the router takes the first healthy provider's first
        // model, and `health` reports the rest as unknown until probed.
        // Nothing here needs an API key.
        providers: [
          {
            // The model bundled with the desktop app: nothing to install,
            // served by the app itself on loopback. First, so a fresh
            // install works before any server is set up.
            name: 'embedded',
            baseUrl: 'http://127.0.0.1:11439',
            models: ['qwen2.5-coder-0.5b-instruct-q4_0'],
          },
          {
            name: 'ollama',
            baseUrl: 'http://localhost:11434',
            models: [
              'qwen2.5-coder',
              'qwen3',
              'codellama',
              'deepseek-coder-v2',
              'starcoder2',
              'codestral',
              'llama3.3',
              'gemma3',
              'phi3',
              'mistral',
            ],
          },
          {
            name: 'lm_studio',
            baseUrl: 'http://localhost:1234',
            models: ['qwen2.5-coder-7b'],
          },
          {
            // Serves the single model passed with -m; use its file name
            // here. Shares 8080 with LocalAI below, so only one runs at a
            // time; the router takes whichever answers.
            name: 'llama_cpp',
            baseUrl: 'http://localhost:8080',
            models: ['qwen2.5-coder-7b-instruct-q4_k_m'],
          },
          {
            // Serves Hugging Face IDs given to --model.
            name: 'vllm',
            baseUrl: 'http://localhost:8000',
            models: ['Qwen/Qwen2.5-Coder-7B-Instruct'],
          },
          {
            // Serves any GGUF it hosts; models are whatever is installed.
            name: 'localai',
            baseUrl: 'http://localhost:8080',
            models: ['qwen3-4b'],
          },
          {
            name: 'gpt4all',
            baseUrl: 'http://localhost:4891',
            models: ['Meta-Llama-3-8B-Instruct'],
          },
          {
            // oobabooga's text-generation-webui with the OpenAI extension
            // (5001 on newer versions). The model is the loaded character's
            // directory name.
            name: 'textgen',
            baseUrl: 'http://localhost:5000',
            models: ['qwen2.5-coder-7b-instruct'],
          },
        ],
        maxRetries: 2,
        costPerToken: 0,
      },
      mid: {
        name: 'mid',
        description: 'Mid-tier models for medium complexity',
        providers: [
          ...(hasOpenRouter
            ? [
                {
                  name: 'openrouter',
                  apiKeyEnv: 'OPENROUTER_API_KEY',
                  models: ['anthropic/claude-haiku-4-5', 'google/gemini-2.5-flash'],
                },
              ]
            : []),
          ...(hasMeta
            ? [
                {
                  name: 'meta',
                  apiKeyEnv: 'MODEL_API_KEY',
                  models: ['muse-spark-1.3'],
                },
              ]
            : []),
        ],
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
                models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
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
      file: 'gearvane.log',
      logRoutingDecisions: true,
      logEscalations: true,
      logCosts: true,
      feedbackFile: 'feedback.jsonl',
    },
  };
}