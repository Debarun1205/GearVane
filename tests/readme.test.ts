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

  it('does not claim escalation is verified by tests', () => {
    // The core pitch of the project is escalation on an external signal. That
    // is not built: the orchestrator retries on a model or provider error. A
    // README that implied otherwise would be the single most damaging claim
    // it could make, so the absence of a test is stated in both the summary
    // and the status list.
    expect(readme).toMatch(/does \*not\* yet run your tests/);
    expect(readme).toMatch(/It does not verify that a\s+result is wrong by running your tests/);
    expect(readme).not.toMatch(/checks the result against your tests/i);
    expect(readme).not.toMatch(/verified escalation/i);
  });

  it('says tier assignment is not measured', () => {
    // The catalog tiers are provisional and size-influenced. Calling frontier
    // a capability ranking over an 8B local weight is the marketing risk the
    // README has to name rather than hide.
    expect(readme).toMatch(/size bands, not a capability ranking/);
    expect(readme).toMatch(/not\s+measured/i);
  });

  it('flags the installer-size blocker instead of hiding it', () => {
    // The release workflow packages every bundled weight, which is over the
    // GitHub per-asset limit. A README that said nothing would let someone
    // cut a release that fails at upload.
    expect(readme).toMatch(/known blocker/i);
    expect(readme).toMatch(/9\.7 GiB/);
    expect(readme).toMatch(/2 GiB per-asset limit/);
  });

  it('explains why the download filenames say Waypoint', () => {
    // v0.3.0 predates the rename, so the published artifacts carry the old
    // product name. Without this the table reads as a mistake.
    expect(readme).toMatch(/filenames say Waypoint/i);
    expect(readme).toMatch(/built before the rename/);
  });

  it('does not quote test counts', () => {
    // A count in prose rots on every commit that adds a test, and a reviewer
    // skimming a diff will not catch a stale number. The README points at CI
    // instead; this asserts it stays that way.
    expect(readme).not.toMatch(/\d{3,} (?:package|repository|Python) tests/);
    expect(readme).toMatch(/CI runs the Python suite/);
  });

  it('does not quote installer sizes it has not verified', () => {
    // The sizes are the published asset sizes, read from the releases API.
    // Pin the three that a reader is most likely to act on.
    expect(readme).toMatch(/`Waypoint\.Setup\.0\.3\.0\.exe` \| 93 MB/);
    expect(readme).toMatch(/`Waypoint-0\.3\.0\.AppImage` \| 123 MB/);
    expect(readme).toMatch(/`app-debug\.apk` \| 5 MB/);
  });
});

describe('generated tables', () => {
  it('are current with the catalog', async () => {
    // The model table and summary are owned by
    // tools/gen-readme-tables.mjs. A hand-edited row would make the README
    // disagree with what the app ships.
    const { execFileSync } = await import('node:child_process');
    expect(() =>
      execFileSync('node', [join(REPO, 'tools', 'gen-readme-tables.mjs'), '--check'], {
        cwd: REPO,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('list every catalog weight exactly once', () => {
    const catalog = JSON.parse(
      read(REPO, 'apps', 'desktop', 'src', 'models.json'),
    ) as Array<{ id: string }>;

    const table = readme.slice(
      readme.indexOf('<!-- BEGIN catalog-table -->'),
      readme.indexOf('<!-- END catalog-table -->'),
    );

    for (const entry of catalog) {
      // Built by concatenation rather than a template literal: the pattern
      // contains backticks, which cannot nest inside one.
      const escaped = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('^\\| `' + escaped + '`', 'gm');
      const rows = table.match(pattern);
      expect(rows, entry.id + ' missing from the README table').toHaveLength(1);
    }
  });

  it('mark the four bundled weights as in the installer', () => {
    const catalog = JSON.parse(
      read(REPO, 'apps', 'desktop', 'src', 'models.json'),
    ) as Array<{ id: string; bundled: boolean }>;
    const bundled = catalog.filter((e) => e.bundled).map((e) => e.id);
    expect(bundled).toHaveLength(4);

    for (const id of bundled) {
      const pattern = new RegExp('^\\| `' + id + '` \\|.*\\|$', 'm');
      const row = readme.match(pattern)?.[0] ?? '';
      expect(row, id + ' not marked bundled').toMatch(/\| yes \|$/);
    }
  });

  it('flag a weight the tiers do not name as on request', () => {
    // 14 of the 50 are downloadable but absent from the shipped tier lists.
    // Labelling them with a tier would describe a classification the app does
    // not perform.
    expect(readme).toMatch(/on request/);
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