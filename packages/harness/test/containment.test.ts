import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ContainmentError,
  InvalidPathError,
  Workspace,
  isInside,
} from '../src/workspace/containment.js';

/**
 * Adversarial tests for workspace containment.
 *
 * Every case here is a way an agent could reach outside its workspace. The
 * interesting ones are not `..`, which lexical normalisation already handles:
 * they are the symlink escape, the sibling-directory prefix confusion, and the
 * mixed separator a model emits on the wrong platform.
 */

let root: string;
let outside: string;
let workspace: Workspace;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'gearvane-ws-'));
  root = join(base, 'project');
  outside = join(base, 'secrets');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  await writeFile(join(outside, 'key.txt'), 'SECRET\n');
  workspace = new Workspace(root);
});

afterAll(() => {
  // Temp dirs are left for the OS to reap; removing them on Windows can fail
  // while a handle is still open, which would mask real failures.
});

describe('isInside', () => {
  it('accepts the directory itself', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });

  it('accepts a direct child', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
  });

  it('accepts a deep descendant', () => {
    expect(isInside('/a/b', '/a/b/c/d/e.txt')).toBe(true);
  });

  it('rejects the parent', () => {
    expect(isInside('/a/b', '/a')).toBe(false);
  });

  it('rejects a sibling', () => {
    expect(isInside('/a/b', '/a/c')).toBe(false);
  });

  it('rejects a prefix-sharing sibling directory', () => {
    // The case a startsWith check gets wrong: "/a/project-evil" begins with
    // "/a/project" as a string but is a different directory.
    expect(isInside('/a/project', '/a/project-evil')).toBe(false);
    expect(isInside('/a/project', '/a/project-evil/secret.txt')).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInside(join(root, 'src'), '/etc/passwd')).toBe(false);
  });
});

describe('Workspace.resolve accepts legitimate paths', () => {
  it('resolves a simple relative path', async () => {
    const resolved = await workspace.resolve('src/index.ts');
    expect(resolved).toBe(join(root, 'src', 'index.ts'));
  });

  it('resolves a path that does not exist yet', async () => {
    // Writes create files, so refusing paths that are absent would make the
    // write tool useless.
    const resolved = await workspace.resolve('src/new-file.ts');
    expect(resolved).toBe(join(root, 'src', 'new-file.ts'));
  });

  it('resolves a path in a directory that does not exist yet', async () => {
    const resolved = await workspace.resolve('a/b/c/deep.txt');
    expect(resolved).toBe(join(root, 'a', 'b', 'c', 'deep.txt'));
  });

  it('accepts an absolute path inside the workspace', async () => {
    const inside = join(root, 'src', 'index.ts');
    expect(await workspace.resolve(inside)).toBe(inside);
  });

  it('resolves the root itself', async () => {
    expect(await workspace.resolve('.')).toBe(root);
  });

  it('collapses redundant separators and . segments', async () => {
    expect(await workspace.resolve('./src/./index.ts')).toBe(
      join(root, 'src', 'index.ts'),
    );
  });

  it('resolves a traversal that stays inside', async () => {
    // src/../src/index.ts climbs but lands back inside. Refusing it would be
    // correct but needlessly hostile to a model doing arithmetic on paths.
    expect(await workspace.resolve('src/../src/index.ts')).toBe(
      join(root, 'src', 'index.ts'),
    );
  });

  it('normalises separators to the platform separator', async () => {
    // Written platform-agnostically on purpose. An earlier version asserted
    // the absence of '/', which is true on Windows and false everywhere else,
    // so it passed locally and failed on the Linux CI runner.
    const resolved = await workspace.resolve('src/index.ts');
    expect(resolved).toBe(join(root, 'src', 'index.ts'));
    expect(resolved).not.toContain(sep === '/' ? '\\' : '/');
  });

  it('rejects traversal written with a forward slash', async () => {
    // The shape a model emits, regardless of the platform it is running on.
    await expect(
      workspace.resolve('src/../../secrets/key.txt'),
    ).rejects.toThrow(ContainmentError);
  });
});

describe('Workspace.resolve rejects escapes', () => {
  it('rejects parent traversal', async () => {
    await expect(workspace.resolve('../secrets/key.txt')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('rejects deep parent traversal', async () => {
    await expect(workspace.resolve('../../../../etc/passwd')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('rejects traversal hidden mid-path', async () => {
    await expect(workspace.resolve('src/../../secrets/key.txt')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('rejects an absolute path outside the workspace', async () => {
    await expect(workspace.resolve(join(outside, 'key.txt'))).rejects.toThrow(
      ContainmentError,
    );
  });

  it('rejects a system path', async () => {
    await expect(workspace.resolve('/etc/passwd')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('rejects a null byte', async () => {
    // Without this, "a.txt\0../../etc/passwd" truncates to "a.txt" in some
    // native calls and escapes the check.
    await expect(workspace.resolve('a.txt\0../../etc/passwd')).rejects.toThrow(
      InvalidPathError,
    );
  });

  it('rejects an empty path', async () => {
    await expect(workspace.resolve('')).rejects.toThrow(InvalidPathError);
  });

  it('rejects a whitespace-only path', async () => {
    await expect(workspace.resolve('   ')).rejects.toThrow(InvalidPathError);
  });

  it('rejects a non-string path', async () => {
    await expect(
      workspace.resolve(undefined as unknown as string),
    ).rejects.toThrow(InvalidPathError);
  });
});

/**
 * Whether this platform lets us create a symlink.
 *
 * Probed at module scope, not in `beforeAll`. `it.skipIf` is evaluated while
 * tests are being collected, which happens *before* any hook runs, so a flag
 * set in `beforeAll` is still false at that point and the tests would skip on
 * every platform, including the Linux CI runner that can create links fine.
 */
const symlinksAvailable = await (async () => {
  const base = await mkdtemp(join(tmpdir(), 'gearvane-link-probe-'));
  try {
    await symlink(join(base, 'target'), join(base, 'link'));
    return true;
  } catch {
    // Windows without Developer Mode or elevation returns EPERM here.
    return false;
  }
})();

describe('symbolic link escapes', () => {
  /**
   * Skipped on Windows, which needs Developer Mode to create a link. The logic
   * itself is covered portably in the next block by injecting the resolver,
   * which is the part that can actually be wrong.
   */
  const maybe = (name: string, fn: () => Promise<void>): void => {
    it.skipIf(!symlinksAvailable)(name, fn);
  };

  maybe('rejects a file symlink pointing outside the workspace', async () => {
    const link = join(root, 'escape.txt');
    await symlink(join(outside, 'key.txt'), link);

    // The lexical path is inside the workspace. Only resolving the link's
    // real target catches this, which is why the check exists.
    await expect(workspace.resolve('escape.txt')).rejects.toThrow(
      ContainmentError,
    );
  });

  maybe('rejects a directory symlink pointing outside the workspace', async () => {
    await symlink(outside, join(root, 'linked'), 'dir');

    await expect(workspace.resolve('linked/key.txt')).rejects.toThrow(
      ContainmentError,
    );
  });

  maybe('allows a symlink that stays inside the workspace', async () => {
    await symlink(join(root, 'src'), join(root, 'inside'), 'dir');

    const resolved = await workspace.resolve('inside/index.ts');
    expect(resolved).toBe(join(root, 'inside', 'index.ts'));
  });

  maybe('reports the escape as a containment failure, not a missing file', async () => {
    await symlink(outside, join(root, 'linked'), 'dir');

    // The distinction matters: a model that gets "no such file" will retry or
    // invent a path, while a containment error tells it to stop.
    await expect(workspace.resolve('linked/key.txt')).rejects.toThrow(
      /symbolic link/i,
    );
  });
});

describe('symbolic link escapes, with an injected resolver', () => {
  /**
   * The same escapes, tested on every platform.
   *
   * The resolver is told that specific paths are links pointing elsewhere,
   * which is exactly the input the real filesystem would produce. Testing the
   * decision logic here means it is verified even on a machine that cannot
   * create a symlink.
   */
  const linksToOutside = (linkPath: string, realTarget: string) => {
    return async (target: string): Promise<string> => {
      if (target === linkPath) return realTarget;
      if (target.startsWith(`${linkPath}/`) || target.startsWith(`${linkPath}\\`)) {
        return `${realTarget}${target.slice(linkPath.length)}`;
      }
      return target;
    };
  };

  it('rejects a path whose link resolves outside', async () => {
    const link = join(root, 'escape.txt');
    const ws = new Workspace(root, {
      realpath: linksToOutside(link, join(outside, 'key.txt')),
    });

    await expect(ws.resolve('escape.txt')).rejects.toThrow(ContainmentError);
  });

  it('rejects a file reached through a link directory', async () => {
    const link = join(root, 'linked');
    const ws = new Workspace(root, {
      realpath: linksToOutside(link, outside),
    });

    await expect(ws.resolve('linked/key.txt')).rejects.toThrow(ContainmentError);
  });

  it('rejects traversal that leaves and returns through a link', async () => {
    // The nastiest shape: the path goes out and comes back, so every purely
    // lexical check believes it is inside.
    const link = join(root, 'linked');
    const ws = new Workspace(root, {
      realpath: linksToOutside(link, outside),
    });

    await expect(ws.resolve('linked/../linked/key.txt')).rejects.toThrow(
      ContainmentError,
    );
  });

  it('names the symbolic link as the reason', async () => {
    const link = join(root, 'escape.txt');
    const ws = new Workspace(root, {
      realpath: linksToOutside(link, join(outside, 'key.txt')),
    });

    await expect(ws.resolve('escape.txt')).rejects.toThrow(/symbolic link/i);
  });

  it('allows a link that resolves back inside the workspace', async () => {
    const link = join(root, 'inside');
    const ws = new Workspace(root, {
      realpath: linksToOutside(link, join(root, 'src')),
    });

    expect(await ws.resolve('inside/index.ts')).toBe(
      join(root, 'inside', 'index.ts'),
    );
  });

  it('anchors containment to the real root when the root is itself a link', async () => {
    // If the workspace root is a symlink, the real tree is what governs, not
    // the path the caller happened to configure. Anything under the link
    // target is legitimately reachable, and the real root must be obtained
    // through the resolver for that to hold.
    const asked: string[] = [];
    const ws = new Workspace(root, {
      realpath: (target) => {
        asked.push(target);
        return Promise.resolve(linksToOutside(root, outside)(target));
      },
    });

    expect(await ws.realRoot()).toBe(outside);
    expect(asked).toContain(root);

    // Lexically inside root, and genuinely inside the real root too.
    expect(await ws.allows('src/index.ts')).toBe(true);
  });
});

describe('Workspace helpers', () => {
  it('allows() answers without throwing', async () => {
    expect(await workspace.allows('src/index.ts')).toBe(true);
    expect(await workspace.allows('../secrets/key.txt')).toBe(false);
  });

  it('toRelative inverts resolve', async () => {
    const absolute = await workspace.resolve('src/index.ts');
    // Compared with join() rather than a literal, because Windows separators
    // differ and this test runs on both.
    expect(workspace.toRelative(absolute)).toBe(join('src', 'index.ts'));
  });

  it('toRelative reports the root as .', () => {
    expect(workspace.toRelative(root)).toBe('.');
  });

  it('exposes its root as an absolute path', () => {
    expect(workspace.root).toBe(root);
  });

  it('rejects an empty root', () => {
    expect(() => new Workspace('  ')).toThrow(InvalidPathError);
  });

  it('resolves a relative root against the process directory', () => {
    const relativeRoot = new Workspace('.');
    expect(relativeRoot.root).toBe(process.cwd());
  });
});

describe('lexical-only checking', () => {
  it('accepts a link path when the symlink pass is disabled', async () => {
    // Deliberately weaker, and only for the tests that are about the lexical
    // check. The default is to follow links.
    const lexical = new Workspace(root, { followSymlinks: false });
    const ws = new Workspace(root, {
      followSymlinks: false,
      realpath: async () => {
        throw new Error('must not be called when the symlink pass is off');
      },
    });

    expect(await lexical.allows('escape.txt')).toBe(true);
    expect(await ws.allows('escape.txt')).toBe(true);
  });

  it('still rejects lexical traversal when the symlink pass is disabled', async () => {
    const lexical = new Workspace(root, { followSymlinks: false });
    expect(await lexical.allows('../secrets/key.txt')).toBe(false);
  });
});