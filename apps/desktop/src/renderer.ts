/**
 * Renderer entry point.
 *
 * Bundled to a single file so the identical JavaScript runs in the Electron
 * renderer and, unchanged, as static assets inside the Android webview. Any
 * host-specific capability is reached through a narrow bridge object that is
 * absent in a plain browser, so nothing here assumes Electron exists.
 */

import {
  AppController,
  SAMPLE_PROMPTS,
  budgetExhausted,
  canSubmit,
  initialState,
  nextId,
  reducer,
  spendFraction,
  type Action,
  type AppState,
} from '@waypoint/app-core';
import {
  defaultConfig,
  type WaypointConfig,
} from '@waypoint/core';

// Type-only, so the builder view is not pulled into the Android bundle at the
// entry point. It is loaded on demand below, and only where the bridge exists.
import type { BuilderBridge } from './builder-view.js';
import type { TerminalBridge } from './ide/terminal.js';

/** Capabilities the host may provide. Every one is optional. */
interface HostBridge {
  appInfo?(): Promise<{ platform?: string; version?: string }>;
  readConfig?(): Promise<{ config: WaypointConfig; path: string | null; error: string | null }>;
  on?(channel: 'config:error', handler: (payload: string) => void): () => void;

  /**
   * Builder surface, present only in the desktop app.
   *
   * Optional because the same renderer runs in an Android webview, where there
   * is no filesystem to write to and no folder picker to ask with.
   */
  builder?: BuilderBridge;

  /** Terminal bridge, present only where a PTY can be created. */
  terminal?: TerminalBridge;

  /** The directory the IDE should work in. */
  workspaceRoot?(): Promise<string | null>;

  /** IDE filesystem bridge. Absent where there is no filesystem to use. */
  ideFs?: IdeFsBridge;
}

interface IdeFsBridge {
  list(root: string): Promise<{ ok: boolean; entries?: Array<{ name: string; path: string; isDirectory: boolean; size?: number }>; error?: string }>;
  read(root: string, path: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  write(root: string, path: string, content: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    waypoint?: HostBridge;
  }
}

const bridge: HostBridge = window.waypoint ?? {};

let state: AppState = initialState();
let controller: AppController | undefined;
let activeTaskId: string | null = null;

const els = {
  transcript: byId('transcript'),
  welcome: byId('welcome'),
  samples: byId('samples'),
  input: byId<HTMLTextAreaElement>('input'),
  send: byId<HTMLButtonElement>('send'),
  cancel: byId<HTMLButtonElement>('cancel'),
  clear: byId<HTMLButtonElement>('clear'),
  health: byId<HTMLButtonElement>('health-button'),
  healthDialog: byId<HTMLDialogElement>('health-dialog'),
  healthBody: byId('health-body'),
  tierBadge: byId('tier-badge'),
  spendFill: byId('spend-fill'),
  spendMeter: byId('spend-meter'),
  hint: byId('hint'),
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: #${id}`);
  return element as T;
}

// --- state ------------------------------------------------------------------

function dispatch(action: Action): void {
  state = reducer(state, action);
  render();
}

function updateFromController(): void {
  if (!controller) return;
  const status = controller.spendStatus();
  dispatch({ type: 'setSpend', spendUsd: status.sessionSpend });
}

// --- rendering --------------------------------------------------------------

function render(): void {
  renderTranscript();
  renderTierBadge();
  renderSpend();
  renderComposer();
}

function renderTranscript(): void {
  const previousCount = els.transcript.querySelectorAll('.message').length;

  // Only rebuild the message list when it actually changed; rebuilding on
  // every token would fight the user's scroll position.
  if (previousCount === state.messages.length) {
    updateLastMessage();
    return;
  }

  els.transcript.querySelectorAll('.message').forEach((node) => node.remove());

  if (state.messages.length > 0 && els.welcome.isConnected) {
    els.welcome.remove();
  }

  for (const message of state.messages) {
    els.transcript.appendChild(renderMessage(message));
  }

  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function updateLastMessage(): void {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;

  const nodes = els.transcript.querySelectorAll('.message');
  const node = nodes[nodes.length - 1];
  if (!node) {
    renderTranscript();
    return;
  }

  const body = node.querySelector('.message-body');
  if (body && body.textContent !== last.content) {
    body.textContent = last.content;
  }
  node.classList.toggle('caret', last.pending === true);
}

function renderMessage(message: AppState['messages'][number]): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role}`;
  if (message.pending) wrapper.classList.add('caret');

  const role = document.createElement('div');
  role.className = 'message-role';
  role.textContent = message.role === 'user' ? 'You' : 'Waypoint';
  wrapper.appendChild(role);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = message.content;
  wrapper.appendChild(body);

  if (message.tier || message.costUsd !== undefined || message.durationMs !== undefined) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';

    if (message.tier) meta.appendChild(metaItem('tier', message.tier));
    if (message.model) meta.appendChild(metaItem('model', message.model));
    if (message.confidence !== undefined) {
      meta.appendChild(metaItem('confidence', `${Math.round(message.confidence * 100)}%`));
    }
    if (message.durationMs !== undefined) {
      meta.appendChild(metaItem('took', `${message.durationMs}ms`));
    }
    if (message.costUsd) meta.appendChild(metaItem('cost', `$${message.costUsd.toFixed(4)}`));

    wrapper.appendChild(meta);
  }

  if (message.error) {
    const error = document.createElement('div');
    error.className = 'message-error';
    error.textContent = message.error;
    wrapper.appendChild(error);
  }

  return wrapper;
}

function metaItem(label: string, value: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = `${label}: ${value}`;
  return span;
}

function renderTierBadge(): void {
  const draft = state.draft.trim();

  if (!draft || !controller) {
    els.tierBadge.textContent = 'no prompt';
    els.tierBadge.className = 'tier-badge tier-none';
    return;
  }

  // Preview while typing so the user sees the tier before committing.
  const preview = controller.preview(draft);
  els.tierBadge.textContent = preview.tier;
  els.tierBadge.className = `tier-badge tier-${preview.tier}`;
  els.tierBadge.title = `${preview.provider}/${preview.model} - ${preview.reasons.join('; ')}`;
}

function renderSpend(): void {
  const fraction = spendFraction(state);
  els.spendFill.style.width = `${Math.round(fraction * 100)}%`;
  els.spendFill.className =
    'spend-fill' + (fraction >= 1 ? ' spend-full' : fraction >= 0.7 ? ' warn' : '');
  els.spendMeter.title = `$${state.sessionSpendUsd.toFixed(4)} of $${state.limits.perSession}`;
}

function renderComposer(): void {
  els.send.disabled = !canSubmit(state);
  els.cancel.hidden = !state.busy;

  if (budgetExhausted(state)) {
    els.hint.textContent =
      'Session budget reached. Raise safety.spend_limits or clear the session to keep going.';
    els.hint.classList.add('warn');
  }
}

function renderSamples(): void {
  els.samples.textContent = '';

  for (const sample of SAMPLE_PROMPTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample';
    button.title = sample.why;

    const title = document.createElement('span');
    title.className = 'sample-title';
    title.textContent = sample.title;

    const why = document.createElement('span');
    why.className = 'sample-why';
    why.textContent = sample.why;

    button.append(title, why);
    button.addEventListener('click', () => {
      els.input.value = sample.prompt;
      els.input.focus();
      dispatch({ type: 'setDraft', draft: sample.prompt });
    });

    els.samples.appendChild(button);
  }
}

// --- actions ----------------------------------------------------------------

async function send(): Promise<void> {
  const prompt = state.draft.trim();
  if (!prompt || state.busy || !controller) return;

  const messageId = nextId('turn');
  activeTaskId = messageId;
  dispatch({ type: 'submit', messageId });

  try {
    const result = await controller.submit({
      taskId: messageId,
      prompt,
      stream: true,
      onToken: (_token, accumulated) => {
        // submitStreaming reports the full accumulated text on every token,
        // so replace the bubble rather than appending to it.
        state = {
          ...state,
          messages: state.messages.map((message) =>
            message.id === `${messageId}-reply`
              ? { ...message, content: accumulated }
              : message,
          ),
        };
        render();
      },
    });

    dispatch({ type: 'streamEnd', messageId: `${messageId}-reply` });

    if (result.success) {
      dispatch({ type: 'succeeded', messageId, result });
    } else {
      dispatch({ type: 'failed', messageId, error: result.error ?? 'Request failed' });
    }
  } catch (error) {
    dispatch({
      type: 'failed',
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeTaskId = null;
    updateFromController();
    render();
  }
}

function cancel(): void {
  if (!activeTaskId || !controller) return;
  controller.cancel(activeTaskId);
  dispatch({ type: 'streamEnd', messageId: `${activeTaskId}-reply` });
  activeTaskId = null;
  render();
}

async function showHealth(): Promise<void> {
  if (!controller) return;

  els.healthBody.textContent = 'Checking...';
  if (typeof els.healthDialog.showModal === 'function') els.healthDialog.showModal();

  const results = await controller.checkHealth();
  els.healthBody.textContent = '';

  if (results.length === 0) {
    els.healthBody.textContent = 'No models configured.';
    return;
  }

  for (const result of results) {
    const row = document.createElement('div');
    row.className = 'health-row';

    const name = document.createElement('span');
    name.textContent = `${result.provider}/${result.model}`;

    const status = document.createElement('span');
    status.className = `health-status-${result.status}`;
    status.textContent = result.status;

    row.append(name, status);
    els.healthBody.appendChild(row);
  }
}

function autoGrow(): void {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 192)}px`;
}

// --- wiring -----------------------------------------------------------------

async function resolveConfig(): Promise<{ config: WaypointConfig; error: string | null }> {
  if (bridge.readConfig) {
    try {
      const loaded = await bridge.readConfig();
      return { config: loaded.config, error: loaded.error };
    } catch (error) {
      return {
        config: defaultConfig(readEnv()),
        error: `Could not read host config: ${(error as Error).message}`,
      };
    }
  }

  // Plain browser (for example the Android webview): try a config served
  // alongside the page, then fall back to defaults.
  try {
    const response = await fetch('./waypoint.config.json');
    if (response.ok) {
      const { parseConfig } = await import('@waypoint/core');
      return { config: parseConfig(await response.text(), 'json'), error: null };
    }
  } catch {
    // No config served; defaults are fine.
  }

  return { config: defaultConfig(readEnv()), error: null };
}

/**
 * Keys are never read in the renderer: there is no environment there, and
 * credentials must arrive through the host bridge or a served config.
 */
function readEnv(): Record<string, string | undefined> {
  return {};
}

async function main(): Promise<void> {
  renderSamples();

  const { config, error } = await resolveConfig();
  state = { ...state, limits: config.safety.spendLimits };
  controller = new AppController({
    config,
    // The renderer has no environment, so keys come from the host via the
    // bridge or from the served config. Local models need neither.
    env: {},
  });

  if (error) {
    els.hint.textContent = `Config problem: ${error}`;
    els.hint.classList.add('warn');
  }

  els.send.addEventListener('click', () => void send());
  els.cancel.addEventListener('click', cancel);
  els.health.addEventListener('click', () => void showHealth());

  const builderToggle = document.getElementById('builder-toggle');
  const builderDialog = document.getElementById('builder-dialog');
  if (builderToggle && builderDialog) {
    builderToggle.addEventListener('click', () => {
      if (builderDialog instanceof HTMLDialogElement) builderDialog.showModal();
    });
  }

  // The IDE needs a workspace and a terminal bridge, so it only mounts in the
  // desktop app with a folder open.
  const ideToggle = document.getElementById('ide-toggle');
  const ideDialog = document.getElementById('ide-dialog');
  if (ideToggle && ideDialog) {
    ideToggle.addEventListener('click', () => {
      if (ideDialog instanceof HTMLDialogElement) ideDialog.showModal();
    });
  }

  els.clear.addEventListener('click', () => {
    controller?.cancelAll();
    activeTaskId = null;
    state = { ...initialState(), limits: state.limits };

    // The welcome panel is removed on first message, so put it back.
    if (!els.welcome.isConnected) {
      els.transcript.prepend(els.welcome);
    }
    els.transcript.querySelectorAll('.message').forEach((node) => node.remove());
    els.input.value = '';
    autoGrow();
    render();
  });

  els.input.addEventListener('input', () => {
    autoGrow();
    dispatch({ type: 'setDraft', draft: els.input.value });
  });

  els.input.addEventListener('keydown', (event) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });

  bridge.on?.('config:error', (message) => {
    els.hint.textContent = `Config problem: ${message}`;
    els.hint.classList.add('warn');
  });

  // The builder needs the host bridge, so it only mounts in the desktop app.
  // The Android webview has no filesystem and no folder picker, which is
  // exactly the limitation the website builder's download path works around.
  // The toggle is hidden where the builder cannot work, so the button never
  // opens an empty dialog.
  const builderHost = document.getElementById('builder');
  if (!bridge.builder && builderToggle instanceof HTMLButtonElement) {
    builderToggle.hidden = true;
  }
  if (builderHost && bridge.builder) {
    try {
      const { BuilderView } = await import('./builder-view.js');
      new BuilderView(builderHost, bridge.builder).start();
    } catch (error) {
      builderHost.textContent = `Builder unavailable: ${(error as Error).message}`;
    }
  }

  // The IDE needs a workspace, a terminal bridge, and a filesystem bridge, so
  // it only mounts where all three exist. Monaco is loaded on demand, because
  // it is several megabytes and the chat view must not pay for it.
  const ideHost = document.getElementById('ide');
  if ((!bridge.terminal || !bridge.ideFs) && ideToggle instanceof HTMLButtonElement) {
    ideToggle.hidden = true;
  }
  if (ideHost && bridge.terminal && bridge.ideFs) {
    try {
      const { IdeView } = await import('./ide/ide-view.js');
      const root = bridge.workspaceRoot ? await bridge.workspaceRoot() : null;
      if (root) {
        const ideFs = bridge.ideFs;
        const view = new IdeView({
          workspaceRoot: root,
          terminal: bridge.terminal,
          fs: {
            list: () => ideFs.list(root),
            read: (path) => ideFs.read(root, path),
            write: (path, content) => ideFs.write(root, path, content),
          },
        });
        view.mount(ideHost);
      } else {
        ideHost.textContent = 'Choose a folder to use the IDE.';
      }
    } catch (error) {
      ideHost.textContent = `IDE unavailable: ${(error as Error).message}`;
    }
  }

  window.addEventListener('beforeunload', () => controller?.cancelAll());

  render();
}

void main();