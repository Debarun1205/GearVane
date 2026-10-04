import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config-loader.js';

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), 'gearvane-cli-'));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe('loadConfig', () => {
  it('loads an explicit path', () => {
    const path = join(workspace, 'custom.yaml');
    writeFileSync(path, 'router:\n  default_tier: frontier\n');

    const result = loadConfig(path);
    expect(result.config.router.defaultTier).toBe('frontier');
    expect(result.path).toBe(path);
  });

  it('finds a config in the working directory', () => {
    writeFileSync(join(workspace, 'gearvane.yaml'), 'router:\n  default_tier: local\n');
    const result = loadConfig();
    expect(result.config.router.defaultTier).toBe('local');
  });

  it('finds a config in an ancestor directory', () => {
    writeFileSync(join(workspace, 'gearvane.yaml'), 'router:\n  default_tier: local\n');
    const nested = join(workspace, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    const result = loadConfig();
    expect(result.config.router.defaultTier).toBe('local');
  });

  it('parses JSON configs', () => {
    const path = join(workspace, 'gearvane.config.json');
    writeFileSync(path, JSON.stringify({ router: { default_tier: 'frontier' } }));
    const result = loadConfig(path);
    expect(result.config.router.defaultTier).toBe('frontier');
  });

  it('falls back to built-in defaults when nothing is found', () => {
    // A fresh install must run with no setup.
    const result = loadConfig();
    expect(result.path).toBeNull();
    expect(result.note).toMatch(/built-in defaults/);
    expect(result.config.tiers.local).toBeDefined();
    expect(result.config.tiers.frontier).toBeDefined();
  });

  it('treats an empty file as valid', () => {
    const path = join(workspace, 'empty.yaml');
    writeFileSync(path, '\n\n');
    const result = loadConfig(path);
    expect(result.config.tiers.local).toBeDefined();
  });

  it('throws for a missing explicit path', () => {
    expect(() => loadConfig(join(workspace, 'nope.yaml'))).toThrow(/not found/);
  });

  it('reports which file failed and why', () => {
    const path = join(workspace, 'broken.yaml');
    writeFileSync(path, 'router:\n  default_tier: enormous\n');
    expect(() => loadConfig(path)).toThrow(/default_tier/);
  });

  it('never returns a config carrying a credential', () => {
    const path = join(workspace, 'gearvane.yaml');
    writeFileSync(
      path,
      [
        'tiers:',
        '  frontier:',
        '    providers:',
        '      - name: anthropic',
        '        api_key_env: ANTHROPIC_API_KEY',
        '        models:',
        '          - claude',
      ].join('\n'),
    );

    const provider = loadConfig(path).config.tiers.frontier?.providers[0] as Record<
      string,
      unknown
    >;
    expect(provider['apiKeyEnv']).toBe('ANTHROPIC_API_KEY');
    expect(provider['apiKey']).toBeUndefined();
  });
});