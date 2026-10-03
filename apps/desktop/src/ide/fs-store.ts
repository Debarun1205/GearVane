/**
 * Filesystem operations for the IDE.
 *
 * Main-process side only: this module imports `node:fs` and must never be
 * imported by the renderer bundle. The renderer reaches it through the
 * `ideFs` preload bridge, which is why the Android webview keeps working even
 * though it cannot touch a filesystem.
 *
 * Every path goes through `Workspace.resolve`, so containment is enforced by
 * the same code as the harness tools rather than reimplemented here. A second
 * implementation would eventually disagree with the first about an edge case,
 * and the disagreement would be a vulnerability.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { Workspace } from '@waypoint/harness';

export interface FsEntry {
  name: string;
  /** Workspace-relative, always forward-slashed. */
  path: string;
  isDirectory: boolean;
  size?: number;
}

/** Directories never shown in the tree, whatever they contain. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

/** Stops a pathological workspace (or a symlink loop) from hanging the UI. */
export const MAX_TREE_ENTRIES = 5000;

/** Default cap on a single read. */
export const MAX_READ_BYTES = 256 * 1024;

export interface ListOptions {
  maxEntries?: number;
}

/**
 * List the workspace recursively.
 *
 * Returns a flat list; the renderer builds the tree from it. Symlinked
 * directories that resolve outside the workspace are skipped rather than
 * followed, because following them would show the user files the harness
 * itself refuses to touch.
 */
export async function listFiles(
  root: string,
  options: ListOptions = {},
): Promise<FsEntry[]> {
  const workspace = new Workspace(root);
  const maxEntries = options.maxEntries ?? MAX_TREE_ENTRIES;
  const entries: FsEntry[] = [];

  const walk = async (absolute: string): Promise<void> => {
    if (entries.length >= maxEntries) return;

    let children;
    try {
      children = await readdir(absolute, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing the whole tree.
      return;
    }

    for (const child of children) {
      if (entries.length >= maxEntries) return;

      const childAbsolute = join(absolute, child.name);
      const rel = relative(root, childAbsolute).split(sep).join('/');

      if (child.isDirectory()) {
        if (SKIP_DIRS.has(child.name)) continue;

        // Resolve through containment: a symlink pointing outside the
        // workspace is refused here, so it never appears in the tree.
        const allowed = await workspace.allows(rel);
        if (!allowed) continue;

        entries.push({ name: child.name, path: rel, isDirectory: true });
        await walk(childAbsolute);
      } else if (child.isFile()) {
        let size: number | undefined;
        try {
          size = (await stat(childAbsolute)).size;
        } catch {
          size = undefined;
        }
        entries.push({ name: child.name, path: rel, isDirectory: false, size });
      }
      // Sockets, FIFOs, and anything else: not shown. An IDE tree has no use
      // for them and statting them can block.
    }
  };

  await walk(root);
  return entries;
}

export interface ReadResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/** Read a file as UTF-8 text. */
export async function readTextFile(
  root: string,
  relPath: string,
  maxBytes: number = MAX_READ_BYTES,
): Promise<ReadResult> {
  const workspace = new Workspace(root);

  let absolute: string;
  try {
    absolute = await workspace.resolve(relPath);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { ok: false, error: `No such file: ${relPath}` };
  }

  if (info.isDirectory()) {
    return { ok: false, error: `${relPath} is a directory, not a file` };
  }

  if (info.size > maxBytes) {
    return {
      ok: false,
      error: `${relPath} is ${info.size} bytes, over the ${maxBytes} byte limit`,
    };
  }

  try {
    return { ok: true, content: await readFile(absolute, 'utf8') };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface WriteResult {
  ok: boolean;
  error?: string;
}

export interface RemoveResult {
  ok: boolean;
  error?: string;
}

/**
 * Delete a single file.
 *
 * Files only, never directories: a revert that removes a created file must
 * not be able to take a directory with it because a path was misbuilt.
 * Containment still applies, so only workspace files are deletable.
 */
export async function removeFile(root: string, relPath: string): Promise<RemoveResult> {
  const workspace = new Workspace(root);

  let absolute: string;
  try {
    absolute = await workspace.resolve(relPath);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { ok: false, error: `No such file: ${relPath}` };
  }

  if (!info.isFile()) {
    return { ok: false, error: `${relPath} is not a file` };
  }

  try {
    await rm(absolute);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Write a file, creating parent directories.
 *
 * Parents are created because saving a new file into a new folder is normal
 * IDE behaviour. Containment still holds: the resolved path must stay inside
 * the workspace, parents included.
 */
export async function writeTextFile(
  root: string,
  relPath: string,
  content: string,
): Promise<WriteResult> {
  const workspace = new Workspace(root);

  let absolute: string;
  try {
    absolute = await workspace.resolve(relPath);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
