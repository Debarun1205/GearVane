import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards on the builder and on the website that no longer has one.
 *
 * Prompt-driven building needs a model call, and a static page has no backend
 * to make one from and no safe place to keep a credential. So the website has
 * no builder: building lives in the CLI, the VS Code panel, and the desktop
 * app and IDE. These tests fail if a builder page reappears without a backend
 * behind it, or if anything erodes the boundaries that remain.
 */

const REPO = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const scaffoldTs = read(REPO, 'packages', 'harness', 'src', 'builder', 'scaffold.ts');
const nodeFsTs = read(
  REPO,
  'packages',
  'harness',
  'src',
  'builder',
  'node-fs.ts',
);
const deployTs = read(REPO, 'packages', 'harness', 'src', 'builder', 'deploy.ts');
const preload = read(REPO, 'apps', 'desktop', 'src', 'preload.cjs');
const siteIndex = read(REPO, 'site', 'index.html');
const siteReadme = read(REPO, 'site', 'README.md');
const siteStyles = read(REPO, 'site', 'assets', 'styles.css');
const deployWorkflow = read(REPO, '.github', 'workflows', 'deploy-site.yml');

/**
 * Source with comments removed.
 *
 * Several guards below check that a module does not reference something, and
 * the modules in question document that exact hazard in their own comments.
 * Matching prose would fail for the wrong reason.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const deployCode = stripComments(deployTs).replace(/\s+/g, ' ');

describe('workspace build order is declared correctly', () => {
  /**
   * The desktop app imports the harness, and TypeScript resolves that through
   * package exports, so the harness's dist must exist first. Three separate CI
   * jobs missed that step before this was checked mechanically.
   */
  it('every build step that needs the harness lists it', () => {
    const harnessImports = read(
      REPO,
      'apps',
      'desktop',
      'src',
      'builder-host.ts',
    );
    expect(harnessImports).toContain("from '@waypoint/harness'");

    // tools/check_workflow_order.py reads the imports from source and asserts
    // each workflow step builds what it needs. It is a tool rather than a test
    // because it reports on YAML, which is not this suite's subject.
    const checker = join(REPO, 'tools', 'check_workflow_order.py');
    expect(existsSync(checker)).toBe(true);

    const source = read(checker);
    // Dependencies are read from source, never hardcoded: a stale map produces
    // false failures that teach people to ignore the checker. The pattern is
    // matched loosely, since asserting on the checker's own regex text would
    // be asserting on trivia.
    expect(source).toContain('@waypoint/');
    expect(source).toMatch(/rglob\(/);
    expect(source).toMatch(/dependencies: dict\[str, set\[str\]\] = \{\}/);
    expect(source).not.toMatch(/^\s*"@waypoint\/\w+":\s*\{/m);
  });
});

describe('the engine keeps its Node boundary explicit', () => {
  /**
   * The scaffold engine once bundled for a browser page, which is why `node:fs`
   * lives behind an injected bridge in its own module instead of an import.
   * The page is gone but the boundary stays: it is what lets any future
   * browser consumer use planning and zipping without tripping over the
   * filesystem, and collapsing it would reintroduce the failure silently.
   */
  it('keeps node: imports out of the scaffold engine', () => {
    expect(scaffoldTs).not.toMatch(/from ['"]node:/);
    expect(scaffoldTs).not.toMatch(/import\(['"]node:/);
  });

  it('keeps node: imports out of the deploy module', () => {
    expect(deployTs).not.toMatch(/from ['"]node:/);
  });

  it('confines node: imports to the dedicated binding module', () => {
    // The one file allowed to touch the filesystem.
    expect(nodeFsTs).toMatch(/from ['"]node:fs\/promises['"]/);
  });

  it('does not import the node binding from the scaffold engine', () => {
    const code = stripComments(scaffoldTs);
    expect(code).not.toMatch(/node-fs/);
  });

  it('declares a separate entry point for the node binding', () => {
    const manifest = JSON.parse(
      read(REPO, 'packages', 'harness', 'package.json'),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toContain('./builder-node-fs');
  });
});

describe('the website has no builder', () => {
  /**
   * Removed because prompting needs a model call and this site cannot make
   * one. A builder page without a model behind it is a form that implies the
   * site builds apps when it cannot. If a backend ever exists, these guards
   * are the list of what has to change with it.
   */
  it('has no builder page or script', () => {
    expect(existsSync(join(REPO, 'site', 'builder.html'))).toBe(false);
    expect(existsSync(join(REPO, 'site', 'assets', 'builder.js'))).toBe(false);
    expect(existsSync(join(REPO, 'site', 'assets', 'builder.bundle.js'))).toBe(false);
  });

  it('links to no builder page', () => {
    expect(siteIndex).not.toContain('builder.html');
    expect(siteIndex).not.toMatch(/Build a site/);
  });

  it('styles no builder page', () => {
    expect(siteStyles).not.toMatch(/\.builder-/);
  });

  it('documents no builder page', () => {
    expect(siteReadme).not.toMatch(/builder\.html/);
    expect(siteReadme).not.toMatch(/assets\/builder\.js/);
  });

  it('says where building actually lives', () => {
    // Removal without a pointer strands the reader who remembers the page.
    expect(siteReadme).toMatch(/desktop app/);
  });

  it('deploys with no build step', () => {
    // The bundling step existed only for the builder page. A workflow that
    // installs dependencies and runs a bundler for a static site is either
    // leftover or about to surprise someone.
    expect(deployWorkflow).not.toContain('npm ci');
    expect(deployWorkflow).not.toContain('esbuild');
    expect(deployWorkflow).not.toContain('build:site');
    expect(deployWorkflow).toMatch(/uploads site\/ as-is/);
  });

  it('defines no site bundling script', () => {
    const scripts = JSON.parse(read(REPO, 'package.json')) as {
      scripts: Record<string, string>;
    };

    expect(scripts.scripts['build:site']).toBeUndefined();
  });
});

describe('the desktop app keeps the filesystem out of the renderer', () => {
  it('exposes the builder over a named bridge', () => {
    expect(preload).toMatch(/builder:/);
    expect(preload).toMatch(/ipcRenderer\.invoke\('builder:write'/);
  });

  it('exposes the agent over a named bridge', () => {
    // The loop needs the harness tool layer, which the renderer cannot load.
    expect(preload).toMatch(/agent:\s*\{/);
    expect(preload).toMatch(/ipcRenderer\.invoke\('agent:run'/);
    expect(preload).toMatch(/ipcRenderer\.send\('agent:cancel'/);
    expect(preload).toMatch(/ipcRenderer\.on\('agent:step'/);
  });

  it('exposes no direct filesystem access', () => {
    // The renderer is sandboxed and cannot read or write files. Anything that
    // hands it a filesystem would undo that.
    expect(preload).not.toMatch(/require\(['"]node:fs/);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*,\s*require\b/);
    expect(preload).not.toMatch(/\bfs\b\s*:/);
  });

  it('still uses contextBridge rather than exposing node', () => {
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld/);
    expect(preload).toMatch(/require\('electron'\)/);
  });
});

describe('the deploy module states its own limits', () => {
  it('says nothing has been published to a real host', () => {
    // The most important sentence in the builder. Both the package entry point
    // and the module itself have to carry it: someone reading either one alone
    // must not come away thinking a hosted deploy works.
    const entry = read(
      REPO,
      'packages',
      'harness',
      'src',
      'builder',
      'index.ts',
    ).replace(/\s+/g, ' ');
    const module_ = deployTs.replace(/\s+/g, ' ');

    expect(entry).toMatch(/Nothing in this package has published to a real host/i);
    expect(module_).toMatch(/Nothing here has been exercised against a real provider/i);
  });

  it('refuses rather than pretending when unconfigured', () => {
    expect(deployCode).toMatch(/not implemented/);
  });

  it('explains why credentials cannot live in a browser', () => {
    expect(deployTs.replace(/\s+/g, ' ')).toMatch(
      /credential in browser JavaScript/i,
    );
    expect(deployTs.replace(/\s+/g, ' ')).toMatch(
      /credential handed to every visitor/i,
    );
  });

  it('never claims a hosted target succeeded', () => {
    // A false positive in this file is the failure mode the whole module
    // exists to prevent: a button that looks like it deployed something.
    expect(deployCode).not.toMatch(/successfully (?:deployed|published)/i);
    expect(deployCode).not.toMatch(/live at https/i);
  });
});
