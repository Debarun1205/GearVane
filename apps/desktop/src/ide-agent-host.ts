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

import { ProviderFactory, type WaypointConfig } from '@waypoint/core';
import {
  ToolRegistry,
  Workspace,
  builderTools,
  fileTools,
  installNodeFileSystem,
  runAgent,
  searchFilesTool,
  type AgentModel,
  type AgentResult,
  type AgentStep,
} from '@waypoint/harness';

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

export interface AgentRunRequest {
  prompt: unknown;
  root: unknown;
  maxIterations?: unknown;
}

export interface AgentRunResponse {
  ok: boolean;
  result?: AgentResult;
  error?: string;
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
  tiers: WaypointConfig['tiers'],
): { client?: AgentModel; provider?: string; reason?: string } {
  const factory = new ProviderFactory({ env });

  for (const tier of Object.values(tiers)) {
    for (const provider of tier.providers) {
      let client;
      try {
        client = factory.create(provider);
      } catch {
        // No base URL configured for this provider. Try the next one.
        continue;
      }

      return {
        provider: provider.name,
        client: {
          complete: (prompt, options) => client.complete(prompt, options),
        },
      };
    }
  }

  return { reason: 'no usable provider is configured' };
}

export async function runIdeAgent(
  request: AgentRunRequest,
  config: WaypointConfig,
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

  try {
    const info = await stat(request.root);
    if (!info.isDirectory()) {
      return { ok: false, error: 'workspace root is not a directory' };
    }
  } catch {
    return { ok: false, error: 'workspace root does not exist' };
  }

  const model = resolveIdeModel(env, config.tiers);
  if (!model.client) {
    return { ok: false, error: `Cannot reach a model: ${model.reason}` };
  }

  installNodeFileSystem();

  const workspace = new Workspace(request.root);
  const registry = new ToolRegistry([...fileTools(), ...builderTools(), searchFilesTool]);

  const maxIterations =
    typeof request.maxIterations === 'number' &&
    Number.isFinite(request.maxIterations) &&
    request.maxIterations > 0
      ? Math.min(Math.floor(request.maxIterations), 50)
      : 25;

  const result = await runAgent(request.prompt, {
    model: model.client,
    registry,
    context: { workspace, maxReadBytes: 256 * 1024 },
    system: VIBE_SYSTEM_PROMPT,
    maxIterations,
    signal,
    onStep,
  });

  return { ok: true, result };
}

export function registerIdeAgentHandlers(loadConfig: () => WaypointConfig): void {
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
      return await runIdeAgent(
        request,
        loadConfig(),
        process.env as Record<string, string | undefined>,
        onStep,
        signal,
      );
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
