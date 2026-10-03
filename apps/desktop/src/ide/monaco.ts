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

export { monaco };

export { languageForPath } from './languages.js';