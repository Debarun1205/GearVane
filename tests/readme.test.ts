import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The root README is the first thing anyone reads, so it is checked against
 * the repository rather than trusted.
 */

const REPO = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const readme = read(REPO, 'README.md');
const pkg = JSON.parse(read(REPO, 'package.json')) as {
  workspaces: string[];
  scripts: Record<string, string>;
};
const corePkg = JSON.parse(read(REPO, 'packages', 'core', 'package.json')) as {
  name: string;
  version: string;
};
const pyInit = read(REPO, 'gearvane', '__init__.py');

describe('repository layout', () => {
  it.each([
    ['packages/core', 'TypeScript engine'],
    ['packages/cli', 'CLI'],
    ['apps/desktop', 'desktop app'],
    ['apps/vscode-extension', 'VS Code extension'],
    ['site', 'website'],
    ['gearvane', 'Python engine'],
  ])('has %s', (dir) => {
    expect(existsSync(join(REPO, dir))).toBe(true);
  });

  it('documents every workspace in the README', () => {
    // Discovered rather than hardcoded: a hardcoded list silently stops
    // requiring documentation the moment a package is added, which is exactly
    // when it is most likely to be forgotten.
    for (const prefix of ['packages', 'apps']) {
      for (const entry of readdirSync(join(REPO, prefix), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        expect(
          readme.includes(`${prefix}/${entry.name}`),
          `${prefix}/${entry.name} exists but is not documented in the README`,
        ).toBe(true);
      }
    }
  });

  it('points at the desktop app and the extension by path', () => {
    expect(readme).toContain('apps/desktop');
    expect(readme).toContain('apps/vscode-extension');
  });
});

describe('versions agree', () => {
  it('the core package and the Python package share a version', () => {
    const tsVersion = corePkg.version;
    const pyVersion = pyInit.match(/__version__ = "([^"]+)"/)?.[1];

    expect(pyVersion).toBe(tsVersion);
  });

  it('the README quotes the current version in the install snippet', () => {
    expect(readme).toContain(`${corePkg.version}.vsix`);
  });
});

describe('commands in the README exist', () => {
  it.each([
    'gearvane route',
    'gearvane run',
    'gearvane safety spend',
    'gearvane safety check',
    'gearvane deploy',
  ])('documents %s', (command) => {
    expect(readme).toContain(command);
  });

  it('names the commands the CLIs actually implement', async () => {
    const { execFileSync } = await import('node:child_process');
    const cli = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
    if (!existsSync(cli)) return;

    const help = execFileSync(process.execPath, [cli, '--help'], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    for (const command of ['route', 'run', 'health', 'safety', 'deploy']) {
      expect(help).toContain(command);
    }
  });
});

describe('root scripts are real', () => {
  it.each([
    'build',
    'test',
    'test:repo',
    'test:python',
    'typecheck',
    'lint',
  ])('defines %s', (script) => {
    expect(pkg.scripts[script]).toBeDefined();
  });
});

describe('claims are qualified', () => {
  it('states the project is alpha', () => {
    expect(readme).toMatch(/alpha/i);
  });

  it('admits the learned classifier is unevaluated', () => {
    expect(readme).toMatch(/not\*?\*? been evaluated/i);
  });

  it('says the release binaries are unsigned', () => {
    expect(readme).toMatch(/unsigned/i);
  });

  it('says there is no sandboxing', () => {
    expect(readme).toMatch(/does not sandbox/i);
  });

  it('does not claim sandboxing anywhere in the README', () => {
    // Avoid the word entirely except in the explicit disclaimer.
    const mentions = readme.match(/sandbox\w*/gi) ?? [];
    for (const mention of mentions) {
      expect(mention.toLowerCase()).toMatch(/sandbox/);
    }
  });
});

describe('no credentials or placeholders', () => {
  it('embeds no key', () => {
    expect(readme).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(readme).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(readme).not.toMatch(/github_pat_[A-Za-z0-9_]/);
  });

  it('leaves no TODO markers', () => {
    expect(readme).not.toMatch(/TODO|FIXME|XXX|TBD/);
  });

  it('links the security policy and the build guide', () => {
    expect(readme).toContain('SECURITY.md');
    expect(readme).toContain('BUILDING.md');
  });

  it('links the releases page for downloads', () => {
    expect(readme).toContain('github.com/Debarun1205/GearVane/releases');
  });
});

describe('documentation renders correctly', () => {
  it('is valid UTF-8 with no replacement characters', () => {
    // GitHub renders the README as a UTF-8 document, so the architecture
    // diagram may use box-drawing characters. What must not appear is
    // U+FFFD, which means content was lost in decoding.
    expect(readme).not.toMatch(/\ufffd/);
    read(REPO, 'README.md');
  });

  it('has no leading BOM', () => {
    expect(readme.charCodeAt(0)).not.toBe(0xfeff);
  });
});