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
import {
  ACCENTS,
  APPEARANCE_EVENT,
  BACKGROUNDS,
  MOTIONS,
  THEMES,
  applyAppearance,
  hasOnboarded,
  loadAppearance,
  markOnboarded,
  resolveAppearance,
  saveAppearance,
  type Appearance,
  type AppearanceStorage,
} from './theme.js';
import {
  KEY_FIELDS,
  clearKeys,
  loadKeys,
  saveKeys,
  type KeyStorage,
} from './keys.js';

// Type-only, so the builder view is not pulled into the Android bundle at the
// entry point. It is loaded on demand below, and only where the bridge exists.
import type { BuilderBridge } from './builder-view.js';
import type { TerminalBridge } from './ide/terminal.js';
import type { AgentResult, AgentStep } from '@waypoint/harness';

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

  /** IDE agent bridge. Absent where the harness tool layer cannot load. */
  agent?: AgentBridge;
}

export interface IdeAgentModel {
  provider: string;
  model: string;
  tier: string;
}

interface AgentBridge {
  models(): Promise<IdeAgentModel[]>;
  run(
    prompt: string,
    root: string,
    options?: { maxIterations?: number; mode?: 'ask' | 'build'; model?: string; keys?: Record<string, string> },
  ): Promise<{
    ok: boolean;
    result?: AgentResult;
    error?: string;
    provider?: string;
    model?: string;
    changed?: Array<{ path: string; original: string | null; current: string }>;
  }>;
  cancel(): void;
  onStep(handler: (step: AgentStep) => void): () => void;
}

interface IdeFsBridge {
  list(root: string): Promise<{ ok: boolean; entries?: Array<{ name: string; path: string; isDirectory: boolean; size?: number }>; error?: string }>;
  read(root: string, path: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  write(root: string, path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  remove(root: string, path: string): Promise<{ ok: boolean; error?: string }>;
  search(root: string, query: string, directory?: string): Promise<{ ok: boolean; content?: string; error?: string }>;
}

declare global {
  interface Window {
    waypoint?: HostBridge;
  }
}

const bridge: HostBridge = window.waypoint ?? {};

/**
 * localStorage through a never-throwing wrapper.
 *
 * Accessing the property itself can throw where storage is disabled, which
 * would kill the module before the themed first paint. Losing the look is
 * acceptable; losing the app is not.
 */
const appearanceStorage: AppearanceStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The look is device-local and non-essential; skip it.
    }
  },
};

// Applied at module evaluation, before main(), so the first paint is
// already the user's theme rather than the default flashing to it.
applyAppearance(document.documentElement, loadAppearance(appearanceStorage));

let state: AppState = initialState();
let controller: AppController | undefined;
let activeTaskId: string | null = null;
// The config the controller runs on, and whether it is built-in defaults.
// Keys can reshape defaults (toggling hosted tiers on) but never a host
// or served config, which the user owns.
let activeConfig: WaypointConfig | undefined;
let configFromDefaults = false;

/**
 * Build the chat controller with the vault's keys.
 *
 * Keys authenticate whatever providers the config carries; on a
 * defaults-derived config they also switch the hosted tiers on, because
 * defaultConfig only lists a hosted provider when its key is present.
 * Health probes inherit the same keys through the controller.
 */
function buildController(config: WaypointConfig): AppController {
  return new AppController({ config, env: readEnv() });
}

/**
 * Rebuild the controller after the vault changes, without losing the chat.
 *
 * Only defaults-derived configs are rebuilt: a host or served config is
 * owned by the user, and silently rewriting it would be a surprise.
 */
function applyKeys(): void {
  if (configFromDefaults) {
    activeConfig = defaultConfig(readEnv());
  }
  if (!activeConfig) return;
  state = { ...state, limits: activeConfig.safety.spendLimits };
  controller = buildController(activeConfig);
  syncKeysButton();
  render();
}

const els = {
  transcript: byId('transcript'),
  welcome: byId('welcome'),
  samples: byId('samples'),
  input: byId<HTMLTextAreaElement>('input'),
  send: byId<HTMLButtonElement>('send'),
  cancel: byId<HTMLButtonElement>('cancel'),
  clear: byId<HTMLButtonElement>('clear-button'),
  health: byId<HTMLButtonElement>('health-button'),
  healthDialog: byId<HTMLDialogElement>('health-dialog'),
  healthBody: byId('health-body'),
  keysButton: byId<HTMLButtonElement>('keys-button'),
  keysDialog: byId<HTMLDialogElement>('keys-dialog'),
  keysFields: byId('keys-fields'),
  keysSave: byId<HTMLButtonElement>('keys-save'),
  keysClear: byId<HTMLButtonElement>('keys-clear'),
  tierBadge: byId('tier-badge'),
  spendFill: byId('spend-fill'),
  spendMeter: byId('spend-meter'),
  hint: byId('hint'),
  appearanceDialog: byId<HTMLDialogElement>('appearance-dialog'),
  appearanceTitle: byId('appearance-title'),
  appearanceLede: byId('appearance-lede'),
  appearanceCancel: byId<HTMLButtonElement>('appearance-cancel'),
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

// --- appearance -------------------------------------------------------------

/** State as last previewed, and the state to revert to on cancel. */
let pendingAppearance: Appearance = loadAppearance(appearanceStorage);
let appearanceSnapshot: Appearance = { ...pendingAppearance };

/**
 * Build the dialog's option buttons once.
 *
 * Everything is createElement and textContent: no template string is ever
 * parsed as HTML, so a preset name cannot inject markup.
 */
function wireAppearance(): void {
  const makeOption = (
    container: HTMLElement,
    kind: keyof Appearance,
    id: string,
    name: string,
    vibe: string,
  ): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'appearance-option';
    button.dataset.kind = kind;
    button.dataset.value = id;
    button.setAttribute('aria-pressed', 'false');

    if (kind === 'theme') {
      const theme = THEMES.find((entry) => entry.id === id);
      const swatch = document.createElement('span');
      swatch.className = 'appearance-swatch';
      if (theme) {
        swatch.style.background = `linear-gradient(90deg, ${theme.swatch.join(', ')})`;
      }
      button.appendChild(swatch);
    }

    const head = document.createElement('span');
    head.className = 'appearance-option-head';

    const label = document.createElement('span');
    label.className = 'appearance-option-name';
    label.textContent = name;
    head.appendChild(label);

    const themePreset = kind === 'theme' ? THEMES.find((entry) => entry.id === id) : undefined;
    if (themePreset?.suggested) {
      const badge = document.createElement('span');
      badge.className = 'appearance-badge';
      badge.textContent = 'Suggested';
      head.appendChild(badge);
    }
    button.appendChild(head);

    const why = document.createElement('span');
    why.className = 'appearance-option-vibe';
    why.textContent = vibe;
    button.appendChild(why);

    button.addEventListener('click', () => previewAppearance(kind, id));
    container.appendChild(button);
  };

  const themes = byId('appearance-themes');
  for (const theme of THEMES) {
    makeOption(themes, 'theme', theme.id, theme.name, theme.vibe);
  }

  const backgrounds = byId('appearance-backgrounds');
  for (const background of BACKGROUNDS) {
    makeOption(backgrounds, 'background', background.id, background.name, background.vibe);
  }

  const accents = byId('appearance-accents');
  for (const accent of ACCENTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'appearance-accent';
    button.dataset.kind = 'accent';
    button.dataset.value = accent.id;
    button.style.background = accent.color;
    button.title = accent.name;
    button.setAttribute('aria-label', `Accent: ${accent.name}`);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => previewAppearance('accent', accent.id));
    accents.appendChild(button);
  }

  const motions = byId('appearance-motion');
  for (const motion of MOTIONS) {
    makeOption(motions, 'motion', motion.id, motion.name, motion.vibe);
  }

  // Save persists; Cancel and the Escape key both land here with any other
  // returnValue, which reverts the live preview to the opening snapshot.
  els.appearanceDialog.addEventListener('close', () => {
    const saved = els.appearanceDialog.returnValue === 'save';
    if (saved) {
      saveAppearance(appearanceStorage, pendingAppearance);
      applyAppearance(document.documentElement, pendingAppearance);
    } else {
      applyAppearance(document.documentElement, appearanceSnapshot);
      pendingAppearance = { ...appearanceSnapshot };
    }
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
  });

  syncAppearanceButtons();
}

/** Apply a choice immediately; nothing is written until Save. */
function previewAppearance(kind: keyof Appearance, id: string): void {
  pendingAppearance = resolveAppearance({ ...pendingAppearance, [kind]: id });
  applyAppearance(document.documentElement, pendingAppearance);
  syncAppearanceButtons();
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
}

/** Move the aria-pressed state onto the current choice in each group. */
function syncAppearanceButtons(): void {
  // Array.from, not a direct for-of: the tsconfig does not include the
  // DOM.Iterable lib, so a NodeList is not itself iterable here.
  const buttons = Array.from(
    els.appearanceDialog.querySelectorAll<HTMLButtonElement>('[data-kind]'),
  );
  for (const button of buttons) {
    const kind = button.dataset.kind as keyof Appearance;
    button.setAttribute(
      'aria-pressed',
      String(pendingAppearance[kind] === button.dataset.value),
    );
  }
}

/**
 * Open the dialog, as first-run onboarding or as settings.
 *
 * returnValue is cleared here because it survives between openings: a stale
 * 'save' from last time would otherwise make the Escape key persist a
 * preview the user never confirmed.
 */
function openAppearance(mode: 'onboarding' | 'settings'): void {
  pendingAppearance = loadAppearance(appearanceStorage);
  appearanceSnapshot = { ...pendingAppearance };

  if (mode === 'onboarding') {
    els.appearanceTitle.textContent = 'Make Waypoint yours';
    els.appearanceLede.textContent =
      'Pick a theme, a background, an accent, and a motion style. ' +
      'Choices apply as you make them; only Save look keeps them. ' +
      'You can change all of it any time from Look in the top bar.';
    els.appearanceCancel.textContent = 'Skip for now';
  } else {
    els.appearanceTitle.textContent = 'Appearance';
    els.appearanceLede.textContent =
      'Themes, background, accent, and motion. Changes apply instantly ' +
      'and are only kept when you save.';
    els.appearanceCancel.textContent = 'Cancel';
  }

  syncAppearanceButtons();
  els.appearanceDialog.returnValue = '';
  if (typeof els.appearanceDialog.showModal === 'function') {
    els.appearanceDialog.showModal();
  }
}

// --- keys -------------------------------------------------------------------

function syncKeysButton(): void {
  const count = Object.keys(loadKeys(keyStorage)).length;
  els.keysButton.title =
    count > 0 ? `API keys (${count} stored on this device)` : 'API keys (none stored)';
}

/**
 * Build the Keys dialog once and keep it fed from the vault.
 *
 * Inputs are created here, not in the static markup: there are eleven and
 * counting, and generating them from KEY_FIELDS keeps markup and code from
 * drifting. The dialog always opens prefilled, so Cancel and Escape revert
 * for free.
 */
function wireKeys(): void {
  els.keysFields.textContent = '';
  const inputs = new Map<string, HTMLInputElement>();
  for (const field of KEY_FIELDS) {
    const label = document.createElement('label');
    label.className = 'builder-label';
    label.textContent = field.label;

    const input = document.createElement('input');
    input.className = 'builder-input keys-input';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = field.env;
    input.setAttribute('aria-label', `${field.label} API key`);

    label.append(input);
    els.keysFields.append(label);
    inputs.set(field.env, input);
  }

  const open = (): void => {
    const stored = loadKeys(keyStorage);
    for (const [env, input] of inputs) input.value = stored[env] ?? '';
    if (typeof els.keysDialog.showModal === 'function') els.keysDialog.showModal();
  };
  els.keysButton.addEventListener('click', open);
  // The IDE top bar lives in markup that is hidden until the IDE mounts;
  // wiring it here is safe because the listener waits for a click.
  document.getElementById('ide-keys-toggle')?.addEventListener('click', open);

  els.keysSave.addEventListener('click', () => {
    const next: Record<string, string> = {};
    for (const [env, input] of inputs) next[env] = input.value;
    // Sanitized again on save: pasted whitespace is not a key.
    saveKeys(keyStorage, next);
    applyKeys();
    // The surrounding form uses method=dialog, so this submit closes it.
  });

  els.keysClear.addEventListener('click', () => {
    for (const input of inputs.values()) input.value = '';
    clearKeys(keyStorage);
    applyKeys();
  });
}

// --- wiring -----------------------------------------------------------------

async function resolveConfig(): Promise<{
  config: WaypointConfig;
  error: string | null;
  /** True when the config is built-in defaults, which keys can reshape. */
  fromDefaults?: boolean;
}> {
  if (bridge.readConfig) {
    try {
      const loaded = await bridge.readConfig();
      return { config: loaded.config, error: loaded.error };
    } catch (error) {
      return {
        config: defaultConfig(readEnv()),
        error: `Could not read host config: ${(error as Error).message}`,
        fromDefaults: true,
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

  // Built-in defaults, with hosted tiers toggled by whatever keys the
  // vault holds — the only way keys can enable providers where there is
  // no host config to read. fromDefaults lets applyKeys rebuild this
  // when the vault changes.
  return { config: defaultConfig(readEnv()), error: null, fromDefaults: true };
}

/**
 * Keys are never read in the renderer process environment: there is none,
 * and credentials must arrive through the host bridge, a served config, or
 * the device-local vault below. Local models need none of these.
 */
function readEnv(): Record<string, string | undefined> {
  return loadKeys(keyStorage);
}

/**
 * Device-local key vault, beside the appearance settings.
 *
 * A never-throwing wrapper like the appearance one: storage can be
 * disabled, and losing the vault must not kill the app. Entries are
 * sanitized on every read, so a hand-edited value cannot smuggle
 * unrelated variables into provider calls.
 */
const keyStorage: KeyStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Device-local and non-essential; skip it.
    }
  },
  removeItem: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Already gone or disabled; either way the goal is met.
    }
  },
};

async function main(): Promise<void> {
  renderSamples();

  // Appearance first: the dialog is part of the static markup, and showing
  // it before the config resolves keeps first launch feeling instant.
  wireAppearance();
  const appearanceToggle = document.getElementById('appearance-toggle');
  appearanceToggle?.addEventListener('click', () => openAppearance('settings'));
  if (!hasOnboarded(appearanceStorage)) {
    // Marked seen the moment it opens, not when it closes. The flag means
    // "this dialog has been shown", and the close event is a queued task: a
    // fast reopen can run openAppearance('settings') before that task fires,
    // which made marking-on-close lose the flag entirely (reproduced under
    // automated driving of the page).
    openAppearance('onboarding');
    markOnboarded(appearanceStorage);
  }

  const { config, error, fromDefaults } = await resolveConfig();
  activeConfig = config;
  configFromDefaults = fromDefaults ?? false;
  state = { ...state, limits: config.safety.spendLimits };
  controller = buildController(config);
  wireKeys();
  syncKeysButton();

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

  // The chat view's IDE button. It stays visible wherever the bridges exist
  // and opens the full-window IDE; where they do not (Android) it is hidden
  // by the mount block below.
  const ideToggle = document.getElementById('ide-toggle');

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

  // The IDE is the desktop app's main UI. It needs a terminal bridge, a
  // filesystem bridge, and an agent bridge, so it only mounts where all three
  // exist — the Android webview has none of them and keeps the chat UI.
  // Monaco is loaded on demand, because it is several megabytes and the chat
  // view must not pay for it.
  //
  // On launch the IDE opens straight into the last workspace. With no stored
  // workspace the app opens on chat instead of popping a native folder dialog
  // uninvited; the IDE button takes it from there.
  const ideHost = document.getElementById('ide');
  const ideRoot = document.getElementById('ide-root');
  const appRoot = document.querySelector('.app');
  const ideCapable = Boolean(
    ideHost && ideRoot && bridge.terminal && bridge.ideFs && bridge.agent,
  );

  if (!ideCapable && ideToggle instanceof HTMLButtonElement) {
    ideToggle.hidden = true;
  }

  if (
    ideCapable && ideHost && ideRoot && appRoot &&
    bridge.terminal && bridge.ideFs && bridge.agent
  ) {
    const terminal = bridge.terminal;
    const ideFs = bridge.ideFs;
    const agent = bridge.agent;

    const mountIde = async (root: string): Promise<boolean> => {
      try {
        const { IdeView } = await import('./ide/ide-view.js');
        const { resolveInlineModel } = await import('./ide/inline-complete.js');
        const view = new IdeView({
          workspaceRoot: root,
          completion: resolveInlineModel(config),
          terminal,
          fs: {
            list: () => ideFs.list(root),
            read: (path) => ideFs.read(root, path),
            write: (path, content) => ideFs.write(root, path, content),
            remove: (path) => ideFs.remove(root, path),
            search: (query) => ideFs.search(root, query),
          },
          agent: {
            models: () => agent.models(),
            // Keys ride with the run and are allowlisted in the main
            // process, so a packaged app without shell environment still
            // reaches hosted models.
            run: (prompt, options) => agent.run(prompt, root, { ...options, keys: loadKeys(keyStorage) }),
            cancel: () => agent.cancel(),
            onStep: (handler) => agent.onStep(handler),
          },
        });
        ideHost.textContent = '';
        view.mount(ideHost);
        rememberWorkspaceRoot(root);
        showIdeFolder(root);
        appRoot.setAttribute('hidden', '');
        ideRoot.removeAttribute('hidden');
        return true;
      } catch (error) {
        ideHost.textContent = `IDE unavailable: ${(error as Error).message}`;
        return false;
      }
    };

    // Leaving the IDE must dispose its view: Monaco models and the terminal
    // hold real resources, and a hidden view that keeps them looks like a
    // memory leak with a UI attached.
    let mounted = false;
    const showChat = (): void => {
      ideRoot.setAttribute('hidden', '');
      appRoot.removeAttribute('hidden');
    };

    if (ideToggle) {
      ideToggle.addEventListener('click', () => {
        void (async () => {
          if (mounted) {
            appRoot.setAttribute('hidden', '');
            ideRoot.removeAttribute('hidden');
            return;
          }
          // The last workspace opens directly, exactly as it does on
          // launch. Only when there is none does the native picker appear -
          // asking for a folder the user already chose would be a riddle,
          // and a dialog nothing can dismiss is also what stood between
          // this handler and its first passing end-to-end test.
          const stored = storedWorkspaceRoot();
          if (stored) {
            mounted = await mountIde(stored);
            return;
          }
          const root = bridge.workspaceRoot
            ? await bridge.workspaceRoot()
            : null;
          if (root) mounted = await mountIde(root);
        })();
      });
    }

    const chatToggle = document.getElementById('ide-chat-toggle');
    chatToggle?.addEventListener('click', showChat);

    const folderButton = document.getElementById('ide-folder-button');
    folderButton?.addEventListener('click', () => {
      void (async () => {
        const root = bridge.workspaceRoot ? await bridge.workspaceRoot() : null;
        if (root) {
          // A fresh view for a fresh folder: models from the old workspace
          // must not survive the switch. The pending root rides through the
          // reload in session storage, which dies with the tab.
          sessionStorage.setItem('waypoint.ide.pendingRoot', root);
          window.location.reload();
        }
      })();
    });

    wireIdeDialogButtons();

    const pending = sessionStorage.getItem('waypoint.ide.pendingRoot');
    if (pending) {
      sessionStorage.removeItem('waypoint.ide.pendingRoot');
      mounted = await mountIde(pending);
    } else {
      const stored = storedWorkspaceRoot();
      if (stored) mounted = await mountIde(stored);
    }
  }

  /** Buttons that live in the IDE top bar but open shared dialogs. */
  function wireIdeDialogButtons(): void {
    const builderToggle = document.getElementById('ide-builder-toggle');
    const builderDialog = document.getElementById('builder-dialog');
    builderToggle?.addEventListener('click', () => {
      if (builderDialog instanceof HTMLDialogElement) builderDialog.showModal();
    });

    const healthToggle = document.getElementById('ide-health-toggle');
    healthToggle?.addEventListener('click', () => void showHealth());

    const appearanceIdeToggle = document.getElementById('ide-appearance-toggle');
    appearanceIdeToggle?.addEventListener('click', () => openAppearance('settings'));
  }

  /** Last workspace, so the IDE opens where the user left it. */
  function storedWorkspaceRoot(): string | null {
    try {
      return localStorage.getItem('waypoint.ide.root');
    } catch {
      return null;
    }
  }

  function rememberWorkspaceRoot(root: string): void {
    try {
      localStorage.setItem('waypoint.ide.root', root);
    } catch {
      // Private-mode storage failure must not break the mount.
    }
  }

  /** Folder name in the IDE top bar. The full path stays a tooltip. */
  function showIdeFolder(root: string): void {
    const label = document.getElementById('ide-folder');
    if (!label) return;
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    label.textContent = name;
    label.title = root;
  }

  window.addEventListener('beforeunload', () => controller?.cancelAll());

  render();
}

void main();