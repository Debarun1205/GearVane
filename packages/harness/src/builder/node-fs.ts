/**
 * Node filesystem binding for the builder.
 *
 * This is the **only** file in the builder that imports `node:fs`. Keeping the
 * dynamic imports here rather than in `scaffold.ts` is what lets the website
 * bundle the scaffold engine for a browser: esbuild resolves `node:fs` at
 * bundle time and fails the build wherever it appears, even behind a dynamic
 * import. Nothing in the browser bundle reaches this file, because
 * `scaffold.ts` never imports it.
 *
 * Node hosts call `installNodeFileSystem()` at startup. The website never
 * does, which is exactly why its builder can only produce a download.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  setFileSystem,
  type FileSystemBridge,
} from './scaffold.js';

export { setFileSystem, type FileSystemBridge };

const nodeFileSystem: FileSystemBridge = {
  mkdir: (target, options) => mkdir(target, options),
  writeFile: (target, contents, encoding) => writeFile(target, contents, encoding),
  dirname: (target) => dirname(target),
  exists: async (target) =>
    access(target).then(
      () => true,
      () => false,
    ),
};

/**
 * Install the real filesystem. Call once at startup.
 *
 * Idempotent, so a host can call it defensively without checking.
 */
export function installNodeFileSystem(): FileSystemBridge {
  setFileSystem(nodeFileSystem);
  return nodeFileSystem;
}