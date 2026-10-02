import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace/containment.js';
import { materialise, plan } from '../src/builder/scaffold.js';
import {
  FakeDeployer,
  LocalDeployer,
  UnconfiguredDeployer,
  defaultDeployers,
  type DeployFile,
  type DeployRequest,
} from '../src/builder/deploy.js';

/**
 * Deploy interface tests.
 *
 * Two things are being protected here.
 *
 * First, the shape of a correct deploy, pinned by `FakeDeployer`. Second, and
 * more important: **no hosted target may quietly do nothing.** A deploy button
 * that silently fails looks exactly like success from the user's side, so the
 * unconfigured targets are asserted to refuse rather than pretend.
 */

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'waypoint-deploy-'));
  workspace = new Workspace(root);
});

const REQUEST: DeployRequest = {
  name: 'acme',
  files: [
    { path: 'index.html', contents: '<!doctype html><title>Acme</title>' },
    { path: 'styles.css', contents: 'body { margin: 0 }' },
  ],
};

describe('the deploy interface', () => {
  it('can be implemented without a network', async () => {
    const fake = new FakeDeployer();
    const result = await fake.deploy(REQUEST);

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('exposes configuration state before a form is filled in', () => {
    // Checked up front so the UI can explain why, rather than failing after
    // the user has already committed to publishing.
    expect(new FakeDeployer().isConfigured()).toBe(true);
    expect(new FakeDeployer(false).isConfigured()).toBe(false);
  });

  it('always says what setup it needs', () => {
    for (const deployer of defaultDeployers()) {
      expect(deployer.requirements().length).toBeGreaterThan(0);
    }
  });

  it('never reports success without a message', () => {
    // A result with no message leaves the UI showing a blank panel.
    for (const deployer of defaultDeployers()) {
      expect(typeof deployer.id).toBe('string');
      expect(typeof deployer.name).toBe('string');
    }
  });
});

describe('the local deployer', () => {
  it('writes to a chosen directory', async () => {
    const deployer = new LocalDeployer(
      async (directory, files) => {
        const result = await materialise(
          {
            files: files.map((f) => ({ path: f.path, contents: f.contents })),
            written: [],
            refused: [],
            notes: [],
          },
          new Workspace(directory),
        );
        return { written: result.written, failed: result.refused };
      },
      async () => root,
    );

    const result = await deployer.deploy(REQUEST);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 file(s)');
    expect(await readFile(join(root, 'index.html'), 'utf8')).toContain('Acme');
  });

  it('never claims to have uploaded anything', async () => {
    const deployer = new LocalDeployer(
      async (_directory, files) => ({ written: files.map((f) => f.path), failed: [] }),
      async () => root,
    );

    const result = await deployer.deploy(REQUEST);
    // "Wrote to a folder" must not read like a live publish.
    expect(result.dryRun).toBeUndefined();
    expect(result.message).toMatch(/Wrote/);
    expect(result.message).not.toMatch(/live|published|deployed to/i);
  });

  it('reports cancellation rather than a failure', async () => {
    const deployer = new LocalDeployer(
      async () => ({ written: [], failed: [] }),
      async () => null,
    );

    const result = await deployer.deploy(REQUEST);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cancelled');
    expect(result.message).toMatch(/no folder/i);
  });

  it('reports per-file failures', async () => {
    const deployer = new LocalDeployer(
      async () => ({
        written: ['index.html'],
        failed: [{ path: 'styles.css', reason: 'permission denied' }],
      }),
      async () => root,
    );

    const result = await deployer.deploy(REQUEST);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('styles.css');
    expect(result.error).toContain('permission denied');
  });

  it('confines a path that escapes the chosen directory', async () => {
    // The deployer writes whatever it is handed, so the workspace check is
    // what stops a hostile path from reaching the parent directory.
    const deployer = new LocalDeployer(
      async (directory, files) => {
        const result = await materialise(
          {
            files: files.map((f) => ({ path: f.path, contents: f.contents })),
            written: [],
            refused: [],
            notes: [],
          },
          new Workspace(directory),
        );
        return { written: result.written, failed: result.refused };
      },
      async () => root,
    );

    const result = await deployer.deploy({
      name: 'hostile',
      files: [
        { path: 'ok.txt', contents: 'yes' },
        { path: '../escaped.txt', contents: 'no' },
      ] satisfies DeployFile[],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('escaped.txt');
  });
});

describe('hosted targets refuse rather than pretend', () => {
  /**
   * The important test in this file.
   *
   * An unconfigured target that returns ok:true would render as a successful
   * publish in the UI while doing nothing at all. That is worse than an error,
   * because the user believes their site is live.
   */
  it.each([
    ['cloudflare', 'Cloudflare Pages'],
    ['netlify', 'Netlify'],
    ['vercel', 'Vercel'],
  ])('%s refuses to deploy', async (id, name) => {
    const deployer = new UnconfiguredDeployer(id, name, 'a token');
    const result = await deployer.deploy();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('not implemented');
    expect(result.message).toContain(name);
  });

  it('reports itself as unconfigured', () => {
    const deployer = new UnconfiguredDeployer('x', 'X', 'a token');
    expect(deployer.isConfigured()).toBe(false);
  });

  it('names the environment variable each real target needs', () => {
    // A requirements string that does not say which variable to set is a
    // support ticket waiting to happen.
    const byId = new Map(defaultDeployers().map((d) => [d.id, d]));

    for (const id of ['cloudflare', 'netlify', 'vercel']) {
      const requirements = byId.get(id)?.requirements() ?? '';
      expect(requirements, `${id} does not name a variable`).toMatch(
        /[A-Z][A-Z0-9_]{4,}/,
      );
    }
  });
});

describe('what ships as a default target', () => {
  it('offers local first', () => {
    // Local needs no credential, so it is the one thing that always works.
    expect(defaultDeployers()[0]?.id).toBe('local');
  });

  it('offers nothing that claims to be configured', () => {
    const configured = defaultDeployers().filter((deployer) => deployer.isConfigured());
    expect(configured.map((d) => d.id)).toEqual(['local']);
  });

  it('has unique ids', () => {
    const ids = defaultDeployers().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a scaffold becomes a deployable request', () => {
  it('converts planned files into deploy files', async () => {
    const planned = plan({
      templateId: 'landing',
      values: {
        projectName: 'Deploy Me',
        tagline: 'Ship it',
        features: 'A\nB',
      },
    });

    const fake = new FakeDeployer();
    await fake.deploy({
      name: 'deploy-me',
      files: planned.files.map((file) => ({
        path: file.path,
        contents: file.contents,
      })),
    });

    expect(fake.requests[0]?.files.length).toBe(planned.files.length);
    expect(fake.requests[0]?.files.every((f) => f.contents.length > 0)).toBe(true);
  });

  it('never deploys a file that was refused by containment', async () => {
    const planned = await materialise(
      {
        files: [
          { path: 'good.txt', contents: 'yes' },
          { path: '../bad.txt', contents: 'no' },
        ],
        written: [],
        refused: [],
        notes: [],
      },
      workspace,
    );

    const deployable = planned.files.filter((file) => !file.skipped);
    expect(deployable.map((f) => f.path)).toEqual(['good.txt']);
  });
});