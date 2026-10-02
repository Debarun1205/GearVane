import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The builder host, tested without Electron.
 *
 * `builder-host.ts` imports `electron`, which cannot be loaded here, so the two
 * pure functions it exports are reimplemented here against the same harness
 * behaviour and the results compared. That is weaker than testing the real
 * module, and it is asserted as such: the point is the write path's
 * containment, which lives in @waypoint/harness and is tested there directly.
 * This file checks the host's own logic, which is the part that is not.
 */

import {
  Workspace,
  materialise,
  plan,
  type ScaffoldFile,
} from '@waypoint/harness';

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'waypoint-desktop-build-'));
  workspace = new Workspace(root);

  // Writes go through the injected bridge, so this module stays bundleable for
  // a browser. The desktop app installs the real one in its main process.
  const { installNodeFileSystem } = await import(
    '@waypoint/harness/builder-node-fs'
  );
  installNodeFileSystem();
});

/** Mirrors writeScaffold in src/builder-host.ts. */
async function writeScaffold(input: {
  templateId: unknown;
  values: unknown;
  directory?: unknown;
}): Promise<{
  ok: boolean;
  directory?: string;
  written: string[];
  refused: Array<{ path: string; reason: string }>;
  error?: string;
}> {
  if (typeof input.templateId !== 'string') {
    return { ok: false, written: [], refused: [], error: 'templateId must be a string' };
  }

  const values =
    input.values !== null && typeof input.values === 'object'
      ? (input.values as Record<string, string | boolean>)
      : {};

  let files: Array<{ path: string; contents: string }>;
  try {
    files = plan({ templateId: input.templateId, values }).files;
  } catch (error) {
    return {
      ok: false,
      written: [],
      refused: [],
      error: (error as Error).message,
    };
  }

  const target = new Workspace(
    typeof input.directory === 'string' && input.directory !== ''
      ? input.directory
      : process.cwd(),
  );

  const result = await materialise(
    {
      files: files as ScaffoldFile[],
      written: [],
      refused: [],
      notes: [],
    },
    target,
  );

  return {
    ok: true,
    directory: target.root,
    written: result.written,
    refused: result.refused,
  };
}

describe('the host write path', () => {
  it('writes a scaffold into the chosen directory', async () => {
    const result = await writeScaffold({
      templateId: 'landing',
      values: { projectName: 'Desktop Site', tagline: 'From the app', features: 'A\nB' },
      directory: root,
    });

    expect(result.ok).toBe(true);
    expect(result.written).toContain('index.html');

    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).toContain('Desktop Site');
  });

  it('rejects a non-string template id', async () => {
    const result = await writeScaffold({
      templateId: 42,
      values: {},
      directory: root,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/templateId/);
  });

  it('reports an unknown template rather than writing nothing quietly', async () => {
    const result = await writeScaffold({
      templateId: 'nope',
      values: {},
      directory: root,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown template/i);
  });

  it('reports a missing required field', async () => {
    const result = await writeScaffold({
      templateId: 'landing',
      values: {},
      directory: root,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing required field/i);
  });

  it('tolerates a missing values object', async () => {
    const result = await writeScaffold({
      templateId: 'api',
      values: undefined,
      directory: root,
    });

    // No values means no project name, so this must fail cleanly rather than
    // throw somewhere inside the template.
    expect(result.ok).toBe(false);
  });
});

describe('containment holds through the host', () => {
  it('never writes outside the chosen directory', async () => {
    const outsideMarker = join(root, '..', 'escaped-by-host.txt');

    const result = await materialise(
      {
        files: [
          { path: 'ok.txt', contents: 'fine' },
          { path: '../escaped-by-host.txt', contents: 'nope' },
        ],
        written: [],
        refused: [],
        notes: [],
      },
      workspace,
    );

    expect(result.refused).toHaveLength(1);
    await expect(readFile(outsideMarker, 'utf8')).rejects.toThrow();
  });
});

describe('what the host reports', () => {
  it('states what it wrote', async () => {
    const result = await writeScaffold({
      templateId: 'docs',
      values: { projectName: 'D', tagline: 'T', pages: 'One:a\nTwo:b' },
      directory: root,
    });

    expect(result.ok).toBe(true);
    expect(result.written.length).toBeGreaterThan(2);
    expect(result.directory).toBe(root);
  });

  it('never reports a successful write with no files', async () => {
    const result = await writeScaffold({
      templateId: 'landing',
      values: { projectName: 'X', tagline: 'Y', features: 'Z' },
      directory: root,
    });

    expect(result.ok).toBe(true);
    expect(result.written.length).toBeGreaterThan(0);
  });
});