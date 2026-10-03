/**
 * Monaco setup for the IDE.
 *
 * ## The worker problem
 *
 * Monaco runs its language work in a Web Worker. In a normal web app that is
 * a separate file served alongside the page. This renderer is bundled into a
 * single self-contained file, so there is no second file to serve, and
 * `new Worker(new URL('./worker.js', import.meta.url))` has nothing to point
 * at.
 *
 * The solution is a Blob URL: the worker source is bundled as a string and
 * turned into an object URL at runtime. It costs nothing at build time and
 * works in any context that can create a Worker, which includes Electron.
 *
 * ## Why the AMD build
 *
 * `monaco-editor` resolves to the AMD build, which is a single UMD file with
 * no static imports to trace. The ESM build is a graph of hundreds of modules
 * that esbuild would have to walk. AMD also handles its own worker creation
 * through `MonacoEnvironment`, which is exactly the hook the Blob approach
 * needs.
 */

import * as monaco from 'monaco-editor/min/vs/editor/editor.main.js';

/**
 * The editor worker, as a string.
 *
 * Imported with esbuild's text loader so it lands in the bundle as a string
 * rather than as a module to resolve. Without this the import fails at build
 * time, because the worker file is not part of the module graph.
 */
import workerSource from './editor.worker.txt';

let workerUrl: string | undefined;

/**
 * Point Monaco at a worker built from the bundled source.
 *
 * Called once, before any editor is created. Monaco calls `getWorkerUrl` for
 * each worker it needs; returning the same URL for all of them is fine because
 * the editor worker handles every language.
 */
export function installMonacoEnvironment(): void {
  self.MonacoEnvironment = {
    getWorkerUrl: () => {
      if (!workerUrl) {
        workerUrl = URL.createObjectURL(
          new Blob([workerSource], { type: 'text/javascript' }),
        );
      }
      return workerUrl;
    },
  };
}

/** Read a colour from the active theme on the document root. */
function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** Expand #rgb or #rrggbb to #rrggbbaa; anything unparseable passes through. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  const raw = match?.[1];
  if (raw === undefined) return hex;
  const digits =
    raw.length === 3
      ? raw
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : raw;
  const tail = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${digits}${tail}`;
}

/**
 * Define (or redefine) the accent-aware editor theme.
 *
 * Monaco draws its chrome itself and cannot read CSS variables, so the
 * theme is rebuilt from the active look each time. Redefining the same id
 * hot-swaps every open editor, main and diff alike, without touching the
 * models the user has open.
 */
export function applyMonacoTheme(): void {
  const bg = cssColor('--bg', '#0b1120');
  const text = cssColor('--text', '#e2e8f0');
  const dim = cssColor('--text-dim', '#8494b0');
  const accent = cssColor('--accent', '#38bdf8');
  const border = cssColor('--border', '#24304a');
  const input = cssColor('--bg-input', '#0f1729');

  monaco.editor.defineTheme('waypoint', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': text,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': withAlpha(accent, 0.35),
      'editor.inactiveSelectionBackground': withAlpha(accent, 0.18),
      'editor.lineHighlightBackground': withAlpha(accent, 0.1),
      'editorLineNumber.foreground': withAlpha(dim, 0.55),
      'editorLineNumber.activeForeground': accent,
      'editorWidget.background': bg,
      'editorWidget.border': border,
      'input.background': input,
      focusBorder: accent,
    },
  });
}

export { monaco };

export { languageForPath } from './languages.js';