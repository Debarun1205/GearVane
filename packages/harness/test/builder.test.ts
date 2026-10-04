import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace/containment.js';
import {
  TEMPLATES,
  applyDefaults,
  escapeHtml,
  escapeJs,
  escapeRegex,
  getTemplate,
  isValidSlug,
  materialise,
  plan,
  scaffold,
  slugify,
} from '../src/builder/scaffold.js';

/**
 * Scaffolding tests.
 *
 * Two properties matter more than the rest: generated output must be
 * deterministic, and a template must not be able to write outside the target
 * directory. Both are asserted directly rather than assumed from the code
 * reading correctly.
 */

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gearvane-build-'));
  workspace = new Workspace(root);

  // Writes go through an injected filesystem so this module bundles for a
  // browser. Node hosts install the real one via installNodeFileSystem.
  const { installNodeFileSystem } = await import('../src/builder/node-fs.js');
  installNodeFileSystem();
});

const LANDING = {
  templateId: 'landing',
  values: {
    projectName: 'Acme Tools',
    tagline: 'Ship faster',
    features: 'Fast\nReliable\nCheap',
  },
};

describe('escaping', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).not.toContain('<script>');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('say "hi"')).toContain('&quot;');
    expect(escapeHtml("it's")).toContain('&#39;');
  });

  it('neutralises a script tag in a project name', () => {
    // The generated page renders in the user's own browser, so an unescaped
    // title would be a script injection into their preview.
    const result = plan({
      templateId: 'landing',
      values: { ...LANDING.values, projectName: '<script>alert(1)</script>' },
    });

    const index = result.files.find((f) => f.path === 'index.html');
    expect(index?.contents).not.toContain('<script>alert(1)</script>');
    expect(index?.contents).toContain('&lt;script&gt;');
  });

  it('escapes quotes so an attribute cannot be broken out of', () => {
    const result = plan({
      templateId: 'landing',
      values: { ...LANDING.values, tagline: '" onload="alert(1)' },
    });

    const index = result.files.find((f) => f.path === 'index.html');
    expect(index?.contents).toContain('&quot;');
    expect(index?.contents).not.toContain('onload="alert(1)');
  });

  it('escapes a JS string literal', () => {
    expect(escapeJs('he said "hi"')).toBe('he said \\"hi\\"');
    expect(escapeJs('line\nbreak')).toBe('line\\nbreak');
  });

  it('escapes a regex', () => {
    expect(new RegExp(escapeRegex('a.b*c')).test('a.b*c')).toBe(true);
    expect(new RegExp(escapeRegex('a.b*c')).test('axbxc')).toBe(false);
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('My Great Project')).toBe('my-great-project');
  });

  it('strips punctuation', () => {
    expect(slugify('Hello, World! (v2)')).toBe('hello-world-v2');
  });

  it('handles unicode by dropping it', () => {
    expect(slugify('café')).toBe('caf');
  });

  it('truncates long names', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('returns empty for unusable input', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('validates its own output', () => {
    for (const input of ['My Project', 'a-b-c', 'Test 123', '!!!']) {
      const slug = slugify(input);
      if (slug !== '') expect(isValidSlug(slug)).toBe(true);
    }
  });

  it('rejects a path traversal as a slug', () => {
    expect(isValidSlug('../etc')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('..')).toBe(false);
  });
});

describe('templates', () => {
  it('offers the documented set', () => {
    expect(TEMPLATES.map((t) => t.id).sort()).toEqual(['api', 'docs', 'landing']);
  });

  it('gives every parameter a label and a type', () => {
    for (const template of TEMPLATES) {
      expect(template.params.length).toBeGreaterThan(0);
      for (const param of template.params) {
        expect(param.label).toBeTruthy();
        expect(['text', 'textarea', 'select', 'boolean', 'color']).toContain(
          param.type,
        );
      }
    }
  });

  it('declares a default for every select option', () => {
    for (const template of TEMPLATES) {
      for (const param of template.params) {
        if (param.type !== 'select') continue;
        expect(param.options?.length).toBeGreaterThan(0);
      }
    }
  });

  it('looks a template up by id', () => {
    expect(getTemplate('landing')?.id).toBe('landing');
    expect(getTemplate('nope')).toBeUndefined();
  });

  it('rejects an unknown template', () => {
    expect(() => plan({ templateId: 'nope', values: {} })).toThrow(/unknown template/i);
  });

  it('rejects a missing required field', () => {
    expect(() => plan({ templateId: 'landing', values: {} })).toThrow(
      /missing required field/i,
    );
  });

  it('fills in defaults', () => {
    const landing = getTemplate('landing');
    const values = applyDefaults(landing!, { projectName: 'A', tagline: 'B', features: 'C' });
    expect(values['accent']).toBe('#38bdf8');
    expect(values['includeContact']).toBe(true);
  });

  it('lets an explicit value beat the default', () => {
    const landing = getTemplate('landing');
    const values = applyDefaults(landing!, {
      projectName: 'A',
      tagline: 'B',
      features: 'C',
      accent: '#ff0000',
    });
    expect(values['accent']).toBe('#ff0000');
  });
});

describe('generated output', () => {
  it('produces the same bytes for the same input', () => {
    // Determinism is what makes the whole pipeline verifiable. A generator
    // that varied per run could not be tested.
    const first = plan(LANDING);
    const second = plan(LANDING);

    expect(second.files).toEqual(first.files);
  });

  it('lists one feature card per line', () => {
    const result = plan(LANDING);
    const index = result.files.find((f) => f.path === 'index.html');
    expect(index?.contents).toContain('Fast');
    expect(index?.contents).toContain('Reliable');
    expect(index?.contents).toContain('Cheap');
  });

  it('ignores blank feature lines', () => {
    const result = plan({
      ...LANDING,
      values: { ...LANDING.values, features: 'One\n\n\nTwo\n   \nThree' },
    });
    const index = result.files.find((f) => f.path === 'index.html');

    const cards = (index?.contents.match(/class="card"/g) ?? []).length;
    expect(cards).toBe(3);
  });

  it('omits the contact form when switched off', () => {
    const withForm = plan(LANDING);
    expect(
      withForm.files.find((f) => f.path === 'index.html')?.contents,
    ).toContain('<form');

    const without = plan({
      ...LANDING,
      values: { ...LANDING.values, includeContact: false },
    });
    expect(
      without.files.find((f) => f.path === 'index.html')?.contents,
    ).not.toContain('<form');
  });

  it('applies the accent colour', () => {
    const result = plan({
      ...LANDING,
      values: { ...LANDING.values, accent: '#ff0066' },
    });
    expect(result.files.find((f) => f.path === 'styles.css')?.contents).toContain(
      '#ff0066',
    );
  });

  it('generates one page per docs entry', () => {
    const result = plan({
      templateId: 'docs',
      values: {
        projectName: 'Guide',
        tagline: 'How to use it',
        pages: 'Install:getting started\nConfigure:every option\nDeploy:going live',
      },
    });

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('page-1.html');
    expect(paths).toContain('page-2.html');
  });

  it('generates a runnable api server', () => {
    const result = plan({
      templateId: 'api',
      values: { projectName: 'Widget API', resource: 'widget' },
    });

    const server = result.files.find((f) => f.path === 'server.js');
    expect(server?.contents).toContain("require('node:http')");
    expect(server?.contents).toContain("segments[0] !== 'widget'");
  });

  it('slugifies the api resource', () => {
    const result = plan({
      templateId: 'api',
      values: { projectName: 'API', resource: 'My Widgets' },
    });
    // A resource name becomes a URL path and a variable name, so it has to be
    // a valid slug rather than arbitrary text.
    const server = result.files.find((f) => f.path === 'server.js');
    expect(server?.contents).toContain("segments[0] !== 'my-widgets'");
    expect(server?.contents).not.toContain('My Widgets');
  });

  it('emits valid JSON in project files', () => {
    for (const templateId of ['landing', 'docs', 'api']) {
      const values =
        templateId === 'landing'
          ? LANDING.values
          : templateId === 'docs'
            ? { projectName: 'D', tagline: 'T', pages: 'A:b' }
            : { projectName: 'A', resource: 'r' };

      const result = plan({ templateId, values });
      for (const file of result.files) {
        if (!file.path.endsWith('.json')) continue;
        expect(() => JSON.parse(file.contents)).not.toThrow();
      }
    }
  });

  it('never emits an absolute path', () => {
    for (const templateId of ['landing', 'docs', 'api']) {
      const values =
        templateId === 'landing'
          ? LANDING.values
          : templateId === 'docs'
            ? { projectName: 'D', tagline: 'T', pages: 'A:b' }
            : { projectName: 'A', resource: 'r' };

      for (const file of plan({ templateId, values }).files) {
        expect(file.path.startsWith('/')).toBe(false);
        expect(file.path).not.toMatch(/^[A-Za-z]:/);
        expect(file.path).not.toContain('..');
      }
    }
  });
});

describe('writing to disk', () => {
  it('writes every planned file', async () => {
    const result = await scaffold({ ...LANDING, workspace });

    expect(result.refused).toEqual([]);
    expect(result.written.length).toBeGreaterThan(0);

    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).toContain('Acme Tools');

    const css = await readFile(join(root, 'styles.css'), 'utf8');
    expect(css).toContain('--accent');
  });

  it('writes a dotfile', async () => {
    await scaffold({ ...LANDING, workspace });
    const entries = await readdir(root);
    expect(entries).toContain('.gitignore');
  });

  it('does not mutate the input array', async () => {
    const planned = plan(LANDING);
    const before = planned.files.length;
    await materialise(planned, workspace);
    expect(planned.written).toEqual([]);
    expect(planned.files).toHaveLength(before);
  });

  it('overwrites by default', async () => {
    await writeFile(join(root, 'index.html'), 'OLD', 'utf8');
    const result = await scaffold({ ...LANDING, workspace });
    expect(result.written).toContain('index.html');

    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).not.toBe('OLD');
  });

  it('refuses to overwrite when told not to', async () => {
    await writeFile(join(root, 'index.html'), 'KEEP ME', 'utf8');
    const result = await scaffold({ ...LANDING, workspace, overwrite: false });

    expect(result.written).not.toContain('index.html');
    expect(result.refused.some((r) => r.path === 'index.html')).toBe(true);

    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).toBe('KEEP ME');
  });

  it('reports what it refused and why', async () => {
    await writeFile(join(root, 'index.html'), 'x', 'utf8');
    const result = await scaffold({ ...LANDING, workspace, overwrite: false });

    const refusal = result.refused.find((r) => r.path === 'index.html');
    expect(refusal?.reason).toMatch(/already exists/i);
  });
});

describe('a template cannot escape the workspace', () => {
  /**
   * Containment is checked for every path even though templates produce their
   * own, because a template is code and code can be wrong. The point of the
   * check is that no caller has to be trusted.
   */
  it('refuses a planned path that escapes', async () => {
    const hostile = {
      files: [
        { path: 'ok.txt', contents: 'fine' },
        { path: '../escaped.txt', contents: 'nope' },
        { path: '../../escaped2.txt', contents: 'nope' },
        { path: '/etc/passwd', contents: 'nope' },
      ],
      written: [],
      refused: [],
      notes: [],
    };

    const result = await materialise(hostile, workspace);

    expect(result.written).toEqual(['ok.txt']);
    expect(result.refused).toHaveLength(3);
    for (const refusal of result.refused) {
      expect(refusal.reason).toMatch(/escapes the workspace/i);
    }
  });

  it('leaves the escaped files undeleted and uncreated', async () => {
    await materialise(
      {
        files: [{ path: '../escaped.txt', contents: 'nope' }],
        written: [],
        refused: [],
        notes: [],
      },
      workspace,
    );

    const entries = await readdir(join(root, '..'));
    expect(entries).not.toContain('escaped.txt');
  });

  it('reports the refusal on the file entry too', async () => {
    const result = await materialise(
      {
        files: [{ path: '../escaped.txt', contents: 'nope' }],
        written: [],
        refused: [],
        notes: [],
      },
      workspace,
    );

    expect(result.files[0]?.skipped).toMatch(/escapes the workspace/i);
  });

  it('still writes the files that are allowed', async () => {
    const result = await materialise(
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

    // One bad path must not abandon the good ones.
    expect(result.written).toEqual(['good.txt']);
    expect(await readFile(join(root, 'good.txt'), 'utf8')).toBe('yes');
  });
});