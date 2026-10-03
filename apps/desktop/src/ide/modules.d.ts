/**
 * Type declarations for modules without them.
 *
 * Monaco's AMD build ships no types for the `min/vs` entry point, and the
 * worker is bundled as a text file. Both need declarations or TypeScript
 * treats them as `any`, which would silently disable checking on the whole
 * module.
 */

declare module 'monaco-editor/min/vs/editor/editor.main.js' {
  export * from 'monaco-editor/esm/vs/editor/editor.api';
}

declare module '*.txt' {
  const content: string;
  export default content;
}

interface Window {
  /**
   * Monaco's worker factory.
   *
   * Set before any editor is created. Monaco calls it for each worker it
   * needs; the IDE returns a Blob URL so the worker can be created from the
   * bundled source rather than a separate file.
   */
  MonacoEnvironment?: {
    getWorkerUrl?: (workerId: string, label: string) => string;
    getWorker?: (workerId: string, label: string) => Worker;
  };
}