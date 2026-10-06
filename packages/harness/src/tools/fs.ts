/**
 * File tools.
 *
 * Every path here goes through `Workspace.resolve`, which is what makes
 * containment a property of the harness rather than a habit of the tool
 * author. A tool that used the process working directory, or `path.join` on
 * raw model input, would let the same escape through.
 */

import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import { ContainmentError, InvalidPathError } from '../workspace/containment.js';
import { readDenied } from '../workspace/sensitive.js';
import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

/** Turn a containment failure into something a model can act on. */
function pathError(error: unknown): ToolResult | null {
  if (error instanceof ContainmentError || error instanceof InvalidPathError) {
    // The distinction the model needs: this is refused, not missing.
    return failure(`${error.message} (requested: ${error.requested})`);
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse a read of a credential-shaped path unless the user granted it.
 *
 * Takes the *resolved* absolute path, not the string the caller supplied:
 * classification has to see the path the filesystem will actually open, so
 * `config/../.env` is judged as `.env`. Resolving `../` here would be a
 * containment bug, not just a classification one.
 *
 * Checked after containment and before the file is opened, so the refusal does
 * not depend on the file existing: a model cannot learn whether `.env` exists
 * by asking and watching whether it is refused differently from a missing
 * file. The message names the reason and tells the model what to do instead,
 * so it can carry on with the rest of the task rather than retrying.
 */
function sensitiveRefusal(absolute: string, ctx: ToolContext): ToolResult | null {
  // Classified on the workspace-relative form: containment has already proven
  // the absolute path is inside, and the same file must classify identically
  // however it was reached. toRelative uses the native separator, which
  // classifySensitive normalises.
  const relative = ctx.workspace.toRelative(absolute);
  const denial = readDenied(relative, ctx.allowSensitive ?? []);
  if (!denial) return null;
  return failure(
    `${relative} was not read: ${denial.message} ` +
      'Ask the user to confirm reading it if you genuinely need it.',
  );
}

/** Default cap on a single read, in bytes. */
export const DEFAULT_MAX_READ_BYTES = 256 * 1024;

export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the workspace. Returns the content with ' +
      '1-based line numbers so you can refer to lines when editing.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path to the file.',
        },
        offset: {
          type: 'integer',
          description: 'First line to return, 1-based.',
          default: 1,
          minimum: 1,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of lines to return.',
          default: 2000,
          minimum: 1,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const target = args['path'];
    if (typeof target !== 'string') {
      return failure('path is required');
    }

    let absolute: string;
    try {
      absolute = await ctx.workspace.resolve(target);
    } catch (error) {
      return pathError(error) ?? failure(`could not resolve ${target}`);
    }

    const refusal = sensitiveRefusal(absolute, ctx);
    if (refusal) return refusal;

    let raw: Buffer;
    try {
      raw = await readFile(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return failure(`no such file: ${target}`);
      if (code === 'EISDIR') return failure(`${target} is a directory, not a file`);
      return failure(`could not read ${target}`);
    }

    // Enforced before decoding: a byte cap is meaningless once the content is
    // already in memory as a string.
    if (raw.byteLength > ctx.maxReadBytes) {
      return failure(
        `${target} is ${raw.byteLength} bytes, over the ${ctx.maxReadBytes} byte ` +
          'limit. Read it in sections using offset and limit, or use grep to ' +
          'find the relevant part.',
      );
    }

    const offset = typeof args['offset'] === 'number' ? args['offset'] : 1;
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 2000;

    const text = raw.toString('utf8');
    // A trailing newline is a line terminator, not an empty final line. Without
    // this every read of a well-formed file reports one phantom extra line,
    // and the model's line references drift by one on each edit.
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    const lines = body === '' ? [] : body.split('\n');

    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected.map((line, index) => `${offset + index}\t${line}`);

    const shown = numbered.length;
    const more = Math.max(0, lines.length - (offset - 1 + shown));

    if (shown === 0) {
      return {
        ok: true,
        content:
          `${ctx.workspace.toRelative(absolute)} is empty` +
          (lines.length > 0 ? ` (offset ${offset} is past the end).` : '.'),
      };
    }

    const plural = more === 1 ? 'line' : 'lines';

    return {
      ok: true,
      content:
        `${ctx.workspace.toRelative(absolute)} (lines ${offset}-${offset + shown - 1} ` +
        `of ${lines.length})\n\n${numbered.join('\n')}` +
        (more > 0 ? `\n\n... ${more} more ${plural} not shown.` : ''),
    };
  },
};

export const writeFileTool: Tool = {
  schema: {
    name: 'write_file',
    description:
      'Create a file or replace its entire contents. The parent directory ' +
      'must already exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.' },
        content: { type: 'string', description: 'Full new contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const target = args['path'];
    const content = args['content'];
    if (typeof target !== 'string') return failure('path is required');
    if (typeof content !== 'string') return failure('content is required');

    let absolute: string;
    try {
      absolute = await ctx.workspace.resolve(target);
    } catch (error) {
      return pathError(error) ?? failure(`could not resolve ${target}`);
    }

    // Refused rather than created. A tool that quietly makes directories will
    // eventually make one somewhere surprising.
    if (!(await exists(dirname(absolute)))) {
      return failure(
        `the directory for ${target} does not exist; create it first`,
      );
    }

    try {
      await writeFile(absolute, content, 'utf8');
    } catch (error) {
      return failure(`could not write ${target}: ${describe(error)}`);
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      ok: true,
      content: `Wrote ${bytes} bytes to ${ctx.workspace.toRelative(absolute)}`,
    };
  },
};

export const editFileTool: Tool = {
  schema: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. oldText must appear exactly once ' +
      'unless replace_all is true. This is the preferred way to change an ' +
      'existing file, because it cannot silently discard unrelated edits.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.' },
        oldText: {
          type: 'string',
          description: 'Exact text to find, including indentation.',
        },
        newText: { type: 'string', description: 'Replacement text.' },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring exactly one.',
          default: false,
        },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const target = args['path'];
    const oldText = args['oldText'];
    const newText = args['newText'];
    const replaceAll = args['replaceAll'] === true;

    if (typeof target !== 'string') return failure('path is required');
    if (typeof oldText !== 'string') return failure('oldText is required');
    if (typeof newText !== 'string') return failure('newText is required');

    if (oldText === '') {
      return failure('oldText is empty, which would match everywhere');
    }

    let absolute: string;
    try {
      absolute = await ctx.workspace.resolve(target);
    } catch (error) {
      return pathError(error) ?? failure(`could not resolve ${target}`);
    }

    let current: string;
    try {
      const raw = await readFile(absolute);
      if (raw.byteLength > ctx.maxReadBytes) {
        return failure(
          `${target} is too large to edit safely (${raw.byteLength} bytes)`,
        );
      }
      current = raw.toString('utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return failure(`no such file: ${target}`);
      return failure(`could not read ${target}: ${describe(error)}`);
    }

    const occurrences = countOccurrences(current, oldText);

    if (occurrences === 0) {
      return failure(
        `oldText was not found in ${target}. Read the file and copy the exact ` +
          'text, including indentation.',
      );
    }

    if (occurrences > 1 && !replaceAll) {
      return failure(
        `oldText appears ${occurrences} times in ${target}. Include more ` +
          'surrounding text to make it unique, or set replace_all to true.',
      );
    }

    const updated = replaceAll
      ? current.split(oldText).join(newText)
      : current.replace(oldText, newText);

    try {
      await writeFile(absolute, updated, 'utf8');
    } catch (error) {
      return failure(`could not write ${target}: ${describe(error)}`);
    }

    const changed = occurrences === 1 ? 1 : occurrences;
    return {
      ok: true,
      content: `Replaced ${changed} occurrence${changed === 1 ? '' : 's'} in ${ctx.workspace.toRelative(absolute)}`,
    };
  },
};

export const listDirTool: Tool = {
  schema: {
    name: 'list_dir',
    description: 'List the entries in a directory in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative directory. Defaults to the root.',
          default: '.',
        },
      },
      additionalProperties: false,
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const target = typeof args['path'] === 'string' ? args['path'] : '.';

    let absolute: string;
    try {
      absolute = await ctx.workspace.resolve(target);
    } catch (error) {
      return pathError(error) ?? failure(`could not resolve ${target}`);
    }

    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return failure(`no such directory: ${target}`);
      if (code === 'ENOTDIR') return failure(`${target} is not a directory`);
      return failure(`could not list ${target}: ${describe(error)}`);
    }

    // Directories first, then alphabetical, so the listing is stable between
    // calls and a model is not tempted to think it is random.
    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (sorted.length === 0) {
      return { ok: true, content: `${target} is empty` };
    }

    const lines = await Promise.all(
      sorted.map(async (entry) => {
        const child = `${absolute}/${entry.name}`;
        let suffix = '';
        try {
          const info = await stat(child);
          if (entry.isDirectory()) suffix = '/';
          else if (info.size > 0) suffix = ` (${info.size} bytes)`;
        } catch {
          // A dangling symlink still belongs in the listing.
          suffix = entry.isDirectory() ? '/' : '';
        }
        return `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}${suffix}`;
      }),
    );

    return {
      ok: true,
      content: `${target}/\n${lines.join('\n')}`,
    };
  },
};

export const mkdirTool: Tool = {
  schema: {
    name: 'mkdir',
    description:
      'Create a directory, including any missing parents. Refused if any ' +
      'part of the path leaves the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const target = args['path'];
    if (typeof target !== 'string') return failure('path is required');

    let absolute: string;
    try {
      absolute = await ctx.workspace.resolve(target);
    } catch (error) {
      return pathError(error) ?? failure(`could not resolve ${target}`);
    }

    try {
      await mkdir(absolute, { recursive: true });
    } catch (error) {
      return failure(`could not create ${target}: ${describe(error)}`);
    }

    return {
      ok: true,
      content: `Created ${ctx.workspace.toRelative(absolute)}`,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Everything above, ready to hand to an agent. */
export function fileTools(): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, listDirTool, mkdirTool];
}

/** Re-exported so callers do not need the path module for display. */
export { relative };