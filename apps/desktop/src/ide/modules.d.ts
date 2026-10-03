/**
 * Type declarations for modules without them.
 *
 * The editor worker is bundled as a text file, which has no type of its own.
 * Without this declaration TypeScript treats it as `any`, which would
 * silently disable checking wherever the worker source is used. Monaco's own
 * types come from its package `types` field now that the ESM entry is the
 * import.
 */

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