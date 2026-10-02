import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards on the builder's two surfaces.
 *
 * The website and the desktop app share one engine, and the split between them
 * is a security boundary: the website runs in a browser and therefore cannot
 * hold a credential. These tests fail if anything erodes that.
 */

const REPO = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const builderHtml = read(REPO, 'site', 'builder.html');
const builderJs = read(REPO, 'site', 'assets', 'builder.js');
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

const siteProse = builderHtml.replace(/\s+/g, ' ');

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

describe('the browser bundle cannot pull in Node', () => {
  /**
   * esbuild resolves `node:fs` at bundle time even behind a dynamic import, so
   * a single reference anywhere in the browser-reachable graph fails the site
   * build. The Node binding therefore has to live in its own file that nothing
   * the website imports reaches.
   */
  it('keeps node: imports out of the scaffold engine', () => {
    expect(scaffoldTs).not.toMatch(/from ['"]node:/);
    expect(scaffoldTs).not.toMatch(/import\(['"]node:/);
  });

  it('keeps node: imports out of the builder page script', () => {
    expect(builderJs).not.toMatch(/from ['"]node:/);
    expect(builderJs).not.toMatch(/import\(['"]node:/);
  });

  it('keeps node: imports out of the deploy module', () => {
    expect(deployTs).not.toMatch(/from ['"]node:/);
  });

  it('confines node: imports to the dedicated binding module', () => {
    // The one file allowed to touch the filesystem.
    expect(nodeFsTs).toMatch(/from ['"]node:fs\/promises['"]/);
  });

  it('does not import the node binding from the scaffold engine', () => {
    // This is the specific edge that broke the site build: a dynamic import
    // inside scaffold.ts of a module that itself imports node:fs.
    //
    // Comments are stripped first, because the module's own documentation
    // discusses this exact hazard by name. Matching the prose would fail for
    // the wrong reason and train the reader to ignore the test.
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

describe('the website builder does not offer to publish', () => {
  /**
   * The page has no backend and cannot hold a credential safely, so it must not
   * imply that it can deploy. A publish button here would either ship a token
   * to every visitor or lie about having deployed.
   */
  it('has no publish control', () => {
    expect(builderHtml).not.toMatch(/id=["']publish["']/);
    expect(builderJs).not.toMatch(/publish/i);
  });

  it('offers a download instead', () => {
    expect(builderHtml).toMatch(/id="download"/);
    expect(builderJs).toMatch(/createZip/);
  });

  it('explains why publishing is absent', () => {
    // Silence would read as an oversight. Saying it out loud is the difference
    // between a documented limitation and a missing feature.
    expect(siteProse).toMatch(/credential/i);
    expect(siteProse).toMatch(/no backend/i);
  });

  it('makes no network call', () => {
    expect(builderJs).not.toMatch(/\bfetch\s*\(/);
    expect(builderJs).not.toMatch(/XMLHttpRequest/);
    expect(builderJs).not.toMatch(/navigator\.sendBeacon/);
  });

  it('previews in a fully sandboxed frame', () => {
    // The generated HTML is untrusted output as far as the page is concerned,
    // even though the page produced it. An empty sandbox attribute means no
    // scripts, no forms, no same-origin access.
    expect(builderHtml).toMatch(/id="preview-frame"[\s\S]*?sandbox=""/);
  });
});

describe('the desktop app keeps the filesystem out of the renderer', () => {
  it('exposes the builder over a named bridge', () => {
    expect(preload).toMatch(/builder:/);
    expect(preload).toMatch(/ipcRenderer\.invoke\('builder:write'/);
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

describe('the builder page is reachable', () => {
  it('exists', () => {
    expect(existsSync(join(REPO, 'site', 'builder.html'))).toBe(true);
    expect(existsSync(join(REPO, 'site', 'assets', 'builder.js'))).toBe(true);
  });

  it('is linked from the marketing page', () => {
    const index = read(REPO, 'site', 'index.html');
    expect(index).toContain('./builder.html');
  });

  it('is linked from the site header', () => {
    expect(builderHtml).toContain('./index.html');
  });

  it('references the bundle, not the source', () => {
    // The source imports from packages/, which is not published. Only the
    // bundle is served.
    expect(builderHtml).toContain('./assets/builder.bundle.js');
  });

  it('has a canonical URL this project actually serves', () => {
    const canonical = builderHtml.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
    expect(canonical).toBeDefined();
    expect(canonical).not.toMatch(/waypoint\.dev/);
    expect(canonical).toMatch(/debarun1205\.github\.io\/Waypoint\/builder\.html/);
  });
});