/**
 * Builder host for the Electron main process.
 *
 * The renderer is sandboxed and cannot touch the filesystem, so the builder
 * reaches the disk through these handlers. That split is not incidental: a
 * renderer with Node integration would be able to write anywhere on the
 * machine, which is exactly the property the harness spends the containment
 * layer trying to guarantee.
 *
 * Every write goes through `Workspace`, so a scaffold path cannot escape the
 * chosen directory even if a template produced one.
 */

import { dialog, ipcMain } from 'electron';
import { join } from 'node:path';

import {
  TEMPLATES,
  Workspace,
  materialise,
  plan,
  type ScaffoldFile,
} from '@waypoint/harness';
import { installNodeFileSystem } from '@waypoint/harness';

/** What the renderer is told about each template. */
function describeTemplates(): Array<{
  id: string;
  name: string;
  description: string;
  params: typeof TEMPLATES[number]['params'];
}> {
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    params: template.params,
  }));
}

/**
 * Plan a scaffold without writing anything.
 *
 * Split from the write so the renderer can show a preview and a file list
 * first, and so a bad input is caught before the user picks a folder.
 */
export function previewScaffold(input: {
  templateId: unknown;
  values: unknown;
}): {
  ok: boolean;
  files?: Array<{ path: string; contents: string }>;
  error?: string;
} {
  if (typeof input.templateId !== 'string') {
    return { ok: false, error: 'templateId must be a string' };
  }

  const values =
    input.values !== null && typeof input.values === 'object'
      ? (input.values as Record<string, string | boolean>)
      : {};

  try {
    const planned = plan({ templateId: input.templateId, values });
    return {
      ok: true,
      files: planned.files.map((file) => ({
        path: file.path,
        contents: file.contents,
      })),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Write a scaffold into a folder the user picks.
 *
 * Returns what was written and what was refused. A refusal is reported rather
 * than thrown, so one bad path does not abandon the files that were fine.
 */
export async function writeScaffold(
  input: {
    templateId: unknown;
    values: unknown;
    directory?: unknown;
  },
): Promise<{
  ok: boolean;
  directory?: string;
  written: string[];
  refused: Array<{ path: string; reason: string }>;
  error?: string;
}> {
  const planned = previewScaffold(input);
  if (!planned.ok || !planned.files) {
    return { ok: false, written: [], refused: [], error: planned.error };
  }

  // Installed rather than imported by scaffold.ts, because that module is also
  // bundled for the browser where node:fs does not exist.
  const fs = installNodeFileSystem();

  const workspace = new Workspace(
    typeof input.directory === 'string' && input.directory !== ''
      ? input.directory
      : process.cwd(),
  );

  const result = await materialise(
    {
      files: planned.files as ScaffoldFile[],
      written: [],
      refused: [],
      notes: [],
    },
    workspace,
    { fs },
  );

  return {
    ok: true,
    directory: workspace.root,
    written: result.written,
    refused: result.refused,
  };
}

/** Register the handlers. Called once from main. */
export function registerBuilderHandlers(): void {
  ipcMain.handle('builder:templates', () => describeTemplates());

  ipcMain.handle('builder:preview', (_event, input: unknown) => {
    // Untrusted input: anything can arrive on a channel, so the shape is
    // normalised here rather than assumed.
    const payload = (input ?? {}) as Record<string, unknown>;
    return previewScaffold({
      templateId: payload['templateId'],
      values: payload['values'],
    });
  });

  ipcMain.handle('builder:chooseFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where to write the site',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle('builder:write', async (_event, input: unknown) => {
    const payload = (input ?? {}) as Record<string, unknown>;
    return writeScaffold({
      templateId: payload['templateId'],
      values: payload['values'],
      directory: payload['directory'],
    });
  });

  ipcMain.handle('builder:deployers', () => {
    // Only local is offered. The hosted targets need a credential, and handing
    // one to the renderer is the exact thing the sandbox prevents. They stay
    // available from the CLI, where a token can live in the environment.
    return [
      {
        id: 'local',
        name: 'Write to a folder',
        configured: true,
        requirements: 'A folder you choose. Nothing leaves your machine.',
      },
    ];
  });
}

/** Where a scaffold ended up, for a message the user can read. */
export function describeOutcome(
  outcome: { directory?: string; written: string[]; refused: unknown[] },
): string {
  const parts = [`Wrote ${outcome.written.length} file(s)`];
  if (outcome.directory) parts.push(`to ${outcome.directory}`);
  if (outcome.refused.length > 0) {
    parts.push(`(${outcome.refused.length} refused)`);
  }
  return parts.join(' ');
}

export { join };