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
  const hasDeepSeek = Boolean(env['DEEPSEEK_API_KEY']);
  const hasGemini = Boolean(env['GEMINI_API_KEY']);
  const hasMistral = Boolean(env['MISTRAL_API_KEY']);
  const hasOpenAI = Boolean(env['OPENAI_API_KEY']);
  const hasXai = Boolean(env['XAI_API_KEY']);

  return {
    tiers: {
      local: {
        name: 'local',
        description: 'Local models for simple tasks (tiny/fast models, < 2GB)',
        // Every server speaks an OpenAI-compatible API except Ollama, which
        // has its own client. Model IDs are exemplars of what to pull, not
        // an inventory: the router takes the first healthy provider's first
        // model, and `health` reports the rest as unknown until probed.
        // Nothing here needs an API key.
        providers: [
          {
            // The models bundled with the desktop app, plus anything the
            // Models dialog downloads: nothing to install, served by the
            // app itself on loopback. First, so a fresh install works
            // before any server is set up.
            name: 'embedded',
            baseUrl: 'http://127.0.0.1:11439',
            models: [
              'qwen2.5-coder-0.5b-instruct-q4_0',
              'smollm2-360m-instruct.q4_k_m',
            ],
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
        costClass: 'free',
      },
      mid: {
        name: 'mid',
        description: 'Mid-tier models for medium complexity (2-6GB models)',
        // Hosted providers appear only with their key in the environment
        // (or the app vault), so a fresh install stays local-only while a
        // single pasted key unlocks its models. Eight hosted models total,
        // plus five keyless embedded ones below: mid-tier capability with
        // no keys once downloaded, served by the app itself.
        providers: [
          {
            // Local-first, like the local tier: free and keyless when the
            // weight is on disk, skipped fast when it is not.
            name: 'embedded',
            baseUrl: 'http://127.0.0.1:11439',
            models: [
              'qwen2.5-7b-instruct-q4_k_m',
              'mistral-7b-instruct-v0.3-q4_k_m',
              'deepseek-r1-distill-qwen-7b-q4_k_m',
              'falcon3-7b-instruct-q4_k_m',
              'qwen2.5-coder-7b-instruct-q4_0',
              'falcon3-1b-instruct-q4_k_m',
              'qwen3-1.7b.q4_k_m',
              'starcoder2-7b-q4_k_m',
              'qwen3-4b.q4_k_m',
              'starcoder2-3b-q4_k_m',
              'qwen2.5-1.5b-instruct-q4_0',
              'qwen2.5-coder-1.5b-instruct-q4_0',
              'smollm2-1.7b-instruct.q4_k_m',
              'gemma-2-2b-it-q4_k_m',
              'qwen2.5-coder-3b-instruct-q4_0',
              'qwen2.5-3b-instruct-q4_0',
              'llama-3.2-3b-instruct-q4_k_m',
              'falcon3-3b-instruct-q4_k_m',
              'phi-3-mini-4k-instruct-q4',
            ],
          },
          ...(hasOpenRouter
            ? [
                {
                  name: 'openrouter',
                  apiKeyEnv: 'OPENROUTER_API_KEY',
                  models: [
                    'anthropic/claude-haiku-4-5',
                    'google/gemini-2.5-flash',
                    'openai/gpt-5-mini',
                  ],
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
          ...(hasDeepSeek
            ? [
                {
                  name: 'deepseek',
                  apiKeyEnv: 'DEEPSEEK_API_KEY',
                  models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
                },
              ]
            : []),
          ...(hasGemini
            ? [
                {
                  name: 'gemini',
                  apiKeyEnv: 'GEMINI_API_KEY',
                  models: ['gemini-2.5-flash'],
                },
              ]
            : []),
          ...(hasMistral
            ? [
                {
                  name: 'mistral',
                  apiKeyEnv: 'MISTRAL_API_KEY',
                  models: ['mistral-large-latest'],
                },
              ]
            : []),
        ],
        maxRetries: 2,
        // The rate a run through one of this tier's *keyed* providers would
        // pay. Deriving cost from the tier instead billed the user for running
        // the local weights this same tier holds -- see costClassForProvider.
        costPerToken: 0.0001,
        costClass: 'metered',
      },
      frontier: {
        name: 'frontier',
        description: 'Frontier models for hard tasks (6GB+ models)',
        // Five models total, same key-gating as mid.
        providers: [
          ...(hasAnthropic
            ? [
                {
                  name: 'anthropic',
                  apiKeyEnv: 'ANTHROPIC_API_KEY',
                  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
                },
              ]
            : []),
          ...(hasOpenAI
            ? [
                {
                  name: 'openai',
                  apiKeyEnv: 'OPENAI_API_KEY',
                  models: ['gpt-5'],
                },
              ]
            : []),
          ...(hasXai
            ? [
                {
                  name: 'xai',
                  apiKeyEnv: 'XAI_API_KEY',
                  models: ['grok-4'],
                },
              ]
            : []),
          // Keyless frontier capability, last on purpose: hosted models
          // win when keys exist, and these catch everything otherwise.
          // 6GB+ weights — the dialog says what each needs.
          {
            name: 'embedded',
            baseUrl: 'http://127.0.0.1:11439',
            models: [
              'qwen3-8b.q4_k_m',
              'falcon3-10b-instruct-q4_k_m',
              'mistral-nemo-instruct-2407-q4_k_m',
              'qwen2.5-14b-instruct-q4_k_m',
              'qwen2.5-coder-14b-instruct-q4_k_m',
              'deepseek-r1-distill-qwen-14b-q4_k_m',
              'starcoder2-15b-q4_k_m',
              'phi-4-q4_k',
              'qwen2.5-32b-instruct-q4_k_m',
              'qwen2.5-coder-32b-instruct-q4_k_m',
              'deepseek-r1-distill-qwen-32b-q4_k_m',
              'mixtral-8x7b-instruct-q4_k_m',
              'yi-1.5-34b-chat-q4_k_m',
              'nemotron-3-ultra-q4_k_m',
              'deepseek-r1-q4_k_m',
            ],
          },
        ],
        maxRetries: 3,
        // The rate through a keyed provider in this tier. The tier also holds
        // the largest local weights, and those runs cost nothing: the class is
        // derived per provider, not from being called 'frontier'.
        costPerToken: 0.005,
        costClass: 'metered',
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
        // A nested interpreter re-parses its argument, so the gate sees a
        // different string than the shell executes. Always consequential.
        'shell_injection',
      ],
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