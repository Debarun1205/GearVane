/**
 * Search across workspace files.
 *
 * Plain substring matching, not regex. A model emitting regex metacharacters
 * in a search term must not silently change what the search means; if regex
 * is ever wanted it will be a separate, explicitly named tool.
 *
 * Every candidate path goes through `Workspace.resolve` like every other
 * tool, and symlinked directories resolving outside the workspace are skipped
 * during the walk rather than followed.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

/**
 * Directories never descended into, whatever they contain.
 *
 * Mirrors the IDE tree's skip list in apps/desktop/src/ide/fs-store.ts. Two
 * copies is a smell; one shared copy would need a shared package both sides
 * can import without pulling Node into the renderer bundle, which does not
 * exist. If a third copy appears, that package becomes worth building.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

/** Files larger than this are skipped, not read. */
const MAX_FILE_BYTES = 512 * 1024;

/** Hard ceiling no caller can raise. */
const MAX_RESULTS_HARD_CAP = 200;

/** Long lines (minified bundles) are cut here so one file cannot flood context. */
const MAX_LINE_CHARS = 240;

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export const searchFilesTool: Tool = {
  schema: {
    name: 'search_files',
    description:
      'Search file contents across the workspace for a plain-text substring. ' +
      'Returns path:line matches. Skips dependency and build directories.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to find. Plain text, not a regex.',
          minLength: 1,
        },
        directory: {
          type: 'string',
          description: 'Workspace-relative directory to search under. Defaults to the root.',
          default: '.',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Match case exactly. Defaults to false.',
          default: false,
        },
        maxResults: {
          type: 'integer',
          description: 'Maximum matches to return. Defaults to 50, hard cap 200.',
          default: 50,
          minimum: 1,
          maximum: MAX_RESULTS_HARD_CAP,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const query = args['query'];
    if (typeof query !== 'string' || query.length === 0) {
      return failure('query is required');
    }

    const directory = typeof args['directory'] === 'string' ? args['directory'] : '.';
    const caseSensitive = args['caseSensitive'] === true;
    const maxResults = Math.min(
      typeof args['maxResults'] === 'number' ? Math.floor(args['maxResults']) : 50,
      MAX_RESULTS_HARD_CAP,
    );

    let start: string;
    try {
      start = await ctx.workspace.resolve(directory);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: SearchMatch[] = [];
    let truncated = false;
    let skipped = 0;

    const walk = async (absolute: string): Promise<void> => {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }

      let children;
      try {
        children = await readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }

      for (const child of children) {
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }

        const childAbsolute = join(absolute, child.name);

        if (child.isDirectory()) {
          if (SKIP_DIRS.has(child.name)) {
            skipped += 1;
            continue;
          }
          const rel = relative(ctx.workspace.root, childAbsolute).split(sep).join('/');
          if (!(await ctx.workspace.allows(rel))) continue;
          await walk(childAbsolute);
        } else if (child.isFile()) {
          await searchFile(childAbsolute);
        }
      }
    };

    const searchFile = async (absolute: string): Promise<void> => {
      let info;
      try {
        info = await stat(absolute);
      } catch {
        return;
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES || info.size === 0) return;

      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        return;
      }
      // A null byte means binary: matching inside it produces garbage the
      // model cannot use, at context cost.
      if (content.includes('\0')) return;

      const rel = relative(ctx.workspace.root, absolute).split(sep).join('/');
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
        const line = lines[index] ?? '';
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          const text =
            line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
          matches.push({ path: rel, line: index + 1, text });
        }
      }
    };

    await walk(start);

    if (matches.length === 0) {
      return { ok: true, content: `No matches for "${query}".` };
    }

    const rendered = matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
    if (truncated) {
      rendered.push(`… truncated at ${maxResults} matches; narrow the query or directory.`);
    }
    if (skipped > 0) {
      rendered.push(`(skipped ${skipped} dependency/build directories)`);
    }

    return { ok: true, content: rendered.join('\n') };
  },
};
