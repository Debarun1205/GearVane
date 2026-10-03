import { existsSync, readFileSync } from 'node:fs';
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

  it('has an app id and a product name', () => {
    expect(manifest.build.appId).toBe('dev.waypoint.app');
    expect(manifest.productName).toBe('Waypoint');
  });

  it('depends on the shared packages rather than duplicating them', () => {
    expect(manifest.dependencies['@waypoint/core']).toBeDefined();
    expect(manifest.dependencies['@waypoint/app-core']).toBeDefined();
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

  it('falls back to defaults when a config is missing or broken', () => {
    expect(source).toMatch(/defaultConfig/);
    expect(source).toMatch(/error:/);
  });

  it('searches for a config beside the executable when packaged', () => {
    expect(source).toMatch(/process\.resourcesPath/);
    expect(source).toMatch(/app\.getAppPath/);
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
});

describe('renderer', () => {
  it('does not assume the Electron bridge exists', () => {
    // The same file runs in a plain browser for the Android build.
    const source = read(APP, 'src', 'renderer.ts');
    expect(source).toMatch(/window\.waypoint \?\? \{\}/);
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