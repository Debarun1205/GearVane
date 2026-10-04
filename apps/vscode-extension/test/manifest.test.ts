import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const EXTENSION_ROOT = join(import.meta.dirname, '..');
const REPO_ROOT = join(EXTENSION_ROOT, '..', '..');

const manifest = JSON.parse(
  readFileSync(join(EXTENSION_ROOT, 'package.json'), 'utf8'),
) as {
  name: string;
  main: string;
  engines: Record<string, string>;
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    configuration: { properties: Record<string, { type: string; default?: unknown }> };
    views: Record<string, unknown[]>;
  };
  scripts: Record<string, string>;
};

describe('extension manifest', () => {
  it('declares an entry point that the build produces', () => {
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.scripts['build']).toContain('tsc');
  });

  it('targets a VS Code version that exists', () => {
    expect(manifest.engines['vscode']).toMatch(/^\^1\.\d+\.\d+$/);
  });

  it('requires Node 20 or newer', () => {
    expect(manifest.engines['node']).toBe('>=20');
  });
});

describe('contributed commands', () => {
  const commands = manifest.contributes.commands.map((entry) => entry.command);

  it('declares the routing commands', () => {
    expect(commands).toContain('gearvane.routeSelection');
    expect(commands).toContain('gearvane.explainSelection');
    expect(commands).toContain('gearvane.ask');
  });

  it('declares the diagnostic commands', () => {
    expect(commands).toContain('gearvane.health');
    expect(commands).toContain('gearvane.spend');
    expect(commands).toContain('gearvane.showLog');
  });

  it('declares the model pinning commands', () => {
    expect(commands).toContain('gearvane.pinModel');
    expect(commands).toContain('gearvane.clearPin');
  });

  it('gives every command a title and category', () => {
    for (const entry of manifest.contributes.commands) {
      expect(entry.title).toBeTruthy();
      expect(entry.category).toBe('GearVane');
    }
  });

  it('uses the gearvane namespace consistently', () => {
    for (const command of commands) {
      expect(command.startsWith('gearvane.')).toBe(true);
    }
  });
});

describe('contributed settings', () => {
  const properties = manifest.contributes.configuration.properties;

  it('declares the routing settings the README documents', () => {
    expect(properties['gearvane.configPath']).toBeDefined();
    expect(properties['gearvane.tier']).toBeDefined();
    expect(properties['gearvane.model']).toBeDefined();
  });

  it('offers auto plus the three tiers', () => {
    const values = (properties['gearvane.tier'] as { enum?: string[] }).enum ?? [];
    expect(values).toEqual(['auto', 'local', 'mid', 'frontier']);
  });

  it('defaults the tier to auto so classification is the default', () => {
    expect(properties['gearvane.tier']?.default).toBe('auto');
  });

  it('defaults the model pin to empty', () => {
    expect(properties['gearvane.model']?.default).toBe('');
  });

  it('declares a view', () => {
    expect(manifest.contributes.views['explorer']).toBeDefined();
  });
});

describe('extension source', () => {
  const source = readFileSync(join(EXTENSION_ROOT, 'src', 'extension.ts'), 'utf8');

  it('exports activate and deactivate', () => {
    expect(source).toMatch(/export function activate\(/);
    expect(source).toMatch(/export function deactivate\(/);
  });

  it('registers every declared command', () => {
    for (const entry of manifest.contributes.commands) {
      expect(source).toContain(entry.command);
    }
  });

  it('reads keys from the environment, never from config', () => {
    expect(source).toMatch(/env: process\.env/);
  });

  it('never embeds a credential literal', () => {
    expect(source).not.toMatch(/sk-ant-/);
    expect(source).not.toMatch(/ghp_/);
    expect(source).not.toMatch(/github_pat_/);
  });

  it('catches errors so commands do not reject unhandled', () => {
    // An unhandled rejection in the extension host surfaces as a crash, so
    // command dispatch must funnel failures through a catch block that
    // reports rather than rethrows.
    expect(source).toMatch(/catch \(error\)/);
    expect(source).toMatch(/showErrorMessage/);
  });

  it('reads config asynchronously', () => {
    // vscode.workspace.fs has no sync API; a sync read would not compile.
    expect(source).toMatch(/await vscode\.workspace\.fs\.readFile/);
    expect(source).not.toMatch(/fs\.readFileSync/);
  });
});

describe('no placeholder files', () => {
  it('has a README for the marketplace listing', () => {
    const readme = join(EXTENSION_ROOT, 'README.md');
    expect(readFileSync(readme, 'utf8').length).toBeGreaterThan(200);
  });

  it('leaves no TODO markers in source', () => {
    const files = ['extension.ts', 'session.ts'];
    for (const file of files) {
      const text = readFileSync(join(EXTENSION_ROOT, 'src', file), 'utf8');
      expect(text).not.toMatch(/TODO|FIXME|XXX/);
    }
  });
});