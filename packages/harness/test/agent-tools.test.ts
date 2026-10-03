import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace/containment.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import {
  builderTools,
  listTemplatesTool,
  scaffoldProjectTool,
} from '../src/builder/agent-tools.js';

/**
 * Agent scaffold tool tests.
 *
 * These go through the ToolRegistry rather than calling the tools directly,
 * because that is the path the agent loop uses — including argument
 * validation, which is where a model-shaped input differs from a
 * programmer-shaped one.
 */

let root: string;
let ctx: ToolContext;
let registry: ToolRegistry;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'waypoint-agent-build-'));

  // Same pattern as builder.test.ts: the write half needs a real filesystem.
  const { installNodeFileSystem } = await import('../src/builder/node-fs.js');
  installNodeFileSystem();

  ctx = {
    workspace: new Workspace(root),
    maxReadBytes: 256 * 1024,
  };
  registry = new ToolRegistry(builderTools());
});

describe('list_templates', () => {
  it('is registered under its advertised name', () => {
    expect(registry.has('list_templates')).toBe(true);
  });

  it('lists every template with its fields', async () => {
    const result = await registry.execute('list_templates', {}, ctx);

    expect(result.ok).toBe(true);
    const listed = JSON.parse(result.content) as Array<{
      id: string;
      name: string;
      fields: Array<{ key: string; required: boolean }>;
    }>;

    expect(listed.map((entry) => entry.id).sort()).toEqual([
      'api',
      'docs',
      'landing',
    ]);

    const landing = listed.find((entry) => entry.id === 'landing');
    expect(landing?.fields.map((field) => field.key)).toContain('projectName');
  });

  it('marks which fields are required', async () => {
    const result = await registry.execute('list_templates', {}, ctx);
    const listed = JSON.parse(result.content) as Array<{
      id: string;
      fields: Array<{ key: string; required: boolean }>;
    }>;

    const landing = listed.find((entry) => entry.id === 'landing');
    const name = landing?.fields.find((field) => field.key === 'projectName');
    expect(name?.required).toBe(true);
  });
});

describe('scaffold_project', () => {
  it('is registered under its advertised name', () => {
    expect(registry.has('scaffold_project')).toBe(true);
  });

  it('writes a project into the workspace', async () => {
    const result = await registry.execute(
      'scaffold_project',
      {
        template: 'landing',
        values: {
          projectName: 'Agent Site',
          tagline: 'Built by a model',
          features: 'One\nTwo',
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain('wrote index.html');

    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).toContain('Agent Site');
  });

  it('reports an unknown template without throwing', async () => {
    const result = await registry.execute(
      'scaffold_project',
      { template: 'nope', values: {} },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('unknown template');
    expect(result.content).toContain('list_templates');
  });

  it('reports a missing required value', async () => {
    const result = await registry.execute(
      'scaffold_project',
      { template: 'landing', values: { projectName: 'Only a name' } },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/missing required field/i);
  });

  it('rejects a non-object values argument', async () => {
    // Caught by schema validation before the tool itself runs, so the message
    // names the argument and the expected type rather than the tool's own
    // wording. Either way the model gets something actionable.
    const result = await registry.execute(
      'scaffold_project',
      { template: 'landing', values: 'just a string' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/values/);
    expect(result.content).toMatch(/object/);
  });

  it('rejects a missing template argument', async () => {
    const result = await registry.execute(
      'scaffold_project',
      { values: {} },
      ctx,
    );

    expect(result.ok).toBe(false);
  });

  it('coerces numbers to strings', async () => {
    // Models emit port: 3000 far more often than port: "3000".
    const result = await registry.execute(
      'scaffold_project',
      {
        template: 'api',
        values: { projectName: 'Port API', resource: 'widget', port: 8080 },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    const server = await readFile(join(root, 'server.js'), 'utf8');
    expect(server).toContain('8080');
  });

  it('rejects an object value rather than stringifying it', async () => {
    const result = await registry.execute(
      'scaffold_project',
      {
        template: 'landing',
        values: {
          projectName: 'X',
          tagline: 'Y',
          features: { nested: 'object' },
        },
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('must be a string, boolean, or number');
  });

  it('refuses to overwrite by default', async () => {
    const args = {
      template: 'landing',
      values: {
        projectName: 'X',
        tagline: 'Y',
        features: 'Z',
      },
    };

    const first = await registry.execute('scaffold_project', args, ctx);
    expect(first.ok).toBe(true);

    const second = await registry.execute('scaffold_project', args, ctx);
    expect(second.ok).toBe(false);
    expect(second.content).toContain('refused');
  });

  it('overwrites when asked', async () => {
    const args = {
      template: 'landing',
      values: {
        projectName: 'X',
        tagline: 'Y',
        features: 'Z',
      },
    };

    await registry.execute('scaffold_project', args, ctx);
    const second = await registry.execute(
      'scaffold_project',
      { ...args, overwrite: true },
      ctx,
    );

    expect(second.ok).toBe(true);
  });

  it('cannot escape the workspace through values', async () => {
    // Values are interpolated as text, never as paths, so even a hostile
    // project name stays inside.
    const result = await registry.execute(
      'scaffold_project',
      {
        template: 'landing',
        values: {
          projectName: '../../escaped',
          tagline: 'Y',
          features: 'Z',
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);

    const { readdir } = await import('node:fs/promises');
    const parent = join(root, '..');
    const siblings = await readdir(parent);
    expect(siblings).not.toContain('escaped');
  });

  it('escapes hostile values in generated HTML', async () => {
    await registry.execute(
      'scaffold_project',
      {
        template: 'landing',
        values: {
          projectName: '<script>alert(1)</script>',
          tagline: 'Y',
          features: 'Z',
        },
      },
      ctx,
    );

    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('builderTools', () => {
  it('returns both tools', () => {
    expect(builderTools().map((tool) => tool.schema.name).sort()).toEqual([
      'list_templates',
      'scaffold_project',
    ]);
  });

  it('matches the directly imported tools', () => {
    expect(builderTools()).toContain(listTemplatesTool);
    expect(builderTools()).toContain(scaffoldProjectTool);
  });
});
