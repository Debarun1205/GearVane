import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  listFiles,
  readTextFile,
  removeFile,
  writeTextFile,
} from '../src/ide/fs-store.js';

/**
 * IDE filesystem tests.
 *
 * These run in Node against the real filesystem, which is exactly the
 * environment the main process provides. The renderer never imports this
 * module: it reaches the same operations through the `ideFs` preload bridge,
 * and a test in desktop.test.ts asserts the bundle stays free of `node:`
 * imports so the webview keeps loading.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'waypoint-ide-fs-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# project\n');
});

describe('listFiles', () => {
  it('lists files and directories', async () => {
    const entries = await listFiles(root);
    const paths = entries.map((entry) => entry.path);

    expect(paths).toContain('src');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('README.md');
  });

  it('marks directories', async () => {
    const entries = await listFiles(root);
    const src = entries.find((entry) => entry.path === 'src');

    expect(src?.isDirectory).toBe(true);
  });

  it('reports file sizes', async () => {
    const entries = await listFiles(root);
    const readme = entries.find((entry) => entry.path === 'README.md');

    expect(readme?.size).toBeGreaterThan(0);
  });

  it('skips dependency and build directories', async () => {
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'x');
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref: main');

    const paths = (await listFiles(root)).map((entry) => entry.path);

    expect(paths).not.toContain('node_modules');
    expect(paths).not.toContain('node_modules/dep/index.js');
    expect(paths).not.toContain('.git');
  });

  it('returns an empty list for an unreadable root', async () => {
    // A missing directory is skipped, not thrown: the tree shows nothing
    // rather than the whole IDE failing to mount.
    expect(await listFiles(join(root, 'nope'))).toEqual([]);
  });

  it('caps runaway listings', async () => {
    await mkdir(join(root, 'many'), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(root, 'many', `f${index}.txt`), 'x');
    }

    const entries = await listFiles(root, { maxEntries: 5 });
    expect(entries.length).toBeLessThanOrEqual(5);
  });

  it('skips a symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'waypoint-ide-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');

    try {
      await symlink(outside, join(root, 'linked'), 'dir');
    } catch {
      // Windows without Developer Mode cannot create links. The injected
      // resolver suite in the harness covers the logic portably.
      return;
    }

    const paths = (await listFiles(root)).map((entry) => entry.path);
    expect(paths).not.toContain('linked');
    expect(paths).not.toContain('linked/secret.txt');
  });
});

describe('readTextFile', () => {
  it('reads a file', async () => {
    const result = await readTextFile(root, 'README.md');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('# project\n');
  });

  it('reports a missing file', async () => {
    const result = await readTextFile(root, 'missing.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no such file/i);
  });

  it('refuses a directory', async () => {
    const result = await readTextFile(root, 'src');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/directory/);
  });

  it('refuses a path outside the workspace', async () => {
    const result = await readTextFile(root, '../outside.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workspace/i);
  });

  it('refuses an absolute path outside the workspace', async () => {
    const result = await readTextFile(root, '/etc/hostname');
    expect(result.ok).toBe(false);
  });

  it('enforces the byte cap', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(1000));
    const result = await readTextFile(root, 'big.txt', 100);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/over the 100 byte limit/);
  });
});

describe('writeTextFile', () => {
  it('writes a file', async () => {
    const result = await writeTextFile(root, 'new.txt', 'hello');
    expect(result.ok).toBe(true);

    const read = await readTextFile(root, 'new.txt');
    expect(read.content).toBe('hello');
  });

  it('creates missing parents', async () => {
    // Saving a new file into a new folder is normal IDE behaviour.
    const result = await writeTextFile(root, 'a/b/c.txt', 'deep');
    expect(result.ok).toBe(true);

    const read = await readTextFile(root, 'a/b/c.txt');
    expect(read.content).toBe('deep');
  });

  it('overwrites an existing file', async () => {
    await writeTextFile(root, 'README.md', 'replaced');
    const read = await readTextFile(root, 'README.md');
    expect(read.content).toBe('replaced');
  });

  it('refuses a path outside the workspace', async () => {
    const result = await writeTextFile(root, '../escaped.txt', 'nope');
    expect(result.ok).toBe(false);
  });
});

describe('removeFile', () => {
  it('deletes a file', async () => {
    const result = await removeFile(root, 'README.md');
    expect(result.ok).toBe(true);

    const read = await readTextFile(root, 'README.md');
    expect(read.ok).toBe(false);
  });

  it('reports a file that is already gone', async () => {
    const result = await removeFile(root, 'missing.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no such file/i);
  });

  it('refuses a directory', async () => {
    // Reverting a created file must not take a directory with it because a
    // path was misbuilt.
    const result = await removeFile(root, 'src');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a file/i);
  });

  it('refuses a path outside the workspace', async () => {
    const result = await removeFile(root, '../escaped.txt');
    expect(result.ok).toBe(false);
  });
});
