/**
 * Agent runner for the IDE.
 *
 * The agent loop runs here, in the main process, rather than in the renderer.
 * The renderer bundle also ships inside the Android webview, where a bare
 * `node:` import fails the whole module — so anything that touches the
 * filesystem, including the harness tool layer, stays on this side of the IPC
 * boundary. This is the same split the builder, terminal, and IDE filesystem
 * already use, and for the same reason.
 *
 * The renderer sends a prompt and receives step events plus a final result. It
 * never sees a tool, a workspace object, or a provider client.
 */

import { ipcMain } from 'electron';
import { stat } from 'node:fs/promises';

import { ProviderFactory, type GearVaneConfig } from '@gearvane/core';
import {
  ToolRegistry,
  Workspace,
  builderTools,
  fileTools,
  installNodeFileSystem,
  listDirTool,
  readFileTool,
  runAgent,
  searchFilesTool,
  type AgentModel,
  type AgentResult,
  type AgentStep,
  type Tool,
} from '@gearvane/harness';

import { listFiles, readTextFile } from './ide/fs-store.js';
import { sanitizeKeys } from './keys.js';

/**
 * What the model is told before the user's prompt.
 *
 * Short on purpose: every token here is spent on every iteration. It names
 * the two scaffold tools and the order to use them in, because without that a
 * "build me a site" prompt scaffolds nothing and edits files that do not
 * exist yet.
 */
export const VIBE_SYSTEM_PROMPT = [
  'You build websites and small services inside the workspace.',
  'When the user asks for a new project, call list_templates first, then',
  'scaffold_project with the chosen template, then refine the generated files',
  'with read_file, edit_file, and write_file.',
  'Use search_files to locate code before editing it.',
  'Do not run commands; there is no shell. Describe follow-up steps as text.',
].join(' ');

/**
 * What the agent is allowed to do.
 *
 * Ask mode is read-only: list, read, search, and template listing. It cannot
 * create, modify, or scaffold anything, so it is safe to run against a
 * workspace while thinking. Build mode is the full toolkit minus the shell,
 * which stays in the visible terminal by design.
 */
export type AgentMode = 'ask' | 'build';

export const ASK_SYSTEM_PROMPT = [
  'Answer questions about the workspace.',
  'Read files and report what you find.',
  'Do not create, modify, or scaffold anything.',
].join(' ');

export interface AgentRunRequest {
  prompt: unknown;
  root: unknown;
  maxIterations?: unknown;
  mode?: unknown;
  /**
   * Which model drives the run: `"provider/model"` or a bare model name.
   * Absent means the first configured provider, same as before.
   */
  model?: unknown;
  /**
   * Vault keys from the renderer. Allowlisted and merged over the main
   * process environment in registerIdeAgentHandlers below, so a packaged
   * app without a shell environment still reaches hosted models.
   */
  keys?: unknown;
}

/** One selectable model: every configured provider/model pair, in tier order. */
export interface IdeModel {
  provider: string;
  model: string;
  tier: string;
}

export function listIdeModels(tiers: GearVaneConfig['tiers']): IdeModel[] {
  const out: IdeModel[] = [];
  for (const [tierName, tier] of Object.entries(tiers)) {
    for (const provider of tier.providers) {
      for (const model of provider.models) {
        out.push({ provider: provider.name, model, tier: tierName });
      }
    }
  }
  return out;
}

/**
 * Tools for a mode.
 *
 * Kept as a pure function of nothing but the mode so it can be asserted
 * directly: the dangerous failure is a write tool leaking into ask mode,
 * which would make "read-only" a lie.
 */
export function toolsForMode(mode: AgentMode): Tool[] {
  if (mode === 'ask') {
    return [readFileTool, listDirTool, searchFilesTool];
  }
  return [...fileTools(), ...builderTools(), searchFilesTool];
}

export interface AgentRunResponse {
  ok: boolean;
  result?: AgentResult;
  error?: string;
  /** Which model drove a successful run, so the UI can say so. */
  provider?: string;
  model?: string;
  /**
   * Files the run created or changed, with what they looked like before.
   *
   * `original` is null for files that did not exist when the run started.
   * Present only on success; the renderer offers accept/revert per file.
   */
  changed?: FileChange[];
}

/** One file the agent created or modified. */
export interface FileChange {
  path: string;
  original: string | null;
  current: string;
}

/**
 * Snapshot bounds.
 *
 * A snapshot exists so the user can review and revert, not to archive the
 * workspace: text files only, capped in count and size. Anything beyond the
 * caps is simply not reviewable, which the renderer states rather than
 * implying full coverage.
 */
export const MAX_SNAPSHOT_FILES = 100;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;

/**
 * Record what the workspace files look like before a run.
 *
 * Only files that can be diffed as text are worth snapshotting. Binary files
 * and oversized ones are skipped: a revert that cannot be displayed is a
 * revert the user cannot meaningfully approve.
 */
export async function snapshotWorkspace(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const entries = await listFiles(root);

  for (const entry of entries) {
    if (snapshot.size >= MAX_SNAPSHOT_FILES) break;
    if (entry.isDirectory) continue;
    if (entry.size !== undefined && entry.size > MAX_SNAPSHOT_BYTES) continue;

    const read = await readTextFile(root, entry.path, MAX_SNAPSHOT_BYTES + 1);
    if (!read.ok || read.content === undefined) continue;
    if (read.content.includes('\0')) continue;

    snapshot.set(entry.path, read.content);
  }

  return snapshot;
}

/**
 * Compare a snapshot against the workspace now.
 *
 * Detection is by content, not by tool calls: whatever the agent used to
 * write — scaffold, edit, or write — a changed file is a changed file. Files
 * the agent deleted cannot happen (no tool deletes), so absence from the
 * current listing is treated as unchanged rather than guessed about.
 */
export async function diffSnapshot(
  root: string,
  snapshot: Map<string, string>,
): Promise<FileChange[]> {
  const changed: FileChange[] = [];
  const entries = await listFiles(root);
  const current = new Map<string, string>();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.size !== undefined && entry.size > MAX_SNAPSHOT_BYTES) continue;

    const read = await readTextFile(root, entry.path, MAX_SNAPSHOT_BYTES + 1);
    if (!read.ok || read.content === undefined) continue;
    if (read.content.includes('\0')) continue;
    current.set(entry.path, read.content);
  }

  for (const [path, content] of current) {
    if (!snapshot.has(path)) {
      changed.push({ path, original: null, current: content });
    } else if (snapshot.get(path) !== content) {
      changed.push({ path, original: snapshot.get(path) ?? null, current: content });
    }
  }

  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

let active: AbortController | undefined;

/**
 * First configured provider, same choice the CLI and the VS Code panel make.
 *
 * An agent run is already the expensive path, so this does not consult the
 * router: silently overriding the user's configuration would be worse than not
 * routing at all.
 */
export function resolveIdeModel(
  env: Record<string, string | undefined>,
  tiers: GearVaneConfig['tiers'],
  wanted?: unknown,
): { client?: AgentModel; provider?: string; model?: string; reason?: string } {
  if (wanted !== undefined && wanted !== null && typeof wanted !== 'string') {
    return { reason: 'model must be a string like "provider/model" or a bare model name' };
  }
  const selection = typeof wanted === 'string' ? wanted : undefined;

  const factory = new ProviderFactory({ env });

  // A provider-qualified name wins when it names something configured;
  // otherwise a bare model name takes the first match in tier order.
  // Matching is exact: guessing across near-misses would run spend on the
  // wrong model.
  const candidates: Array<{ provider: GearVaneConfig['tiers']['local']['providers'][number]; model: string }> = [];
  for (const tier of Object.values(tiers)) {
    for (const provider of tier.providers) {
      for (const model of provider.models) {
        candidates.push({ provider, model });
      }
    }
  }

  if (selection !== undefined) {
    const picked =
      candidates.find((c) => `${c.provider.name}/${c.model}` === selection) ??
      candidates.find((c) => c.model === selection);

    if (picked === undefined) {
      return { reason: `unknown model "${selection}"` };
    }

    let selected;
    try {
      selected = factory.create(picked.provider, picked.model);
    } catch {
      // No base URL for this provider. Report it rather than silently
      // substituting a different model: the user asked for this one.
      return { reason: `provider "${picked.provider.name}" has no base URL configured` };
    }

    return {
      provider: picked.provider.name,
      model: picked.model,
      client: {
        complete: (prompt, options) => selected.complete(prompt, options),
      },
    };
  }

  for (const { provider, model } of candidates) {
    let client;
    try {
      client = factory.create(provider, model);
    } catch {
      // No base URL configured for this provider. Try the next one.
      continue;
    }

    return {
      provider: provider.name,
      model,
      client: {
        complete: (prompt, options) => client.complete(prompt, options),
      },
    };
  }

  return { reason: 'no usable provider is configured' };
}

export async function runIdeAgent(
  request: AgentRunRequest,
  config: GearVaneConfig,
  env: Record<string, string | undefined>,
  onStep: (step: AgentStep) => void,
  signal: AbortSignal,
): Promise<AgentRunResponse> {
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    return { ok: false, error: 'prompt must be a non-empty string' };
  }
  if (typeof request.root !== 'string' || request.root.trim() === '') {
    return { ok: false, error: 'workspace root must be a non-empty string' };
  }

  // Validated before anything expensive: a bad mode must not stat the disk,
  // resolve a model, or snapshot a workspace first.
  const rawMode = request.mode;
  const mode: AgentMode | undefined =
    rawMode === undefined || rawMode === null
      ? 'build'
      : rawMode === 'ask' || rawMode === 'build'
        ? rawMode
        : undefined;

  if (mode === undefined) {
    return { ok: false, error: 'mode must be "ask" or "build"' };
  }

  try {
    const info = await stat(request.root);
    if (!info.isDirectory()) {
      return { ok: false, error: 'workspace root is not a directory' };
    }
  } catch {
    return { ok: false, error: 'workspace root does not exist' };
  }

  // A malformed selection is rejected before model resolution or snapshots;
  // an unknown-but-well-formed one is rejected by resolveIdeModel below.
  const wanted = request.model;
  if (wanted !== undefined && wanted !== null && typeof wanted !== 'string') {
    return { ok: false, error: 'model must be a string like "provider/model" or a bare model name' };
  }

  const model = resolveIdeModel(env, config.tiers, wanted ?? undefined);
  if (!model.client) {
    return { ok: false, error: `Cannot reach a model: ${model.reason}` };
  }

  installNodeFileSystem();

  const workspace = new Workspace(request.root);
  const registry = new ToolRegistry(toolsForMode(mode));

  const maxIterations =
    typeof request.maxIterations === 'number' &&
    Number.isFinite(request.maxIterations) &&
    request.maxIterations > 0
      ? Math.min(Math.floor(request.maxIterations), 50)
      : 25;

  const before = await snapshotWorkspace(request.root);

  const result = await runAgent(request.prompt, {
    model: model.client,
    registry,
    context: { workspace, maxReadBytes: 256 * 1024 },
    system: mode === 'ask' ? ASK_SYSTEM_PROMPT : VIBE_SYSTEM_PROMPT,
    maxIterations,
    signal,
    onStep,
  });

  // Snapshotted before, compared after: the user reviews what actually
  // changed on disk, not what the transcript claims changed.
  const changed = await diffSnapshot(request.root, before);

  return { ok: true, result, changed, provider: model.provider, model: model.model };
}

export function registerIdeAgentHandlers(loadConfig: () => GearVaneConfig | Promise<GearVaneConfig>): void {
  ipcMain.handle('agent:models', async () => listIdeModels((await loadConfig()).tiers));

  ipcMain.handle('agent:run', async (event, request: AgentRunRequest) => {
    if (active) {
      // The UI disables the button while running; a second call means a bug
      // or a stale renderer, and two interleaved runs would produce a
      // transcript nobody can read.
      return { ok: false, error: 'an agent run is already in progress' } as AgentRunResponse;
    }

    active = new AbortController();
    const signal = active.signal;

    const sender = event.sender;
    const onStep = (step: AgentStep): void => {
      if (!sender.isDestroyed()) sender.send('agent:step', step);
    };

    try {
      // Renderer vault keys win over the shell: they were entered for this
      // device after the process started. sanitizeKeys drops everything but
      // known API key variables, so PATH and friends cannot be overridden
      // across the IPC boundary.
      const env = {
        ...(process.env as Record<string, string | undefined>),
        ...sanitizeKeys(request.keys),
      };
      return await runIdeAgent(request, await loadConfig(), env, onStep, signal);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } as AgentRunResponse;
    } finally {
      active = undefined;
    }
  });

  ipcMain.on('agent:cancel', () => {
    active?.abort();
    active = undefined;
  });
}
