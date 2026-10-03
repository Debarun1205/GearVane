/**
 * Integrated terminal, renderer side.
 *
 * ## Why this talks to the main process
 *
 * A real terminal needs a pseudo-terminal, which means native code. The
 * renderer runs with `nodeIntegration: false` and `contextIsolation: true`, so
 * it has no `require`, no `createRequire`, and no way to load a Node builtin.
 * node-pty therefore cannot live here at all.
 *
 * The main process owns the PTY. The renderer owns xterm.js and forwards
 * keystrokes; the main process forwards output back. That is the same split
 * the builder uses, and for the same reason: the renderer is sandboxed, and
 * anything that can spawn a process cannot be allowed to run there.
 *
 * ## Degradation
 *
 * If the main process reports that node-pty is unavailable, the panel says so
 * and the rest of the IDE keeps working. A fake terminal that echoes input
 * without a shell behind it would be worse than no terminal, because the user
 * would believe they had a working shell.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { APPEARANCE_EVENT } from '../theme.js';

export type TerminalStatus = 'ready' | 'unavailable' | 'error';

/**
 * The xterm palette follows the active theme.
 *
 * xterm draws to a canvas and cannot read CSS variables, so the terminal
 * samples them once at construction and again on every appearance change.
 * Without the listener the shell would sit in the default palette while the
 * panes around it switched themes.
 */
function currentTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback;

  return {
    background: read('--bg', '#0b1120'),
    foreground: read('--text', '#e2e8f0'),
    cursor: read('--accent', '#38bdf8'),
    selectionBackground: read('--accent-dim', '#0e7490'),
  };
}

export interface TerminalSession {
  terminal: Terminal;
  status: TerminalStatus;
  dispose(): void;
}

/** Bridge to the main process, supplied by the preload script. */
export interface TerminalBridge {
  start(cwd: string): Promise<{ ok: boolean; reason?: string }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: () => void): void;
}

/**
 * Create a terminal in a container.
 *
 * Never throws. If the main process cannot provide a PTY, the session reports
 * `unavailable` and shows why.
 */
export function createTerminal(
  container: HTMLElement,
  bridge: TerminalBridge,
  cwd: string,
): TerminalSession {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: currentTheme(),
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);

  let status: TerminalStatus = 'ready';

  bridge.onData((data) => terminal.write(data));
  bridge.onExit(() => terminal.writeln('\r\n[process exited]'));

  terminal.onData((data) => bridge.write(data));

  const measure = (): void => {
    try {
      fit.fit();
      const { cols, rows } = terminal;
      bridge.resize(cols, rows);
    } catch {
      // Fitting before the container has been laid out throws. Harmless.
    }
  };

  window.addEventListener('resize', measure);

  // Re-read the palette whenever the look changes. Disposed below with the
  // terminal, so a closed IDE does not leave listeners behind.
  const onAppearance = (): void => {
    terminal.options.theme = currentTheme();
  };
  window.addEventListener(APPEARANCE_EVENT, onAppearance);

  void bridge.start(cwd).then((result) => {
    if (result.ok) {
      measure();
      return;
    }

    status = 'unavailable';
    terminal.writeln('');
    terminal.writeln('Terminal unavailable.');
    if (result.reason) terminal.writeln(result.reason);
    terminal.writeln('The rest of the IDE works normally.');
  });

  return {
    terminal,
    get status() {
      return status;
    },
    dispose: () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener(APPEARANCE_EVENT, onAppearance);
      bridge.kill();
      terminal.dispose();
    },
  };
}