import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP = join(import.meta.dirname, '..');
const REPO = join(APP, '..', '..');
const RENDERER = join(APP, 'renderer');

const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');
const manifest = JSON.parse(read(APP, 'package.json')) as {
  name: string;
  productName: string;
  version: string;
  main: string;
  scripts: Record<string, string>;
  build: Record<string, unknown> & {
    linux: { target: unknown[] };
    win: { target: unknown[] };
    mac: { target: unknown[] };
    files: string[];
    appId: string;
  };
  dependencies: Record<string, string>;
};

describe('desktop manifest', () => {
  it('targets an existing main bundle', () => {
    expect(manifest.main).toBe('dist/main.js');
    expect(manifest.scripts['build:main']).toContain('tsc');
  });

  it('bundles the renderer rather than serving many modules', () => {
    // The same bundle runs in the Electron renderer and the Android webview,
    // so the renderer must be self-contained.
    expect(manifest.scripts['build:renderer']).toContain('--bundle');
  });

  it('declares installers for Windows, Linux, and macOS', () => {
    for (const platform of ['linux', 'win', 'mac'] as const) {
      expect(manifest.build[platform].target.length).toBeGreaterThan(0);
    }
  });

  it('covers both Linux architectures via deb', () => {
    const linux = manifest.build.linux as unknown as {
      target: Array<{ target: string; arch?: string[] }>;
    };

    const deb = linux.target.find((entry) => entry.target === 'deb');
    expect(deb?.arch).toContain('x64');
    expect(deb?.arch).toContain('arm64');
  });

  it('builds the AppImage for x64 only', () => {
    // arm64 AppImages cannot be cross-built reliably on an x64 runner, so
    // they are dropped rather than failing the whole release. deb covers
    // arm64.
    const linux = manifest.build.linux as unknown as {
      target: Array<{ target: string; arch?: string[] }>;
    };

    const appImage = linux.target.find((entry) => entry.target === 'AppImage');
    expect(appImage?.arch).toEqual(['x64']);
  });

  it('includes the renderer in the packaged files', () => {
    expect(manifest.build.files).toContain('renderer/**/*');
  });

  it('bundles the local model beside the app', () => {
    // The embedded tier's whole point is zero setup: the GGUF travels
    // inside the installer via extraResources, fetched at build time
    // rather than committed to git.
    const extra = (manifest.build.extraResources ?? []) as Array<{ from?: string; to?: string }>;
    expect(extra.some((entry) => entry.from === 'resources/models' && entry.to === 'models')).toBe(
      true,
    );
  });

  it('has an app id and a product name', () => {
    expect(manifest.build.appId).toBe('dev.gearvane.app');
    expect(manifest.productName).toBe('GearVane');
  });

  it('depends on the shared packages rather than duplicating them', () => {
    expect(manifest.dependencies['@gearvane/core']).toBeDefined();
    expect(manifest.dependencies['@gearvane/app-core']).toBeDefined();
  });

  it('declares the IDE dependencies instead of relying on hoisting', () => {
    // These were installed with --no-save during development, so they worked
    // locally and failed on every CI runner with 'Cannot find module'. A
    // dependency that is imported must be declared.
    expect(manifest.dependencies['monaco-editor']).toBeDefined();
    expect(manifest.dependencies['@xterm/xterm']).toBeDefined();
    expect(manifest.dependencies['@xterm/addon-fit']).toBeDefined();
  });

  it('keeps node-pty optional with a runtime fallback', () => {
    // node-pty needs a C++ toolchain that CI runners have and many user
    // machines do not. A hard dependency would fail installation where the
    // terminal cannot work anyway; the IDE reports it as unavailable instead.
    expect(manifest.optionalDependencies?.['node-pty']).toBeDefined();
    expect(manifest.dependencies?.['node-pty']).toBeUndefined();
  });
});

describe('main process', () => {
  const source = read(APP, 'src', 'main.ts');

  it('documents the isolation settings for the IDE', () => {
    // The renderer is node-free (the Android webview runs the same bundle),
    // so node integration stays off and contextIsolation stays on: the
    // preload uses contextBridge, which throws when isolation is disabled.
    // That combination kept the bridge out of every build up to v0.3.0,
    // so both the setting and the justification are pinned here.
    expect(source).toMatch(/nodeIntegration: false/);
    expect(source).toMatch(/contextIsolation: true/);
    expect(source).toMatch(/sandbox: false/);
    expect(source).toMatch(/Android webview/);
    expect(source).toMatch(/preload bridge/);
    expect(source).toMatch(/contextBridge/);
  });

  it('declares narrow IPC handlers rather than a generic bridge', () => {
    expect(source).toMatch(/ipcMain\.handle\('app:info'/);
    expect(source).toMatch(/ipcMain\.handle\('config:read'/);
    expect(source).toMatch(/ipcMain\.handle\('shell:open'/);
    expect(source).not.toMatch(/ipcMain\.handle\('fs:/);
    expect(source).not.toMatch(/ipcMain\.handle\('exec/);
  });

  it('only opens http and https links externally', () => {
    expect(source).toMatch(/\^https\?:/);
  });

  it('registers the model download handlers', () => {
    // Downloads land where the embedded server serves, so the dialog and
    // the server cannot disagree about what is installed.
    expect(source).toMatch(/registerModelsHandlers/);
  });  it('falls back to defaults when a config is missing or broken', () => {
    expect(source).toMatch(/defaultConfig/);
    expect(source).toMatch(/error:/);
  });

  it('searches for a config beside the executable when packaged', () => {
    expect(source).toMatch(/process\.resourcesPath/);
    expect(source).toMatch(/app\.getAppPath/);
  });

  it('loads the model catalog with fs, not a JSON import', () => {
    // Regression: models-host imported ./models.json, which tsc compiles
    // to a bare ESM JSON import. esbuild inlines those for the renderer,
    // but Electron's Node rejects them without import attributes, so the
    // main process died before creating a window and every Electron spec
    // failed on firstWindow. Static assets cross into dist/ via fs reads.
    const dir = join(APP, 'src');
    const offenders: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && entry.name !== 'renderer.ts') {
          const text = read(full);
          if (/from\s+['"]\.[^'"]*\.json['"]/.test(text)) offenders.push(full);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});

describe('preload bridge', () => {
  const source = read(APP, 'src', 'preload.cjs');

  it('uses contextBridge rather than exposing ipcRenderer', () => {
    expect(source).toMatch(/contextBridge\.exposeInMainWorld/);
    // Exposing ipcRenderer directly would let the renderer invoke any channel.
    expect(source).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
  });

  it('allowlists channels', () => {
    expect(source).toMatch(/allowed/);
    expect(source).toMatch(/Unsupported channel/);
  });

  it('returns an unsubscribe function', () => {
    expect(source).toMatch(/removeListener/);
  });

  it('exposes the model catalog without arbitrary downloads', () => {
    expect(source).toMatch(/models:\s*\{/);
    expect(source).toMatch(/ipcRenderer\.invoke\('models:list'\)/);
    expect(source).toMatch(/ipcRenderer\.invoke\('models:fetch'/);
    expect(source).toMatch(/ipcRenderer\.on\('models:progress'/);
  });
});

describe('renderer', () => {
  it('does not assume the Electron bridge exists', () => {
    // The same file runs in a plain browser for the Android build.
    const source = read(APP, 'src', 'renderer.ts');
    expect(source).toMatch(/window\.gearvane \?\? \{\}/);
  });

  it('never reads process.env in the renderer', () => {
    // process does not exist there, and keys must come from the host.
    const source = read(APP, 'src', 'renderer.ts');
    expect(source).not.toMatch(/process\.env/);
  });

  it('escapes message text rather than injecting HTML', () => {
    const source = read(APP, 'src', 'renderer.ts');
    expect(source).not.toMatch(/innerHTML/);
    expect(source).toMatch(/textContent/);
  });

  it('sends on Enter and newlines on Shift+Enter', () => {
    const source = read(APP, 'src', 'renderer.ts');
    expect(source).toMatch(/event\.key === 'Enter' && !event\.shiftKey/);
  });
});

describe('IDE without a terminal', () => {
  // The Android webview has no PTY to own, so the view must mount without
  // one rather than demanding it. Source-level pins: the view needs a DOM
  // and Monaco, which the node test environment cannot host.
  const view = read(APP, 'src', 'ide', 'ide-view.ts');

  it('accepts a missing terminal bridge', () => {
    expect(view).toMatch(/terminal\?: TerminalBridge/);
  });

  it('shows Problems instead of a dead Terminal tab', () => {
    expect(view).toMatch(/No shell, no Terminal tab/);
  });

  it('still disposes the terminal where one exists', () => {
    expect(view).toMatch(/this\.terminal\?\.dispose\(\)/);
  });
});

describe('renderer assets', () => {
  it('ships an html entry point', () => {
    expect(existsSync(join(RENDERER, 'index.html'))).toBe(true);
  });

  it('sets a content security policy', () => {
    const html = read(RENDERER, 'index.html');
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'self'/);
    // No inline scripts, so script-src can stay locked to self. The two
    // fallbacks beside it are load-bearing: Monaco starts its worker from a
    // Blob URL and ships its icon font as a data URL, and without these
    // directives both fall back to default-src and are refused at runtime.
    expect(html).toMatch(/worker-src 'self' blob:/);
    expect(html).toMatch(/font-src 'self' data:/);
    expect(html).not.toMatch(/<script>[^<]/);
  });

  it('does not allow remote scripts', () => {
    const html = read(RENDERER, 'index.html');
    expect(html).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('respects safe-area insets for notched phones', () => {
    const css = read(RENDERER, 'styles.css');
    expect(css).toMatch(/safe-area-inset/);
  });

  it('honours reduced-motion preferences', () => {
    const css = read(RENDERER, 'styles.css');
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it('is ASCII-safe so it renders in any console', () => {
    const css = read(RENDERER, 'styles.css');
    const offenders = [...css].filter((ch) => ch.codePointAt(0)! > 127);
    expect(offenders).toEqual([]);
  });

  it('labels every interactive control', () => {
    const html = read(RENDERER, 'index.html');
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    // Buttons carry visible text, which is the accessible name.
    for (const button of buttons) {
      expect(button).not.toMatch(/\/>\s*$/);
    }
    expect(html).toMatch(/aria-label/);
  });
});

describe('no secrets in the app', () => {
  it('has no credential literals', () => {
    for (const file of ['src/main.ts', 'src/renderer.ts', 'src/preload.cjs']) {
      const source = read(APP, file);
      expect(source).not.toMatch(/sk-ant-/);
      expect(source).not.toMatch(/ghp_/);
      expect(source).not.toMatch(/github_pat_/);
    }
  });
});

describe('repository layout', () => {
  it('keeps the shared core as a workspace dependency, not a copy', () => {
    const lock = JSON.parse(read(REPO, 'package.json')) as { workspaces: string[] };
    expect(lock.workspaces).toContain('packages/*');
    expect(lock.workspaces).toContain('apps/*');
  });
});


describe('stylesheet', () => {
  const css = read(RENDERER, 'styles.css');

  it('makes the hidden attribute beat an author display rule', () => {
    // An author `display` declaration has no UA counterpart to lose to once
    // specificity is equal, so the reset must be important. Without it, any
    // element this file gives a display to cannot be hidden at all.
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);

    // And it must exist rather than merely be permitted: several toggled
    // elements depend on it, and the picker panel is the one that bit.
    const rule = css.match(/\[hidden\]\s*\{[^{}]*\}/)?.[0] ?? '';
    expect(rule).not.toBe('');
  });

  it('defines the class the picker search label relies on', () => {
    // The label is built with className = 'visually-hidden' and had no rule
    // anywhere in the tree, which would have left a real label on screen
    // reading "Search models" above the box.
    expect(css).toMatch(/\.visually-hidden\s*\{/);
  });

  it('styles every class the model picker creates', () => {
    // A class the component emits but the stylesheet never mentions is a
    // silently unstyled element - unstyled, not invisible, which is how the
    // search input ended up covering the onboarding Save button.
    const component = read(APP, 'src', 'model-picker.ts');
    const classes = new Set();
    for (const match of component.matchAll(/className\s*=\s*'([^']+)'/g)) {
      for (const name of (match[1] ?? '').split(/\s+(?![^']*')/)) {
        if (name) classes.add(name);
      }
    }
    // Concatenated conditionally, so picked up from the other pattern too.
    for (const match of component.matchAll(/'(model-[a-z-]+)'/g)) {
      classes.add(match[1] ?? '');
    }

    expect(classes.size).toBeGreaterThan(5);
    for (const name of classes) {
      if (name === '') continue;
      expect(css, `${name} is emitted by the picker but never styled`).toMatch(
        new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '[\\s,{:.]'),
      );
    }
  });
});
