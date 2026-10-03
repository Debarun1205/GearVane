import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace/containment.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { searchFilesTool } from '../src/tools/search.js';

/**
 * Search tool tests.
 *
 * The properties under test are the ones that cost context when wrong: caps
 * that hold, directories that stay skipped, binary files that stay unread,
 * and paths that stay inside the workspace.
 */

let root: string;
let ctx: ToolContext;
let registry: ToolRegistry;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'waypoint-search-'));
  root = join(base, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });

  await writeFile(join(root, 'src', 'a.ts'), 'export const alpha = 1;\n// alpha beta\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const beta = 2;\n');
  await writeFile(join(root, 'README.md'), '# Alpha project\n');
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'alpha in deps\n');
  await writeFile(join(root, '.git', 'HEAD'), 'alpha in git\n');

  ctx = { workspace: new Workspace(root), maxReadBytes: 256 * 1024 };
  registry = new ToolRegistry([searchFilesTool]);
});

async function search(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
  const result = await registry.execute('search_files', args, ctx);
  return { ok: result.ok, content: result.content };
}

describe('search_files', () => {
  it('finds matches with path:line format', async () => {
    const result = await search({ query: 'alpha' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/a.ts:1:');
    expect(result.content).toContain('src/a.ts:2:');
    expect(result.content).toContain('README.md:1:');
  });

  it('matches case-insensitively by default', async () => {
    const result = await search({ query: 'ALPHA' });
    expect(result.content).toContain('src/a.ts:1:');
  });

  it('matches case-sensitively when asked', async () => {
    const lower = await search({ query: 'ALPHA', caseSensitive: true });
    expect(lower.content).toContain('No matches');

    // 'Alpha' with capital A appears in README.md.
    const exact = await search({ query: 'Alpha', caseSensitive: true });
    expect(exact.content).toContain('README.md:1:');
  });

  it('says so when nothing matches', async () => {
    const result = await search({ query: 'zzz-no-such-token' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('No matches');
  });

  it('never descends into dependency or build directories', async () => {
    const result = await search({ query: 'alpha' });
    expect(result.content).not.toContain('node_modules');
    expect(result.content).not.toContain('.git/');
  });

  it('scopes to a subdirectory', async () => {
    // README.md matches but is outside src/.
    const result = await search({ query: 'alpha', directory: 'src' });
    expect(result.content).toContain('src/a.ts');
    expect(result.content).not.toContain('README.md');
  });

  it('refuses a directory outside the workspace', async () => {
    const result = await search({ query: 'alpha', directory: '..' });
    expect(result.ok).toBe(false);
  });

  it('caps the result count', async () => {
    await writeFile(join(root, 'many.txt'), `${'needle\n'.repeat(100)}`);
    const result = await search({ query: 'needle', maxResults: 5 });

    const lines = result.content.split('\n').filter((line) => line.includes('many.txt'));
    expect(lines).toHaveLength(5);
    expect(result.content).toContain('truncated');
  });

  it('never exceeds the hard cap', async () => {
    await writeFile(join(root, 'many.txt'), `${'needle\n'.repeat(500)}`);
    // maxResults above the cap is clamped by schema validation... or by the
    // tool; either way the output stays bounded.
    const result = await search({ query: 'needle', maxResults: 200 });
    const lines = result.content.split('\n').filter((line) => line.includes('many.txt'));
    expect(lines.length).toBeLessThanOrEqual(200);
  });

  it('skips binary files', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x6c, 0x70, 0x68, 0x61]));
    const result = await search({ query: 'alpha' });
    expect(result.content).not.toContain('blob.bin');
  });

  it('skips oversized files', async () => {
    // 600KB of matches: over the per-file cap, so the file is skipped rather
    // than read.
    await writeFile(join(root, 'huge.txt'), 'needle '.repeat(100_000));
    const result = await search({ query: 'needle' });
    expect(result.content).not.toContain('huge.txt');
  });

  it('truncates very long lines', async () => {
    await writeFile(join(root, 'wide.txt'), `${'x'.repeat(500)}needle${'y'.repeat(500)}\n`);
    const result = await search({ query: 'needle' });
    const line = result.content.split('\n').find((l) => l.includes('wide.txt')) ?? '';
    expect(line.length).toBeLessThan(400);
    expect(line).toContain('…');
  });

  it('rejects an empty query', async () => {
    const result = await search({ query: '' });
    expect(result.ok).toBe(false);
  });

  it('treats metacharacters as literal text', async () => {
    // Plain substring, not regex: 'a.c' must not match 'abc'.
    await writeFile(join(root, 'dots.txt'), 'a.c literal\nabc other\n');
    const result = await search({ query: 'a.c' });
    expect(result.content).toContain('dots.txt:1:');
    expect(result.content).not.toContain('dots.txt:2:');
  });
});
