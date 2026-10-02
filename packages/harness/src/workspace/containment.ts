/**
 * Workspace containment.
 *
 * Every path a tool touches passes through here. This is the layer that makes
 * "the agent works in your project directory" a property of the system rather
 * than a promise in the documentation.
 *
 * The hard case is not `..`. Lexical normalisation catches that, and any
 * implementation that stops there is wrong, because a symlink inside the
 * workspace can point anywhere and lexical normalisation follows it happily.
 * So a resolved path is re-checked against the *real* path of the deepest
 * existing ancestor, which is what closes the symlink escape.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/** Thrown when a path falls outside the workspace. */
export class ContainmentError extends Error {
  constructor(
    readonly requested: string,
    readonly resolved: string,
    reason: string,
  ) {
    super(`Path escapes the workspace: ${reason}`);
    this.name = 'ContainmentError';
  }
}

/** Thrown when a path is malformed in a way that is an attack, not a typo. */
export class InvalidPathError extends Error {
  constructor(readonly requested: string, reason: string) {
    super(`Invalid path: ${reason}`);
    this.name = 'InvalidPathError';
  }
}

/**
 * True when `child` is `parent` or sits beneath it.
 *
 * Compares the real, normalised forms rather than using string prefixes,
 * because `/home/user/project-evil` starts with `/home/user/project` but is
 * not inside it. That check was a real bug in an earlier draft.
 */
export function isInside(parent: string, child: string): boolean {
  const parentClean = normalize(parent);
  const childClean = normalize(child);

  if (parentClean === childClean) return true;

  const rel = relative(parentClean, childClean);
  if (rel === '') return true;

  // `relative` returning an absolute path means the two are on different
  // drives on Windows, which is definitionally outside.
  if (isAbsolute(rel)) return false;

  // A relative path that climbs out starts with `..`.
  return !rel.startsWith(`..${sep}`) && rel !== '..';
}

/**
 * Resolves a path to its real location, following every symbolic link.
 *
 * Injectable because creating a symlink requires Developer Mode or elevation
 * on Windows, and a security check that cannot be exercised on the platform
 * most of this project is developed on is a check nobody is exercising.
 */
export type RealpathLike = (target: string) => Promise<string>;

/**
 * The deepest existing ancestor of `target`, as a real path.
 *
 * A path being created does not exist yet, so realpath cannot be called on it
 * directly. Walking up to the first directory that does exist and resolving
 * that is enough: any symlink along the way is already in the resolved prefix.
 */
const realpathOfNearestAncestor: RealpathLike = async (target) => {
  let current = target;

  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = join(current, '..');
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return current;
      current = parent;
    }
  }
};

export interface WorkspaceOptions {
  /**
   * Follow symlinks when checking containment. Only disable this when
   * exercising the lexical check alone.
   */
  followSymlinks?: boolean;

  /** Override how real paths are resolved. For tests. */
  realpath?: RealpathLike;
}

export class Workspace {
  /** Absolute, normalised root as given. */
  readonly root: string;

  private readonly followSymlinks: boolean;
  private readonly realpathImpl: RealpathLike;

  constructor(root: string, options: WorkspaceOptions = {}) {
    if (root.trim() === '') {
      throw new InvalidPathError(root, 'workspace root is empty');
    }

    this.root = resolve(root);
    this.followSymlinks = options.followSymlinks ?? true;
    this.realpathImpl = options.realpath ?? realpathOfNearestAncestor;
  }

  /**
   * Resolve a caller-supplied path to an absolute path inside the workspace.
   *
   * Accepts workspace-relative paths and absolute paths that are already
   * inside the workspace. Rejects everything else.
   *
   * @throws {InvalidPathError} for a malformed path
   * @throws {ContainmentError} for a path that resolves outside the workspace
   */
  async resolve(candidate: string): Promise<string> {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new InvalidPathError(String(candidate), 'path is empty');
    }

    // A null byte truncates the path in native calls, so "a.txt\0../../etc" is
    // a real escape technique rather than a theoretical one.
    if (candidate.includes('\0')) {
      throw new InvalidPathError(candidate, 'path contains a null byte');
    }

    // Windows accepts both separators. A model trained on POSIX emits `/` on a
    // Windows workspace, and treating them as distinct would let
    // `..\\..\\Windows` through unnoticed.
    const unified = candidate.replace(/[\\/]+/g, sep);

    const absolute = isAbsolute(unified) ? normalize(unified) : join(this.root, unified);
    const normalised = normalize(absolute);

    if (!isInside(this.root, normalised)) {
      throw new ContainmentError(candidate, normalised, 'it resolves outside the workspace');
    }

    if (this.followSymlinks) {
      const realRoot = await this.realpathImpl(this.root);
      const realTarget = await this.realpathImpl(normalised);

      if (!isInside(realRoot, realTarget)) {
        throw new ContainmentError(
          candidate,
          realTarget,
          'it resolves through a symbolic link to outside the workspace',
        );
      }
    }

    return normalised;
  }

  /** Whether a path is inside the workspace, without throwing. */
  async allows(candidate: string): Promise<boolean> {
    try {
      await this.resolve(candidate);
      return true;
    } catch {
      return false;
    }
  }

  /** Express an absolute in-workspace path relative to the root. */
  toRelative(absolute: string): string {
    const rel = relative(this.root, absolute);
    return rel === '' ? '.' : rel;
  }

  /** The real path of the root, which may itself be behind a symlink. */
  realRoot(): Promise<string> {
    return this.realpathImpl(this.root);
  }
}