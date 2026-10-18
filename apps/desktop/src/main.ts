/**
 * Electron main process.
 *
 * The window is a thin shell: all routing logic lives in @gearvane/core and
 * @gearvane/app-core, which also run in the Android build. Keeping the main
 * process small means the renderer and the mobile webview share the same
 * behaviour.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig, defaultConfig, type GearVaneConfig } from '@gearvane/core';

import { registerBuilderHandlers } from './builder-host.js';
import {
  EMBEDDED_MODEL_DIR_ENV,
  generateToken,
  startEmbeddedServer,
  type EmbeddedServer,
} from './embedded-server.js';
import { fileFeedbackStorage, userDataFeedbackFile } from './feedback-host.js';
import { registerIdeAgentHandlers } from './ide-agent-host.js';
import { registerIdeFsHandlers } from './ide-fs-host.js';
import { KeyVault, vaultPath } from './keys-host.js';
import { registerModelsHandlers } from './models-host.js';
import { registerHardwareHandlers } from './hardware-host.js';
import { Provisioner, registerProvisionHandlers } from './provision-host.js';
import { registerTerminalHandlers } from './terminal-host.js';
import { registerUpdaterHandlers } from './updater-host.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RENDERER_DIR = join(HERE, '..', 'renderer');

const CONFIG_NAMES = [
  'gearvane.config.json',
  'gearvane.config.yaml',
  'gearvane.yaml',
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
    : [process.resourcesPath, app.getAppPath(), join(homedir(), '.gearvane')];

  for (const root of roots) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function loadConfigFile(): { config: GearVaneConfig; path: string | null; error?: string } {
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
    title: 'GearVane',
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

/**
 * The directory downloaded weights are written to, and so the one that has to
 * be writable.
 *
 * Packaged builds used to download into resources/models, which is inside the
 * install. That is read-only for an AppImage (a squashfs mount) and for a .deb
 * (root-owned under /opt), re-extracted on every launch for the Windows
 * portable build, and inside the signed bundle on macOS. First-boot
 * provisioning and every one-click install would have failed or vanished on
 * those. Packaged builds therefore write under the per-user data directory.
 *
 * Development keeps resources/models, where `npm run models:fetch` puts
 * weights. GEARVANE_MODEL_DIR overrides both and is used for everything.
 *
 * Call this after the app is ready: it reads app.getPath('userData').
 */
export function findModelDir(): string {
  const override = process.env[EMBEDDED_MODEL_DIR_ENV];
  if (override) return override;
  if (isDevelopment()) return join(HERE, '..', 'resources', 'models');
  return join(app.getPath('userData'), 'models');
}

/**
 * The weights that shipped inside the installer, which are read-only.
 *
 * Packaged builds carry resources/models via extraResources. The embedded
 * server serves this directory and findModelDir() together, so an installed
 * weight is served from wherever it landed. A missing directory is fine: the
 * embedded server reports itself unavailable and the other local providers
 * carry on.
 */
export function findBundledModelDir(): string {
  const override = process.env[EMBEDDED_MODEL_DIR_ENV];
  if (override) return override;
  if (isDevelopment()) return join(HERE, '..', 'resources', 'models');
  return join(process.resourcesPath, 'models');
}

/**
 * The embedded server's runtime coordinates, or null when it is down.
 *
 * The port is OS-assigned per launch and the token is generated per launch,
 * so neither can be guessed by a local process or a web page. Both are
 * injected into every config the app serves, which is the only place the
 * renderer learns them; nothing writes them to disk.
 */
type EmbeddedHandle = { port: number; token: string } | null;

let embedded: Promise<EmbeddedHandle> | null = null;

function embeddedHandle(): Promise<EmbeddedHandle> {
  if (!embedded) {
    embedded = startEmbeddedServer({
      port: 0,
      modelDir: findBundledModelDir(),
      extraModelDirs: [findModelDir()],
      token: generateToken(),
      onLog: (message) => console.log(`[gearvane] ${message}`),
    }).then(
      (server: EmbeddedServer) =>
        server.started && server.token ? { port: server.port, token: server.token } : null,
      (startupError: unknown) => {
        // A missing model, a taken port, or an unloadable native module only
        // logs, never stops the app booting.
        console.log(
          `[gearvane] embedded model failed to start: ${startupError instanceof Error ? startupError.message : String(startupError)}`,
        );
        return null;
      },
    );
  }
  return embedded;
}

/**
 * Point every embedded provider at the bound port and attach the per-launch
 * token. Applied to a fresh copy on each call: the parsed config is never
 * mutated, and a config read before the server is ready still gets the
 * rewrite because this awaits the same promise.
 */
async function serveConfig(): Promise<GearVaneConfig> {
  const { config } = loadConfigFile();
  const handle = await embeddedHandle();
  if (!handle) return config;
  const tiers = { ...config.tiers };
  for (const tierName of ['local', 'mid', 'frontier'] as const) {
    const tier = tiers[tierName];
    tiers[tierName] = {
      ...tier,
      providers: tier.providers.map((provider) =>
        provider.name === 'embedded'
          ? { ...provider, baseUrl: `http://127.0.0.1:${handle.port}`, apiKey: handle.token }
          : provider,
      ),
    };
  }
  return { ...config, tiers };
}

/**
 * Whether this launch should fetch the first-boot weights.
 *
 * Installed builds do. An unpackaged run (`npm start`, and every Playwright
 * test that launches dist/main.js) does not: it used to start the same 9 GiB of
 * downloads, so each end-to-end run began transferring real weights into a temp
 * directory and was then killed, leaving gigabytes behind. A developer fetches
 * weights on purpose with `npm run models:fetch`.
 *
 * GEARVANE_PROVISION=1 opts an unpackaged run in (to try the chip by hand);
 * GEARVANE_PROVISION=0 opts a packaged one out (the packaged-app smoke test,
 * which must not download weights on a CI runner).
 */
export function shouldProvision(): boolean {
  const setting = process.env['GEARVANE_PROVISION'];
  if (setting === '0') return false;
  if (setting === '1') return true;
  return app.isPackaged;
}

app.whenReady().then(() => {
  const { error } = loadConfigFile();

  // Registered here rather than at import time: the writable model directory is
  // under app.getPath('userData'), which is only meaningful once the app is
  // ready. The handlers exist before the window loads, so the renderer cannot
  // call one that is not there yet.
  const provisioner = registerModelHosts();

  mainWindow = createWindow();

  // The bundled local model answers the local tier with nothing else to
  // install. Fire-and-forget on purpose: a missing model or an unloadable
  // native module only logs, never stops the app booting.
  void embeddedHandle();

  // First-boot provisioning: fetch the two non-installer weights in the
  // background, one at a time, with no prompt. Started after the window exists
  // so the progress chip has somewhere to appear, and not awaited -- a first
  // launch must not wait on 9 GiB of network to show a window.
  //
  // Each finished weight is usable immediately: it lands in the directory the
  // embedded server serves, so Auto routing picks it up without a restart.
  if (shouldProvision()) {
    void provisioner
      .start()
      .then(() => {
        const ready = provisioner.status().items.filter((item) => item.state === 'done');
        if (ready.length > 0) {
          mainWindow?.webContents.send('provision:ready', ready.map((item) => item.id));
        }
      })
      .catch((cause: unknown) => {
        // Provisioning is a convenience. A failure here must not be able to stop
        // the app booting, so it is logged and nothing else.
        console.error('first-boot provisioning failed:', cause);
      });
  }

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

ipcMain.handle('config:read', async () => {
  const { path, error } = loadConfigFile();
  const config = await serveConfig();
  return { config, path, error: error ?? null };
});

ipcMain.handle('shell:open', (_event, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:/.test(url)) return false;
  void shell.openExternal(url);
  return true;
});

// The vault file belongs to the main process and is encrypted by the OS, so
// keys are not readable from the profile directory. The renderer gets values
// through these handlers and nothing else. See keys-host.ts.
const vault = new KeyVault(vaultPath());

ipcMain.handle('keys:read', () => ({
  keys: vault.keys(),
  persistent: vault.persistent(),
}));

ipcMain.handle('keys:save', (_event, keys: unknown) => vault.save(keys));

ipcMain.handle('keys:clear', () => {
  vault.clear();
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
// load. See ide-agent-host.ts for why the split matters. It gets the same
// rewritten config as the renderer, so the agent reaches the embedded server
// on its bound port with the per-launch token.
//
// The last argument is the feedback log: without it the app runs models and
// tells the classifier nothing, so `gearvane train` has no data from anyone
// who installed the desktop app. See feedback-host.ts.
registerIdeAgentHandlers(
  async () => serveConfig(),
  () => vault.env(),
  () => fileFeedbackStorage(userDataFeedbackFile()),
);

// In-app updater: poll for new GitHub releases and provide download/install triggers.
registerUpdaterHandlers(() => mainWindow);

/**
 * The model-related IPC, and the first-boot provisioner it drives.
 *
 * Model downloads land in a directory the embedded server also serves, so a
 * finished fetch is usable without a restart (see models-host.ts). The
 * installer's own weights are read-only and are passed separately, so they
 * count as installed but are never written to.
 *
 * Returns the provisioner because the boot path starts it: there is exactly
 * one model directory per process, so there is exactly one provisioner.
 */
function registerModelHosts(): Provisioner {
  const writable = findModelDir();
  const bundled = findBundledModelDir();
  // The directory is created here so a first launch can measure free space on
  // it before any weight has been written.
  mkdirSync(writable, { recursive: true });

  registerModelsHandlers(writable, bundled === writable ? [] : [bundled]);

  // First-boot provisioning, and the IPC the progress chip needs.
  const provisioner = new Provisioner(writable, {
    onChange: (status) => {
      mainWindow?.webContents.send('provision:status', status);
    },
  });
  registerProvisionHandlers(provisioner);

  // The renderer cannot statfs or read os.totalmem from a sandboxed context, so
  // the fit checks in the install dialog and the onboarding scan get their
  // numbers from here.
  registerHardwareHandlers(writable);

  return provisioner;
}

export { mainWindow, createWindow };