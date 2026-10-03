import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '../src/config.js';
import { parseYaml, YamlError } from '../src/yaml.js';

describe('parseYaml', () => {
  it('parses a flat mapping', () => {
    expect(parseYaml('a: 1\nb: two\nc: true\n')).toEqual({ a: 1, b: 'two', c: true });
  });

  it('parses nested mappings', () => {
    const result = parseYaml([
      'router:',
      '  default_tier: mid',
      '  escalation:',
      '    enabled: true',
      '    max_attempts_per_tier: 3',
    ].join('\n')) as Record<string, Record<string, Record<string, unknown>>>;

    expect(result['router']?.['default_tier']).toBe('mid');
    expect(result['router']?.['escalation']?.['enabled']).toBe(true);
    expect(result['router']?.['escalation']?.['max_attempts_per_tier']).toBe(3);
  });

  it('parses a block sequence of scalars', () => {
    const result = parseYaml([
      'keywords:',
      '  - typo',
      '  - refactor',
      '  - "*.rs"',
    ].join('\n')) as Record<string, string[]>;
    expect(result['keywords']).toEqual(['typo', 'refactor', '*.rs']);
  });

  it('parses a sequence of mappings', () => {
    const result = parseYaml([
      'providers:',
      '  - name: ollama',
      '    models:',
      '      - llama3.2',
      '      - qwen',
      '    base_url: http://localhost:11434',
      '  - name: anthropic',
      '    models:',
      '      - claude',
    ].join('\n')) as Record<string, Array<Record<string, unknown>>>;

    expect(result['providers']).toHaveLength(2);
    expect(result['providers']?.[0]?.['name']).toBe('ollama');
    expect(result['providers']?.[0]?.['models']).toEqual(['llama3.2', 'qwen']);
    expect(result['providers']?.[0]?.['base_url']).toBe('http://localhost:11434');
    expect(result['providers']?.[1]?.['name']).toBe('anthropic');
  });

  it('parses an inline sequence', () => {
    const result = parseYaml('tags: [a, b, c]') as Record<string, string[]>;
    expect(result['tags']).toEqual(['a', 'b', 'c']);
  });

  it('strips comments outside quotes', () => {
    const result = parseYaml([
      '# leading comment',
      'a: 1 # trailing comment',
      'b: "has # hash"',
    ].join('\n')) as Record<string, unknown>;
    expect(result['a']).toBe(1);
    expect(result['b']).toBe('has # hash');
  });

  it('keeps colons inside quoted values', () => {
    const result = parseYaml('url: "http://localhost:11434"') as Record<string, string>;
    expect(result['url']).toBe('http://localhost:11434');
  });

  it('returns an empty object for blank input', () => {
    expect(parseYaml('')).toEqual({});
    expect(parseYaml('\n\n  \n')).toEqual({});
  });

  it('parses null and floats', () => {
    const result = parseYaml('a: null\nb: ~\nc: 0.5\nd: -3') as Record<string, unknown>;
    expect(result['a']).toBeNull();
    expect(result['b']).toBeNull();
    expect(result['c']).toBeCloseTo(0.5);
    expect(result['d']).toBe(-3);
  });

  it('rejects tab indentation', () => {
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(YamlError);
  });

  it('rejects anchors rather than mis-parsing them', () => {
    expect(() => parseYaml('a: &anchor')).toThrow(/Anchors/);
  });

  it('rejects block scalars rather than mis-parsing them', () => {
    expect(() => parseYaml('a: |')).toThrow(/Block scalars/);
  });

  it('rejects a second document', () => {
    expect(() => parseYaml('a: 1\n---\nb: 2')).toThrow(/Multiple YAML documents/);
  });

  it('raises a useful error for a malformed line', () => {
    expect(() => parseYaml('a: 1\nthis is not a mapping entry')).toThrow(
      /Expected "key: value"/,
    );
  });
});

describe('parseConfig', () => {
  const sample = [
    'router:',
    '  default_tier: frontier',
    '  manual_override: null',
    'tiers:',
    '  local:',
    '    description: "Local models"',
    '    cost_per_token: 0.0',
    '    providers:',
    '      - name: ollama',
    '        base_url: http://localhost:11434',
    '        models:',
    '          - qwen2.5-coder',
    '  frontier:',
    '    cost_per_token: 0.005',
    '    providers:',
    '      - name: anthropic',
    '        api_key_env: ANTHROPIC_API_KEY',
    '        models:',
    '          - claude-sonnet-4-20250514',
    'safety:',
    '  require_approval:',
    '    - git_push',
    '    - deploy_production',
    '  spend_limits:',
    '    per_task: 2.5',
    '    per_session: 12.0',
    '    per_day: 60.0',
    '  blocked_commands:',
    '    - "rm -rf"',
  ].join('\n');

  it('reads tiers and providers', () => {
    const config = parseConfig(sample);
    expect(config.tiers.local?.providers[0]?.name).toBe('ollama');
    expect(config.tiers.local?.providers[0]?.baseUrl).toBe('http://localhost:11434');
    expect(config.tiers.local?.providers[0]?.models).toEqual(['qwen2.5-coder']);
    expect(config.tiers.frontier?.costPerToken).toBeCloseTo(0.005);
  });

  it('reads api_key_env but never a key value', () => {
    const config = parseConfig(sample);
    const provider = config.tiers.frontier?.providers[0] as Record<string, unknown>;
    expect(provider['apiKeyEnv']).toBe('ANTHROPIC_API_KEY');
    expect(provider['apiKey']).toBeUndefined();
  });

  it('reads endpoint path overrides', () => {
    const config = parseConfig(
      [
        'tiers:',
        '  frontier:',
        '    cost_per_token: 0.005',
        '    providers:',
        '      - name: gemini',
        '        api_key_env: GEMINI_API_KEY',
        '        completions_path: /chat/completions',
        '        models_path: /models',
        '        models:',
        '          - gemini-2.5-flash',
      ].join('\n'),
    );
    const provider = config.tiers.frontier?.providers[0];
    expect(provider?.completionsPath).toBe('/chat/completions');
    expect(provider?.modelsPath).toBe('/models');
  });

  it('leaves endpoint paths unset when absent', () => {
    const config = parseConfig(sample);
    const provider = config.tiers.local?.providers[0];
    expect(provider?.completionsPath).toBeUndefined();
    expect(provider?.modelsPath).toBeUndefined();
  });

  it('reads router settings', () => {
    const config = parseConfig(sample);
    expect(config.router.defaultTier).toBe('frontier');
    expect(config.router.manualOverride).toBeNull();
  });

  it('reads safety limits', () => {
    const config = parseConfig(sample);
    expect(config.safety.spendLimits.perTask).toBeCloseTo(2.5);
    expect(config.safety.spendLimits.perSession).toBeCloseTo(12);
    expect(config.safety.spendLimits.perDay).toBeCloseTo(60);
    expect(config.safety.requireApproval).toEqual(['git_push', 'deploy_production']);
    expect(config.safety.blockedCommands).toEqual(['rm -rf']);
  });

  it('supplies defaults for missing sections', () => {
    const config = parseConfig('router:\n  default_tier: local\n');
    expect(config.router.defaultTier).toBe('local');
    expect(config.router.escalation.maxAttemptsPerTier).toBe(2);
    expect(config.safety.spendLimits.perTask).toBeCloseTo(5);
    expect(config.providers.timeoutSeconds).toBeCloseTo(120);
  });

  it('accepts a tier with no providers', () => {
    const config = parseConfig('tiers:\n  mid:\n    providers: []\n');
    expect(config.tiers.mid?.providers).toEqual([]);
  });

  it('rejects a non-mapping document', () => {
    expect(() => parseConfig('- a\n- b\n')).toThrow(ConfigError);
  });

  it('rejects an invalid default tier', () => {
    expect(() => parseConfig('router:\n  default_tier: enormous\n')).toThrow(
      /default_tier must be one of/,
    );
  });

  it('parses JSON when asked', () => {
    const config = parseConfig(
      JSON.stringify({ router: { default_tier: 'frontier' } }),
      'json',
    );
    expect(config.router.defaultTier).toBe('frontier');
  });

  it('reports invalid JSON clearly', () => {
    expect(() => parseConfig('{oops', 'json')).toThrow(/Invalid JSON/);
  });

  it('wraps YAML errors with context', () => {
    expect(() => parseConfig('a: 1\nbroken line here')).toThrow(/Invalid YAML/);
  });
});