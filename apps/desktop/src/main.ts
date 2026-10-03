/**
 * Electron main process.
 *
 * The window is a thin shell: all routing logic lives in @waypoint/core and
 * @waypoint/app-core, which also run in the Android build. Keeping the main
 * process small means the renderer and the mobile webview share the same
 * behaviour.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig, defaultConfig, type WaypointConfig } from '@waypoint/core';

import { registerBuilderHandlers } from './builder-host.js';
import { registerIdeAgentHandlers } from './ide-agent-host.js';
import { registerIdeFsHandlers } from './ide-fs-host.js';
import { registerTerminalHandlers } from './terminal-host.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RENDERER_DIR = join(HERE, '..', 'renderer');

const CONFIG_NAMES = [
  'waypoint.config.json',
  'waypoint.config.yaml',
  'waypoint.yaml',
  'config.yaml',
];

let mainWindow: BrowserWindow | null = null;

function isDevelopment(): boolean {
  return !app.isPackaged;
}

/**
 * Locate a config file.
 *
 * Packaged builds read from beside the executable; development reads from the
 * repository root. A missing config falls back to built-in defaults rather
 * than failing, so a fresh install opens with a working local tier.
 */
export function findConfigPath(): string | null {
  const roots = isDevelopment()
    ? [join(HERE, '..', '..', '..')]
    : [process.resourcesPath, app.getAppPath(), join(homedir(), '.waypoint')];

  for (const root of roots) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function loadConfigFile(): { config: WaypointConfig; path: string | null; error?: string } {
  const path = findConfigPath();
  if (!path) return { config: defaultConfig(process.env), path: null };

  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') return { config: defaultConfig(process.env), path };
    const config = parseConfig(text, path.endsWith('.json') ? 'json' : 'yaml');
    return { config, path };
  } catch (error) {
    // A broken config must not stop the app from opening; the user gets a
    // notification and defaults instead.
    return {
      config: defaultConfig(process.env),
      path,
      error: (error as Error).message,
    };
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 480,
    minHeight: 480,
    title: 'Waypoint',
    backgroundColor: '#0b1120',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      // The renderer is node-free by design: the Android webview runs the
      // same bundle, and every sensitive operation (files, shell, builder)
      // crosses the preload bridge to a main-process host that validates
      // it. contextIsolation must be on because the preload uses
      // contextBridge - with it off, contextBridge throws at load, the
      // bridge never injects, and the IDE cannot mount. That combination
      // silently broke every build up to and including v0.3.0.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // The loader takes the window as an argument on purpose. It used to read
  // the module-level `mainWindow` instead, but createWindow has not returned
  // when this runs, so the variable was still null and the function returned
  // without loading anything: every non-packaged run showed a blank window.
  if (isDevelopment()) {
    void loadFile(window);
  } else {
    void window.loadFile(join(RENDERER_DIR, 'index.html'));
  }

  // External links open in the user's browser rather than navigating the
  // app shell away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

async function loadFile(window: BrowserWindow): Promise<void> {
  const indexPath = resolve(RENDERER_DIR, 'index.html');
  if (existsSync(indexPath)) {
    await window.loadFile(indexPath);
  }
}

function describePlatform(): Record<string, string> {
  return {
    platform: platform(),
    version: app.getVersion(),
    packaged: String(app.isPackaged),
    configPath: findConfigPath() ?? '',
  };
}

app.whenReady().then(() => {
  const { error } = loadConfigFile();

  mainWindow = createWindow();

  if (error) {
    // Surface a bad config immediately rather than letting it look like a
    // routing problem later.
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('config:error', error);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS an app stays alive with no windows; everywhere else it quits.
  if (platform() !== 'darwin') app.quit();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
});

// --- IPC --------------------------------------------------------------------
// The renderer is sandboxed, so it cannot read the filesystem. Everything it
// needs from the host goes through these narrow handlers.

ipcMain.handle('app:info', () => describePlatform());

ipcMain.handle('config:read', () => {
  const { config, path, error } = loadConfigFile();
  return { config, path, error: error ?? null };
});

ipcMain.handle('shell:open', (_event, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:/.test(url)) return false;
  void shell.openExternal(url);
  return true;
});

// The builder needs a filesystem, which the renderer does not have. See
// builder-host.ts for why the split matters.
registerBuilderHandlers();

// The terminal needs a PTY, which the renderer cannot load. See
// terminal-host.ts for why the split matters.
registerTerminalHandlers();

// The IDE needs a filesystem, which the renderer does not have. See
// ide-fs-host.ts for why the split matters.
registerIdeFsHandlers();

// The IDE agent loop needs the harness tool layer, which the renderer cannot
// load. See ide-agent-host.ts for why the split matters.
registerIdeAgentHandlers(() => loadConfigFile().config);

export { mainWindow, createWindow };