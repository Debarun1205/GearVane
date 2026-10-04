/**
 * Web IDE backend: the full IDE where no host bridges exist.
 *
 * The same renderer bundle runs in the Android webview, where there is no
 * main process, no Node, no PTY, and no folder picker. This module provides
 * the three bridges the IDE mounts against, backed by capabilities a
 * webview does have:
 *
 * - files: a device-local virtual workspace persisted in localStorage,
 * - agent: single-shot Ask answers through @waypoint/core's Orchestrator,
 *   which only needs fetch,
 * - workspace root: a fixed directory (no native picker to ask with).
 *
 * What it deliberately does not provide: a terminal (no shell exists in a
 * webview; the IDE hides the Terminal tab through the optional bridge) and
 * build-mode file edits (the harness tool layer imports node:*, which
 * cannot load here — esbuild leaves those imports bare and the module
 * would die on first touch). Build mode answers with the reason instead
 * of pretending.
 *
 * Nothing here imports node:* or @waypoint/harness values (types only),
 * so bundling this into the renderer cannot poison the webview bundle.
 */

import { Orchestrator, type WaypointConfig } from '@waypoint/core';
import type { AgentResult, AgentStep } from '@waypoint/harness';

/** Fixed workspace: the web has no folder picker to ask with. */
export const WEB_WORKSPACE_ROOT = 'waypoint-workspace';

/** Minimal storage surface, so the backend tests without a DOM. */
export interface WebFsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'waypoint.webfs.v1';

/** Cap mirrored from the main-process reader: huge files stay unopened. */
const MAX_READ_BYTES = 256 * 1024;

/** Cap on search hits: a phone screen cannot use ten thousand rows. */
const MAX_SEARCH_HITS = 100;

const README_SEED = `# Waypoint workspace

This folder lives on this device, inside the app's own storage. Files
you create here persist between launches.

Two honest limits of the mobile IDE: there is no terminal (a webview
has no shell to run), and the agent answers questions but does not
edit files — file-changing builds run in the desktop app, where the
tool layer can load. Everything else is the same IDE: the editor,
the file tree, search, and the full local model roster.
`;

/** Split a user path into clean segments, rejecting escapes. */
function segmentsOf(path: string): string[] | null {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '..')) return null;
  return segments;
}

function joinSegments(segments: string[]): string {
  return segments.join('/');
}

/**
 * Device-local virtual filesystem.
 *
 * Directories are implicit (a file's parent chain), which is all the IDE
 * needs: the tree builds parents from file paths on both backends.
 */
export class WebWorkspace {
  private readonly files = new Map<string, string>();

  constructor(private readonly storage?: WebFsStorage) {
    let seeded = false;
    if (this.storage) {
      try {
        const raw = this.storage.getItem(STORAGE_KEY);
        if (raw) {
          const snapshot = JSON.parse(raw) as { files?: Record<string, string> };
          for (const [path, content] of Object.entries(snapshot.files ?? {})) {
            if (typeof content === 'string') this.files.set(path, content);
          }
          seeded = true;
        }
      } catch {
        // Corrupt snapshot reads as empty; the seed below restores it.
      }
    }
    // First launch or a corrupt snapshot: orient the user instead of an
    // empty explorer. Seeded content is ordinary files, editable and
    // deletable like any other.
    if (!seeded && this.files.size === 0) {
      this.files.set('README.md', README_SEED);
      this.persist();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const files: Record<string, string> = {};
      for (const [path, content] of this.files) files[path] = content;
      this.storage.setItem(STORAGE_KEY, JSON.stringify({ files }));
    } catch {
      // Device-local and non-essential; a full quota must not break editing.
    }
  }

  list(): Array<{ name: string; path: string; isDirectory: boolean; size?: number }> {
    const dirs = new Set<string>();
    const entries: Array<{ name: string; path: string; isDirectory: boolean; size?: number }> = [];
    for (const path of this.files.keys()) {
      const first = path.split('/')[0] as string;
      if (path.includes('/')) {
        dirs.add(first);
      } else {
        const content = this.files.get(path) ?? '';
        entries.push({
          name: first,
          path: first,
          isDirectory: false,
          size: new TextEncoder().encode(content).length,
        });
      }
    }
    const dirEntries = [...dirs]
      .sort()
      .map((name) => ({ name, path: name, isDirectory: true }));
    const fileEntries = entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return [...dirEntries, ...fileEntries];
  }

  read(path: string): { ok: boolean; content?: string; error?: string } {
    const segments = segmentsOf(path);
    if (!segments) return { ok: false, error: 'invalid path' };
    const key = joinSegments(segments);
    const content = this.files.get(key);
    if (content === undefined) return { ok: false, error: `${key} does not exist` };
    if (new TextEncoder().encode(content).length > MAX_READ_BYTES) {
      return { ok: false, error: `${key} is over the 256 KiB open limit` };
    }
    return { ok: true, content };
  }

  write(path: string, content: string): { ok: boolean; error?: string } {
    const segments = segmentsOf(path);
    if (!segments) return { ok: false, error: 'invalid path' };
    if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
    this.files.set(joinSegments(segments), content);
    this.persist();
    return { ok: true };
  }

  remove(path: string): { ok: boolean; error?: string } {
    const segments = segmentsOf(path);
    if (!segments) return { ok: false, error: 'invalid path' };
    const key = joinSegments(segments);
    // Exact file, or a whole subtree when the path names a directory.
    if (this.files.delete(key)) {
      this.persist();
      return { ok: true };
    }
    const prefix = `${key}/`;
    let removed = false;
    for (const existing of [...this.files.keys()]) {
      if (existing.startsWith(prefix)) {
        this.files.delete(existing);
        removed = true;
      }
    }
    if (removed) this.persist();
    return removed ? { ok: true } : { ok: false, error: `${key} does not exist` };
  }

  search(query: string): { ok: boolean; content?: string; error?: string } {
    const needle = query.toLowerCase();
    if (!needle) return { ok: true, content: '' };
    const hits: string[] = [];
    const paths = [...this.files.keys()].sort();
    for (const path of paths) {
      const content = this.files.get(path) ?? '';
      if (content.includes('\0')) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]?.toLowerCase().includes(needle)) {
          hits.push(`${path}:${i + 1}: ${(lines[i] as string).trim()}`);
          if (hits.length >= MAX_SEARCH_HITS) {
            hits.push(`(${MAX_SEARCH_HITS} hits shown; narrow the query for more)`);
            return { ok: true, content: hits.join('\n') };
          }
        }
      }
    }
    return { ok: true, content: hits.join('\n') };
  }
}

export interface WebIdeFsBridge {
  list(root: string): Promise<{
    ok: boolean;
    entries?: Array<{ name: string; path: string; isDirectory: boolean; size?: number }>;
    error?: string;
  }>;
  read(root: string, path: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  write(root: string, path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  remove(root: string, path: string): Promise<{ ok: boolean; error?: string }>;
  search(
    root: string,
    query: string,
    directory?: string,
  ): Promise<{ ok: boolean; content?: string; error?: string }>;
}

export interface WebAgentModel {
  provider: string;
  model: string;
  tier: string;
}

export interface WebAgentDeps {
  /** Current config, so key changes apply to the next run. */
  config: () => WaypointConfig;
  /** Vault keys, so hosted models work without a shell environment. */
  env: () => Record<string, string | undefined>;
}

/**
 * In-webview agent: Ask mode through the core Orchestrator.
 *
 * Ask is a single routed execution, which is all answer-only mode needs.
 * Build mode edits files through the harness tool layer, which cannot load
 * here; it answers with the reason rather than a run that pretends.
 */
export class WebAgentBridge {
  private cancelCurrent: (() => void) | undefined;

  constructor(private readonly deps: WebAgentDeps) {}

  async models(): Promise<WebAgentModel[]> {
    // Same order as the desktop list: every configured pair, tier by tier.
    const models: WebAgentModel[] = [];
    for (const [tier, entry] of Object.entries(this.deps.config().tiers)) {
      for (const provider of entry.providers) {
        for (const model of provider.models) {
          models.push({ provider: provider.name, model, tier });
        }
      }
    }
    return models;
  }

  async run(
    prompt: string,
    _root: string,
    options?: { maxIterations?: number; mode?: 'ask' | 'build'; model?: string; keys?: Record<string, string> },
  ): Promise<{
    ok: boolean;
    result?: AgentResult;
    error?: string;
    provider?: string;
    model?: string;
  }> {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { ok: false, error: 'prompt must be a non-empty string' };
    }
    const mode = options?.mode ?? 'ask';
    // options.keys is accepted for adapter compatibility and ignored: the
    // web backend reads the vault live through deps.env, so a key saved
    // mid-session applies to the next run without re-mounting.
    if (mode !== 'ask') {
      return {
        ok: false,
        error:
          'Build mode edits files through the desktop app\u2019s tool layer, which cannot ' +
          'load in this webview. Ask mode answers here; switch to it, or open the workspace on desktop to build.',
      };
    }

    const picked = this.resolveModel(options?.model);
    if (!picked) {
      return { ok: false, error: `unknown model "${options?.model ?? ''}"` };
    }

    const aborter = new AbortController();
    this.cancelCurrent = () => aborter.abort();
    try {
      // A chosen model pins the run through manualOverride, the same
      // mechanism the desktop config offers. Without one the run routes
      // normally, landing on the cheapest tier that can do the job.
      const base = this.deps.config();
      const config =
        picked.explicit && options?.model
          ? { ...base, router: { ...base.router, manualOverride: options.model } }
          : base;
      const orchestrator = new Orchestrator(config, { env: this.deps.env() });
      const taskId = `web-${Date.now().toString(36)}`;
      const result = await orchestrator.execute(taskId, prompt, { signal: aborter.signal });
      if (!result.success) {
        return { ok: false, error: result.error || 'the run failed' };
      }
      return {
        ok: true,
        result: {
          content: result.content,
          stopReason: 'completed',
          iterations: Math.max(result.attempts, 1),
          steps: [],
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          failedToolCalls: [],
          compactions: 0,
        },
        provider: result.provider,
        model: result.model,
      };
    } catch (error) {
      if (aborter.signal.aborted) return { ok: false, error: 'cancelled' };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.cancelCurrent = undefined;
    }
  }

  cancel(): void {
    this.cancelCurrent?.();
    this.cancelCurrent = undefined;
  }

  onStep(_handler: (step: AgentStep) => void): () => void {
    // Single-shot runs emit no intermediate steps.
    return () => {};
  }

  /**
   * Model resolution mirrors the desktop default: a provider/model or bare
   * name wins on exact match, otherwise the first configured pair. The
   * `explicit` flag tells run() whether to pin the choice.
   */
  private resolveModel(wanted?: string): { provider?: string; model?: string; explicit: boolean } | undefined {
    const tiers = this.deps.config().tiers;
    if (typeof wanted === 'string' && wanted !== '') {
      for (const tier of Object.values(tiers)) {
        for (const provider of tier.providers) {
          for (const model of provider.models) {
            if (`${provider.name}/${model}` === wanted) {
              return { provider: provider.name, model, explicit: true };
            }
          }
        }
      }
      for (const tier of Object.values(tiers)) {
        for (const provider of tier.providers) {
          if (provider.models.includes(wanted)) {
            return { provider: provider.name, model: wanted, explicit: true };
          }
        }
      }
      return undefined;
    }
    for (const tier of Object.values(tiers)) {
      const provider = tier.providers[0];
      const model = provider?.models[0];
      if (provider && model) return { provider: provider.name, model, explicit: false };
    }
    return undefined;
  }
}

/**
 * Assemble the three bridges the IDE mounts against, for hosts that have
 * none of their own. The renderer prefers real bridges and falls back to
 * these, so Electron behaviour is untouched.
 */
export function createWebBackend(deps: WebAgentDeps & { storage?: WebFsStorage }): {
  workspace: WebWorkspace;
  workspaceRoot: () => Promise<string>;
  ideFs: WebIdeFsBridge;
  agent: WebAgentBridge;
} {
  const workspace = new WebWorkspace(deps.storage);
  const agent = new WebAgentBridge(deps);
  const ideFs: WebIdeFsBridge = {
    list: (_root) => Promise.resolve({ ok: true, entries: workspace.list() }),
    read: (_root, path) => Promise.resolve(workspace.read(path)),
    write: (_root, path, content) => Promise.resolve(workspace.write(path, content)),
    remove: (_root, path) => Promise.resolve(workspace.remove(path)),
    search: (_root, query) => Promise.resolve(workspace.search(query)),
  };
  return {
    workspace,
    workspaceRoot: () => Promise.resolve(WEB_WORKSPACE_ROOT),
    ideFs,
    agent,
  };
}
