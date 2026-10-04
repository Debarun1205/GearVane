/**
 * Project scaffolding.
 *
 * ## What this is
 *
 * A **template engine with parameters**, not a code generator. The user picks
 * a template and fills in fields; this produces real, complete, runnable files.
 *
 * That is a real and useful thing, and it is deliberately *not* the thing a
 * prompt-driven builder does. Generating arbitrary code from a description
 * needs a model call, produces different output each time, and cannot be
 * meaningfully tested. Templates produce the same bytes for the same input,
 * which is what makes the whole pipeline verifiable.
 *
 * The agent loop in this package is the part that can customise generated
 * code afterwards. Scaffolding first, agent second, is the only ordering where
 * both halves are testable.
 *
 * ## Safety
 *
 * Every generated path goes through the same `Workspace` containment as every
 * other tool, so a template cannot write outside the target directory even if
 * a parameter contains `../`. Parameter values are escaped before they land in
 * HTML, JS, JSON, and SQL, because they are user input and end up in strings.
 */

import type { Workspace } from '../workspace/containment.js';

/** One generated file. */
export interface ScaffoldFile {
  /** Path relative to the project root, always forward-slashed. */
  path: string;
  contents: string;
  /** Set when the file was not written, with the reason. */
  skipped?: string;
}

export interface ScaffoldResult {
  files: ScaffoldFile[];
  /** Paths actually written to disk. */
  written: string[];
  /** Paths refused, with a reason each. */
  refused: Array<{ path: string; reason: string }>;
  notes: string[];
}

/**
 * Escape for interpolation into HTML text or an attribute value.
 *
 * Everything user-supplied goes through this before reaching a template. The
 * generated site is rendered in the user's browser, so an unescaped title is
 * a script injection into their own preview.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for interpolation into a JS string literal. */
export function escapeJs(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Escape for interpolation into a regex. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, hyphenated, safe as a directory name and a URL segment. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Validate a name that becomes a directory. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;
}

export interface TemplateParam {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'boolean' | 'color';
  required?: boolean;
  default?: string | boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  params: TemplateParam[];
  /**
   * Build the file set.
   *
   * Returns paths already slugified; the caller still runs every path through
   * containment, because a template is code and code can be wrong.
   */
  build(values: Record<string, string | boolean>): ScaffoldFile[];
}

/** Convenience for a file with no interpolation. */
function file(path: string, contents: string): ScaffoldFile {
  return { path, contents };
}

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

const landingTemplate: Template = {
  id: 'landing',
  name: 'Landing page',
  description:
    'A single static page with a hero, feature grid, and contact form stub. ' +
    'No build step: open index.html and it works.',
  params: [
    {
      key: 'projectName',
      label: 'Project name',
      type: 'text',
      required: true,
      placeholder: 'Acme Tools',
    },
    {
      key: 'tagline',
      label: 'Tagline',
      type: 'text',
      required: true,
      placeholder: 'Ship faster without the guesswork',
    },
    {
      key: 'features',
      label: 'Features (one per line)',
      type: 'textarea',
      required: true,
      placeholder: 'Does one thing well\nWorks offline\nNo account needed',
    },
    {
      key: 'accent',
      label: 'Accent colour',
      type: 'color',
      default: '#38bdf8',
    },
    {
      key: 'includeContact',
      label: 'Include a contact form',
      type: 'boolean',
      default: true,
    },
  ],

  build(values) {
    const name = String(values['projectName'] ?? 'Untitled');
    const tagline = String(values['tagline'] ?? '');
    const accent = String(values['accent'] ?? '#38bdf8');
    const slug = slugify(name) || 'site';

    const features = String(values['features'] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const cards = features
      .map(
        (feature, index) => `      <li class="card">
        <h3>${escapeHtml(feature)}</h3>
        <p>Feature ${index + 1} of ${escapeHtml(name)}.</p>
      </li>`,
      )
      .join('\n');

    const contact = values['includeContact'] === false ? '' : `
      <section class="contact">
        <h2>Get in touch</h2>
        <!-- Static stub: point the form action at your backend when you have one. -->
        <form action="#" method="post">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required />
          <button type="submit">Send</button>
        </form>
      </section>`;

    return [
      file(
        'index.html',
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(name)}</title>
    <meta name="description" content="${escapeHtml(tagline)}" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header>
      <h1>${escapeHtml(name)}</h1>
      <p class="tagline">${escapeHtml(tagline)}</p>
    </header>

    <main>
      <section class="features">
${cards || '      <li class="card"><h3>Add a feature</h3></li>'}
      </section>${contact}
    </main>

    <footer>
      <p>${escapeHtml(name)}</p>
    </footer>
  </body>
</html>
`,
      ),

      file(
        'styles.css',
        `:root {
  --accent: ${accent};
  --bg: #0b1120;
  --text: #e2e8f0;
  --dim: #94a3b8;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
}

header, main, footer {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

h1 { font-size: 2.5rem; }
.tagline { color: var(--dim); font-size: 1.2rem; }

.features {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  list-style: none;
  padding: 0;
}

.card {
  background: #131c31;
  border: 1px solid #24304a;
  border-radius: 12px;
  padding: 1.25rem;
}

.card h3 { color: var(--accent); margin-bottom: 0.4rem; }
.card p { color: var(--dim); }

.contact { margin-top: 3rem; }
.contact label { display: block; margin-bottom: 0.4rem; }
.contact input {
  background: #101827;
  border: 1px solid #24304a;
  border-radius: 8px;
  color: var(--text);
  padding: 0.6rem;
  width: 100%;
  max-width: 24rem;
}
.contact button {
  background: var(--accent);
  border: 0;
  border-radius: 8px;
  color: #0b1120;
  cursor: pointer;
  font-weight: 600;
  margin-top: 0.75rem;
  padding: 0.6rem 1.2rem;
}

footer { color: var(--dim); border-top: 1px solid #24304a; }
`,
      ),

      file(
        'README.md',
        `# ${name}

${tagline}

## Run it

No build step. Open \`index.html\` in a browser, or serve the directory:

\`\`\`bash
python -m http.server 8000
\`\`\`

## Deploy

This is a static site, so any static host works. Drag the folder onto
[Netlify Drop](https://app.netlify.com/drop), or:

\`\`\`bash
npx vercel deploy --prod
\`\`\`

The contact form is a static stub pointing at \`#\`. Point its \`action\` at
your backend before expecting submissions.
`,
      ),

      file(
        '.gitignore',
        `.DS_Store
node_modules/
dist/
.env
`,
      ),

      file(
        'gearvane.project.json',
        `${JSON.stringify(
          {
            name,
            slug,
            template: landingTemplate.id,
            createdBy: 'GearVane builder',
            accent,
            features,
          },
          null,
          2,
        )}\n`,
      ),
    ];
  },
};

const docsTemplate: Template = {
  id: 'docs',
  name: 'Documentation site',
  description:
    'A multi-page docs site with a sidebar, search-free navigation, and a ' +
    'print stylesheet. Static, no build step.',
  params: [
    { key: 'projectName', label: 'Project name', type: 'text', required: true },
    { key: 'tagline', label: 'Description', type: 'text', required: true },
    {
      key: 'pages',
      label: 'Pages (Title:summary, one per line)',
      type: 'textarea',
      required: true,
      placeholder: 'Installation:how to get started\nConfiguration:every option',
    },
    { key: 'accent', label: 'Accent colour', type: 'color', default: '#a78bfa' },
  ],

  build(values) {
    const name = String(values['projectName'] ?? 'Docs');
    const tagline = String(values['tagline'] ?? '');
    const accent = String(values['accent'] ?? '#a78bfa');

    const pages = String(values['pages'] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [title = 'Page', summary = ''] = line.split(':');
        return { title: title.trim(), summary: summary.trim() };
      });

    const nav = pages
      .map(
        (page, index) =>
          `      <li><a href="./${index === 0 ? 'index' : `page-${index}`}.html">${escapeHtml(page.title)}</a></li>`,
      )
      .join('\n');

    const pageFiles = pages.map((page, index) => {
      const previous =
        index > 0
          ? `<a href="./${index - 1 === 0 ? 'index' : `page-${index - 1}`}.html">Previous</a>`
          : '';
      const next =
        index < pages.length - 1
          ? `<a href="./${index + 1 === 0 ? 'index' : `page-${index + 1}`}.html">Next</a>`
          : '';

      return file(
        `${index === 0 ? 'index' : `page-${index}`}.html`,
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(page.title)} | ${escapeHtml(name)}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header>
      <a class="brand" href="./index.html">${escapeHtml(name)}</a>
    </header>
    <div class="layout">
      <nav>
        <ul>
${nav}
        </ul>
      </nav>
      <main>
        <h1>${escapeHtml(page.title)}</h1>
        <p class="lede">${escapeHtml(page.summary)}</p>
        <h2>Overview</h2>
        <p>Write this section.</p>
        <nav class="pager">
          ${previous}
          ${next}
        </nav>
      </main>
    </div>
  </body>
</html>
`,
      );
    });

    return [
      ...pageFiles,
      file(
        'styles.css',
        `:root { --accent: ${accent}; --bg: #0b1120; --panel: #131c31; --text: #e2e8f0; --dim: #94a3b8; --border: #24304a; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; }
header { border-bottom: 1px solid var(--border); padding: 1rem 1.5rem; }
.brand { color: var(--text); font-weight: 700; text-decoration: none; }
.layout { display: grid; grid-template-columns: 14rem 1fr; gap: 2rem; max-width: 70rem; padding: 2rem 1.5rem; }
nav ul { list-style: none; padding: 0; position: sticky; top: 1.5rem; }
nav a { color: var(--dim); display: block; padding: 0.35rem 0; text-decoration: none; }
nav a:hover { color: var(--accent); }
main h1 { font-size: 2rem; margin-bottom: 0.5rem; }
.lede { color: var(--dim); margin-bottom: 2rem; }
main h2 { color: var(--accent); font-size: 1.3rem; margin: 2rem 0 0.75rem; }
.pager { display: flex; gap: 1rem; margin-top: 3rem; }
@media (max-width: 40rem) { .layout { grid-template-columns: 1fr; } nav ul { position: static; } }
@media print { nav { display: none; } .layout { grid-template-columns: 1fr; } }
`,
      ),
      file(
        'README.md',
        `# ${name}

${tagline}

${pages.length} page(s), generated by the GearVane builder. Static: open
\`index.html\` or serve the directory. No build step and no dependencies.
`,
      ),
      file(
        '.gitignore',
        `.DS_Store
node_modules/
`,
      ),
    ];
  },
};

const apiTemplate: Template = {
  id: 'api',
  name: 'HTTP API service',
  description:
    'A small Node HTTP server with no dependencies, a health endpoint, ' +
    'structured logging, and graceful shutdown. Nothing to install.',
  params: [
    { key: 'projectName', label: 'Project name', type: 'text', required: true },
    {
      key: 'resource',
      label: 'Primary resource (singular, lowercase)',
      type: 'text',
      required: true,
      placeholder: 'widget',
    },
    { key: 'port', label: 'Port', type: 'text', default: '3000' },
  ],

  build(values) {
    const name = String(values['projectName'] ?? 'API');
    const resource = slugify(String(values['resource'] ?? 'item')) || 'item';
    const port = String(values['port'] ?? '3000');

    const upper = resource.toUpperCase();

    return [
      file(
        'server.js',
        `#!/usr/bin/env node
'use strict';

/**
 * ${name}
 *
 * No dependencies on purpose: this runs anywhere Node does, with nothing to
 * install and nothing to audit but this file.
 */

const http = require('node:http');

const PORT = Number(process.env['PORT'] || ${port});
const ${upper} = new Map();

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      // Refuse an unbounded body rather than buffering it until memory runs out.
      if (size > 1_000_000) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);

  if (request.method === 'GET' && url.pathname === '/health') {
    return send(response, 200, { ok: true, ${resource}s: ${upper}.size });
  }

  if (segments[0] !== '${resource}') {
    return send(response, 404, { error: 'not found' });
  }

  try {
    if (request.method === 'GET' && segments.length === 1) {
      return send(response, 200, { items: [...${upper}.values()] });
    }

    if (request.method === 'POST' && segments.length === 1) {
      const body = await readBody(request);
      const id = String(Date.now() + Math.random().toString(36).slice(2, 8));
      const item = { id, ...body, createdAt: new Date().toISOString() };
      ${upper}.set(id, item);
      return send(response, 201, item);
    }

    if (request.method === 'GET' && segments.length === 2) {
      const item = ${upper}.get(segments[1]);
      return item
        ? send(response, 200, item)
        : send(response, 404, { error: 'not found' });
    }

    if (request.method === 'DELETE' && segments.length === 2) {
      return ${upper}.delete(segments[1])
        ? send(response, 204, {})
        : send(response, 404, { error: 'not found' });
    }

    return send(response, 405, { error: 'method not allowed' });
  } catch (error) {
    return send(response, 400, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: PORT }));
});

// Drain connections before exiting, so a deploy does not cut requests off.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
`,
      ),

      file(
        'package.json',
        `${JSON.stringify(
          {
            name: slugify(name) || 'api',
            version: '0.1.0',
            private: true,
            description: `${name} HTTP API`,
            main: 'server.js',
            scripts: {
              start: 'node server.js',
              test: 'node --test',
            },
            engines: { node: '>=20' },
          },
          null,
          2,
        )}\n`,
      ),

      file(
        'README.md',
        `# ${name}

A dependency-free HTTP API for \`${resource}\`.

## Run

\`\`\`bash
npm start
\`\`\`

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | \`/health\` | Liveness plus current item count |
| GET | \`/${resource}\` | List items |
| POST | \`/${resource}\` | Create an item |
| GET | \`/${resource}/:id\` | Fetch one |
| DELETE | \`/${resource}/:id\` | Remove one |

Storage is in memory and resets on restart. Swap the \`Map\` for a database
when you need persistence.

## Deploy

\`\`\`bash
PORT=8080 npm start
\`\`\`

Any host that runs a process works. There is nothing to build.
`,
      ),

      file(
        '.gitignore',
        `node_modules/
.env
*.log
`,
      ),
    ];
  },
};

/** Every template the builder offers. */
export const TEMPLATES: Template[] = [landingTemplate, docsTemplate, apiTemplate];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/* ------------------------------------------------------------------ */
/* Scaffolding                                                          */
/* ------------------------------------------------------------------ */

export interface ScaffoldOptions {
  templateId: string;
  values: Record<string, string | boolean>;
  /** Files that already exist and must not be overwritten. */
  overwrite?: boolean;
}

/** Values a template declared, filled with defaults for anything missing. */
export function applyDefaults(
  template: Template,
  values: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};

  for (const param of template.params) {
    const provided = values[param.key];
    if (provided !== undefined && provided !== '') {
      result[param.key] = provided;
      continue;
    }
    if (param.default !== undefined) {
      result[param.key] = param.default;
      continue;
    }
    if (param.required) {
      throw new Error(`Missing required field: ${param.label}`);
    }
  }

  return result;
}

/** Build the file set without touching the filesystem. */
export function plan(options: ScaffoldOptions): ScaffoldResult {
  const template = getTemplate(options.templateId);
  if (!template) {
    throw new Error(`Unknown template: ${options.templateId}`);
  }

  const values = applyDefaults(template, options.values);
  const files = template.build(values);

  return {
    files,
    written: [],
    refused: [],
    notes: [],
  };
}

/**
 * Node modules needed to write files, injected rather than imported.
 *
 * The scaffold engine is bundled into the website's builder page, where
 * `node:fs` does not exist. A static import would make the whole module
 * unbundleable for a browser; a dynamic one still fails at bundle time.
 * Injecting them keeps planning, escaping, and zipping usable in a browser,
 * with only the write half requiring Node.
 */
export interface FileSystemBridge {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string, encoding: 'utf8'): Promise<void>;
  dirname(path: string): string;
  exists(path: string): Promise<boolean>;
}

/** Thrown when a write is attempted with no filesystem supplied. */
export class NoFilesystemError extends Error {
  constructor() {
    super(
      'This build cannot write files. It can still build a site in memory, ' +
        'which is what the website builder does. Use the desktop app to write ' +
        'to disk.',
    );
    this.name = 'NoFilesystemError';
  }
}

/**
 * Write a planned scaffold to disk through a workspace.
 *
 * Every path is re-checked against containment even though templates produce
 * their own paths, because a template is code and code can be wrong. The
 * point of containment is that no caller has to be trusted.
 */
export async function materialise(
  planned: ScaffoldResult,
  workspace: Workspace,
  options: { overwrite?: boolean; fs?: FileSystemBridge } = {},
): Promise<ScaffoldResult> {
  const fs = options.fs ?? (await defaultFileSystem());
  if (!fs) throw new NoFilesystemError();

  const written: string[] = [];
  const refused: ScaffoldResult['refused'] = [];
  const files: ScaffoldFile[] = [];

  for (const entry of planned.files) {
    let absolute: string;

    try {
      absolute = await workspace.resolve(entry.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      refused.push({ path: entry.path, reason });
      files.push({ ...entry, skipped: reason });
      continue;
    }

    if (options.overwrite === false) {
      if (await fs.exists(absolute)) {
        const reason = 'file already exists and overwrite is disabled';
        refused.push({ path: entry.path, reason });
        files.push({ ...entry, skipped: reason });
        continue;
      }
    }

    try {
      await fs.mkdir(fs.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, entry.contents, 'utf8');
      written.push(entry.path);
      files.push(entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      refused.push({ path: entry.path, reason });
      files.push({ ...entry, skipped: reason });
    }
  }

  return {
    files,
    written,
    refused,
    notes: planned.notes,
  };
}

/** Build and write in one step. */
export async function scaffold(
  options: ScaffoldOptions & {
    workspace: Workspace;
    overwrite?: boolean;
    fs?: FileSystemBridge;
  },
): Promise<ScaffoldResult> {
  const planned = plan(options);
  return materialise(planned, options.workspace, {
    ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
}

/**
 * The filesystem writes go through.
 *
 * Null until a Node host installs one, which is the browser case. Kept in a
 * variable rather than imported so this module bundles for a browser: esbuild
 * resolves `node:fs` at bundle time even behind a dynamic import, so the Node
 * binding lives in `./node-fs.ts`, which nothing here imports.
 */
let installedFileSystem: FileSystemBridge | null = null;

/** Install a filesystem. Node hosts use `installNodeFileSystem` from node-fs. */
export function setFileSystem(fs: FileSystemBridge | null): void {
  installedFileSystem = fs;
}

/** The filesystem in use, or null when none has been installed. */
export function getFileSystem(): FileSystemBridge | null {
  return installedFileSystem;
}

async function defaultFileSystem(): Promise<FileSystemBridge | null> {
  return installedFileSystem;
}