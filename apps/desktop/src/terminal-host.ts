/**
 * PTY ownership for the IDE terminal.
 *
 * The renderer is sandboxed and cannot load node-pty, so the main process owns
 * the pseudo-terminal and the renderer talks to it over IPC. This is the same
 * split the builder uses: anything that can spawn a process stays out of the
 * renderer.
 *
 * node-pty is loaded dynamically and its absence is reported rather than
 * thrown. This machine has no C++ toolchain, so `npm install node-pty` fails
 * here with `gyp ERR! find VS`; CI runners have a toolchain and build it. A
 * terminal that crashes the app when the native module is missing would be
 * unacceptable either way.
 */

import { ipcMain } from 'electron';
import { createRequire } from 'node:module';

interface PtyProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

/** The active PTY, or null when none is running. */
let active: PtyProcess | undefined;

/** Where output should go, set by the renderer's subscription. */
let sendToRenderer: ((data: string) => void) | undefined;
let sendExit: (() => void) | undefined;

/**
 * Load node-pty.
 *
 * Returns null when it cannot be loaded, which is the expected outcome on a
 * machine without a C++ toolchain. The caller reports that rather than
 * throwing, so the IDE degrades instead of breaking.
 */
function loadPty(): { spawn: (...args: unknown[]) => PtyProcess } | null {
  try {
    // createRequire rather than a static import: a static import of a module
    // that may not exist would stop the main process from starting at all,
    // which is exactly the failure this is meant to avoid.
    const require = createRequire(import.meta.url);
    return require('node-pty') as { spawn: (...args: unknown[]) => PtyProcess };
  } catch {
    return null;
  }
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    'terminal:start',
    async (_event, cwd: unknown) => {
      if (active) {
        active.kill();
        active = undefined;
      }

      const pty = loadPty();
      if (!pty) {
        return {
          ok: false,
          reason:
            'node-pty is not available in this build. It needs a C++ toolchain ' +
            'to compile, which this machine does not have.',
        };
      }

      const shell =
        process.platform === 'win32'
          ? process.env['COMSPEC'] ?? 'powershell.exe'
          : process.env['SHELL'] ?? 'bash';

      try {
        active = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: typeof cwd === 'string' ? cwd : process.cwd(),
          env: process.env as Record<string, string>,
        });
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }

      active.onData((data) => sendToRenderer?.(data));
      active.onExit(() => {
        sendExit?.();
        active = undefined;
      });

      return { ok: true };
    },
  );

  ipcMain.on('terminal:write', (_event, data: unknown) => {
    if (typeof data === 'string') active?.write(data);
  });

  ipcMain.on('terminal:resize', (_event, cols: unknown, rows: unknown) => {
    if (typeof cols === 'number' && typeof rows === 'number') {
      active?.resize(cols, rows);
    }
  });

  ipcMain.on('terminal:kill', () => {
    active?.kill();
    active = undefined;
  });

ipcMain.on('terminal:subscribe', (event) => {
    sendToRenderer = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:data', data);
    };
    sendExit = () => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:exit');
    };
  });
}

/** Whether a PTY could be loaded, for the UI to explain itself. */
export function ptyAvailable(): boolean {
  return loadPty() !== null;
}