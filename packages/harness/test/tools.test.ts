import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace/containment.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  DEFAULT_MAX_READ_BYTES,
  editFileTool,
  fileTools,
  listDirTool,
  mkdirTool,
  readFileTool,
  writeFileTool,
} from '../src/tools/fs.js';
import type { ToolContext } from '../src/tools/types.js';

let root: string;
let outside: string;
let ctx: ToolContext;

async function read(target: string): Promise<string> {
  const result = await readFileTool.execute({ path: target }, ctx);
  expect(result.ok).toBe(true);
  return result.content;
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'gearvane-tools-'));
  root = join(base, 'project');
  outside = join(base, 'secrets');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'key.txt'), 'SECRET\n');
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  ctx = {
    workspace: new Workspace(root),
    maxReadBytes: DEFAULT_MAX_READ_BYTES,
  };
});

describe('read_file', () => {
  it('returns numbered lines', async () => {
    const content = await read('src/a.ts');
    expect(content).toContain('1\texport const a = 1;');
    expect(content).toContain('2\texport const b = 2;');
  });

  it('reports the total line count', async () => {
    expect(await read('src/a.ts')).toContain('of 2');
  });

  it('honours offset and limit', async () => {
    const result = await readFileTool.execute(
      { path: 'src/a.ts', offset: 2, limit: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('2\texport const b = 2;');
    expect(result.content).not.toContain('export const a');
  });

  it('says when more lines remain', async () => {
    const result = await readFileTool.execute({ path: 'src/a.ts', limit: 1 }, ctx);
    expect(result.content).toContain('1 more line not shown');
  });

  it('does not count a trailing newline as an extra line', async () => {
    // Regression: splitting "a\nb\n" on '\n' yields three entries, so every
    // read of a well-formed file reported one phantom line and the model's
    // line references drifted by one on each edit.
    expect(await read('src/a.ts')).toContain('of 2');
    expect(await read('src/a.ts')).not.toContain('of 3');
  });

  it('handles a file with no trailing newline', async () => {
    await writeFile(join(root, 'no-newline.txt'), 'one\ntwo');
    const content = await read('no-newline.txt');
    expect(content).toContain('of 2');
    expect(content).toContain('2\ttwo');
  });

  it('handles a completely empty file', async () => {
    await writeFile(join(root, 'empty.txt'), '');
    const result = await readFileTool.execute({ path: 'empty.txt' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('is empty');
  });

  it('reports an offset past the end', async () => {
    const result = await readFileTool.execute(
      { path: 'src/a.ts', offset: 99 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('past the end');
  });

  it('fails clearly on a missing file', async () => {
    const result = await readFileTool.execute({ path: 'nope.ts' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('no such file');
  });

  it('refuses a directory', async () => {
    const result = await readFileTool.execute({ path: 'src' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('directory');
  });

  it('refuses to read outside the workspace', async () => {
    const result = await readFileTool.execute({ path: '../secrets/key.txt' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('escapes the workspace');
  });

  it('enforces the byte cap', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(5000));
    const small: ToolContext = { ...ctx, maxReadBytes: 100 };

    const result = await readFileTool.execute({ path: 'big.txt' }, small);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('over the 100 byte limit');
    // The message must tell the model what to do instead.
    expect(result.content).toContain('offset');
  });

  it('does not silently truncate at the cap', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(5000));
    const small: ToolContext = { ...ctx, maxReadBytes: 100 };

    const result = await readFileTool.execute({ path: 'big.txt' }, small);
    expect(result.content).not.toContain('xxx');
  });
});

describe('write_file', () => {
  it('creates a file', async () => {
    const result = await writeFileTool.execute(
      { path: 'src/new.ts', content: 'export const n = 1;\n' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(await read('src/new.ts')).toContain('export const n = 1;');
  });

  it('replaces existing contents entirely', async () => {
    await writeFileTool.execute({ path: 'src/a.ts', content: 'replaced\n' }, ctx);
    expect(await read('src/a.ts')).toContain('replaced');
  });

  it('refuses to write outside the workspace', async () => {
    const result = await writeFileTool.execute(
      { path: '../secrets/pwned.txt', content: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('escapes the workspace');
  });

  it('refuses to create a missing directory', async () => {
    const result = await writeFileTool.execute(
      { path: 'nope/deep/file.ts', content: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('does not exist');
  });

  it('requires content', async () => {
    const result = await writeFileTool.execute({ path: 'src/a.ts' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('content is required');
  });
});

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    const result = await editFileTool.execute(
      {
        path: 'src/a.ts',
        oldText: 'export const a = 1;',
        newText: 'export const a = 42;',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(await read('src/a.ts')).toContain('export const a = 42;');
  });

  it('leaves surrounding content intact', async () => {
    await editFileTool.execute(
      { path: 'src/a.ts', oldText: 'export const a = 1;', newText: 'X' },
      ctx,
    );
    expect(await read('src/a.ts')).toContain('export const b = 2;');
  });

  it('refuses an ambiguous edit rather than guessing', async () => {
    await writeFile(join(root, 'dup.txt'), 'same\nsame\nsame\n');

    const result = await editFileTool.execute(
      { path: 'dup.txt', oldText: 'same', newText: 'different' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('appears 3 times');
    // It must offer a way out, or the model is stuck.
    expect(result.content).toContain('replace_all');
  });

  it('replaces all when asked', async () => {
    await writeFile(join(root, 'dup.txt'), 'same\nsame\nsame\n');

    const result = await editFileTool.execute(
      { path: 'dup.txt', oldText: 'same', newText: 'different', replaceAll: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(await read('dup.txt')).not.toContain('same');
  });

  it('fails clearly when oldText is absent', async () => {
    const result = await editFileTool.execute(
      { path: 'src/a.ts', oldText: 'not present', newText: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('was not found');
  });

  it('refuses empty oldText', async () => {
    const result = await editFileTool.execute(
      { path: 'src/a.ts', oldText: '', newText: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('would match everywhere');
  });

  it('refuses to edit outside the workspace', async () => {
    const result = await editFileTool.execute(
      { path: '../secrets/key.txt', oldText: 'SECRET', newText: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('escapes the workspace');
  });

  it('leaves the file untouched when the edit fails', async () => {
    const before = await read('src/a.ts');
    await editFileTool.execute(
      { path: 'src/a.ts', oldText: 'absent', newText: 'x' },
      ctx,
    );
    expect(await read('src/a.ts')).toBe(before);
  });
});

describe('list_dir', () => {
  it('lists entries with directories first', async () => {
    await writeFile(join(root, 'zzz.txt'), 'z');
    await mkdir(join(root, 'aaa'), { recursive: true });

    const result = await listDirTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    const lines = result.content.split('\n');
    const firstFile = lines.findIndex((line) => line.startsWith('file'));
    const lastDir = lines.map((line) => line.startsWith('dir')).lastIndexOf(true);
    expect(lastDir).toBeLessThan(firstFile);
  });

  it('defaults to the workspace root', async () => {
    const result = await listDirTool.execute({}, ctx);
    expect(result.content).toContain('src');
  });

  it('reports sizes', async () => {
    const result = await listDirTool.execute({ path: 'src' }, ctx);
    expect(result.content).toMatch(/\(2\d+ bytes\)|bytes/);
  });

  it('reports an empty directory', async () => {
    await mkdir(join(root, 'empty'), { recursive: true });
    const result = await listDirTool.execute({ path: 'empty' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('is empty');
  });

  it('refuses to list outside the workspace', async () => {
    const result = await listDirTool.execute({ path: '../secrets' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('escapes the workspace');
  });
});

describe('mkdir', () => {
  it('creates a directory', async () => {
    const result = await mkdirTool.execute({ path: 'fresh' }, ctx);
    expect(result.ok).toBe(true);
    expect(await readFileTool.execute({ path: 'fresh/x.txt' }, ctx).then((r) => r.ok)).toBe(false);
  });

  it('creates missing parents', async () => {
    const result = await mkdirTool.execute({ path: 'a/b/c' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('is idempotent', async () => {
    await mkdirTool.execute({ path: 'twice' }, ctx);
    const result = await mkdirTool.execute({ path: 'twice' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('refuses to create outside the workspace', async () => {
    const result = await mkdirTool.execute({ path: '../evil' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('escapes the workspace');
  });
});

describe('tool registry', () => {
  it('exposes sorted schemas', () => {
    const registry = new ToolRegistry(fileTools());
    expect(registry.schemas().map((s) => s.name)).toEqual([
      'edit_file',
      'list_dir',
      'mkdir',
      'read_file',
      'write_file',
    ]);
  });

  it('refuses to register the same name twice', () => {
    const registry = new ToolRegistry([readFileTool]);
    expect(() => registry.register(readFileTool)).toThrow(/already registered/);
  });

  it('returns a helpful error for an unknown tool', async () => {
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute('teleport', {}, ctx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('no such tool "teleport"');
    // Naming the alternatives is what lets a model recover in one turn.
    expect(result.content).toContain('read_file');
  });

  it('validates arguments before running the tool', async () => {
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute('read_file', {}, ctx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('missing required argument: path');
  });

  it('rejects unexpected arguments', async () => {
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute(
      'read_file',
      { path: 'src/a.ts', sneaky: 'value' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('unexpected argument: sneaky');
  });

  it('coerces a numeric string', async () => {
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute(
      'read_file',
      { path: 'src/a.ts', limit: '1' },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a plain number for an integer parameter', async () => {
    // JSON has no integer type, so typeof any whole number is 'number'. An
    // earlier version of the validator rejected those and only accepted
    // numeric strings, which meant every integer parameter in every tool
    // failed for every real caller, models included.
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute(
      'read_file',
      { path: 'src/a.ts', limit: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a fractional number for an integer parameter', async () => {
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute(
      'read_file',
      { path: 'src/a.ts', limit: 1.5 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('should be integer but was number');
  });

  it('turns a throwing tool into a failed result', async () => {
    // An exception here would unwind the agent loop instead of letting the
    // model read the message and try again.
    const registry = new ToolRegistry([
      {
        schema: {
          name: 'explode',
          description: 'always throws',
          parameters: { type: 'object', properties: {} },
        },
        execute: async () => {
          throw new Error('kaboom');
        },
      },
    ]);

    const result = await registry.execute('explode', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('kaboom');
  });

  it('rejects a tool that returns no content', async () => {
    const registry = new ToolRegistry([
      {
        schema: {
          name: 'empty',
          description: 'returns nothing useful',
          parameters: { type: 'object', properties: {} },
        },
        execute: async () => ({ ok: true }) as never,
      },
    ]);

    const result = await registry.execute('empty', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('returned no content');
  });

  it('rejects non-object arguments', async () => {
    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute('read_file', 'src/a.ts', ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('must be an object');
  });

  it('runs several calls in order', async () => {
    const registry = new ToolRegistry(fileTools());
    const results = await registry.executeAll(
      [
        { name: 'list_dir', arguments: {} },
        { name: 'read_file', arguments: { path: 'nope.ts' } },
      ],
      ctx,
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
  });

  it('reports size and membership', () => {
    const registry = new ToolRegistry(fileTools());
    expect(registry.size).toBe(5);
    expect(registry.has('read_file')).toBe(true);
    expect(registry.names()).toEqual([
      'edit_file',
      'list_dir',
      'mkdir',
      'read_file',
      'write_file',
    ]);
  });

  it('does not run a tool after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const registry = new ToolRegistry(fileTools());
    const result = await registry.execute('read_file', { path: 'src/a.ts' }, {
      ...ctx,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('cancelled');
  });
});