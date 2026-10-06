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
  canSubmit,
  initialState,
  nextId,
  reducer,
  transcriptText,
  type Action,
  type AppState,
} from '@gearvane/app-core';
import {
  defaultConfig,
  type GearVaneConfig,
} from '@gearvane/core';
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
  STORAGE_KEY,
  clearKeys,
  loadKeys,
  saveKeys,
  type KeyStorage,
} from './keys.js';

// Type-only, so the builder view is not pulled into the Android bundle at the
// entry point. It is loaded on demand below, and only where the bridge exists.
import type { BuilderBridge } from './builder-view.js';
import type { TerminalBridge } from './ide/terminal.js';
import type { AgentResult, AgentStep } from '@gearvane/harness';
import { createWebBackend, type WebFsStorage } from './web-backend.js';
import { hostedModelRows } from './hosted-models.js';
import MODEL_CATALOG from './models.json';
import {
  createModelPicker,
  type InstallProgress,
  type ModelPicker,
  type ModelPickerEntry,
} from './model-picker.js';
import {
  activeSession,
  activeSpace,
  createSession,
  createSpace,
  loadBoard,
  renameSpace,
  saveBoard,
  sessionsInSpace,
  snapshotSession,
  switchSession,
  type Board,
} from './board.js';
import {
  DEFAULT_EFFORT,
  EFFORTS,
  effortById,
  maxIterationsFor,
  maxTokensFor,
} from './effort.js';
import {
  needsApproval,
  parseAgentMode,
  parseApprovalMode,
  type AgentMode,
  type ApprovalMode,
} from './approval.js';
import {
  addConnector,
  loadConnectors,
  parseMcpServerJson,
  removeConnector,
  toggleConnector,
} from './connectors.js';
import { SKILLS } from './skills.js';

/** Capabilities the host may provide. Every one is optional. */
interface HostBridge {
  appInfo?(): Promise<{ platform?: string; version?: string }>;
  readConfig?(): Promise<{ config: GearVaneConfig; path: string | null; error: string | null }>;
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

  /**
   * Model catalog bridge, present only in the desktop app.
   *
   * Listing and fetching run in the main process, which writes into the
   * directory the embedded server serves. Absent in the webview, where
   * the dialog shows the catalog read-only instead.
   */
  models?: {
    list(): Promise<
      Array<{ id: string; file: string; use: string; bytes: number; present: boolean }>
    >;
    fetch(id: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
    onProgress(handler: (progress: { id: string; done: number; total: number }) => void): () => void;
    /**
     * Stop a transfer in progress.
     *
     * Returns whether anything was running, so a cancel click on a finished
     * download reports that it did nothing rather than pretending it stopped
     * one. Absent on hosts with no transfer to cancel.
     */
    cancel?(id: string): Promise<{ ok: boolean }>;
  };

  /**
   * Key vault bridge, present only in the desktop app.
   *
   * Where it exists the main process owns the file and encrypts it through the
   * OS secret store, so keys are not readable from the profile directory.
   * Absent in the webview, which has no secret store and falls back to
   * localStorage — device-local either way, but not encrypted at rest.
   */
  keys?: {
    read(): Promise<{ keys: Record<string, string>; persistent: boolean }>;
    save(keys: Record<string, string>): Promise<Record<string, string>>;
    clear(): Promise<void>;
  };
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
    gearvane?: HostBridge;
  }
}

const bridge: HostBridge = window.gearvane ?? {};

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
let activeConfig: GearVaneConfig | undefined;
let configFromDefaults = false;

/**
 * Build the chat controller with the vault's keys.
 *
 * Keys authenticate whatever providers the config carries; on a
 * defaults-derived config they also switch the hosted tiers on, because
 * defaultConfig only lists a hosted provider when its key is present.
 * Health probes inherit the same keys through the controller.
 */
function buildController(config: GearVaneConfig): AppController {
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
  
  controller = buildController(activeConfig);
  syncKeysButton();
  render();
  // Hosted rows in the picker follow the keys, so rebuild it too.
  void mountPicker();
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
  modelsButton: byId<HTMLButtonElement>('models-button'),
  modelsDialog: byId<HTMLDialogElement>('models-dialog'),
  modelsBody: byId('models-body'),
  modelInstallDialog: byId<HTMLDialogElement>('model-install-dialog'),
  modelInstallText: byId('model-install-text'),
  modelInstallLicense: byId('model-install-license'),
  modelPickerHost: byId('model-picker-host'),
  keysButton: byId<HTMLButtonElement>('keys-button'),
  keysDialog: byId<HTMLDialogElement>('keys-dialog'),
  keysFields: byId('keys-fields'),
  keysNote: byId('keys-note'),
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
  appearanceBack: byId<HTMLButtonElement>('appearance-back'),
  appearanceNext: byId<HTMLButtonElement>('appearance-next'),
  appearanceSave: byId<HTMLButtonElement>('appearance-save'),
  onboardingSteps: byId('onboarding-steps'),
  onboardingContent: byId('onboarding-content'),
  sidebar: byId('sidebar'),
  navWorkspace: byId<HTMLButtonElement>('nav-workspace'),
  navFiles: byId<HTMLButtonElement>('nav-files'),
  navAutomations: byId<HTMLButtonElement>('nav-automations'),
  navDispatch: byId<HTMLButtonElement>('nav-dispatch'),
  navConfiguration: byId<HTMLButtonElement>('nav-configuration'),
  navHome: byId<HTMLButtonElement>('nav-home'),
  sidebarToggle: byId<HTMLButtonElement>('sidebar-toggle'),
  spaceSelect: byId<HTMLSelectElement>('space-select'),
  spaceRename: byId<HTMLButtonElement>('space-rename'),
  spaceDialog: byId<HTMLDialogElement>('space-dialog'),
  spaceName: byId<HTMLInputElement>('space-name'),
  spaceSave: byId<HTMLButtonElement>('space-save'),
  sessionNew: byId<HTMLButtonElement>('session-new'),
  sessionsList: byId('sessions-list'),
  activityList: byId('activity-list'),
  skillsList: byId('skills-list'),
  connectorsList: byId('connectors-list'),
  connectorAdd: byId<HTMLButtonElement>('connector-add'),
  mcpDialog: byId<HTMLDialogElement>('mcp-dialog'),
  mcpJson: byId<HTMLTextAreaElement>('mcp-json'),
  mcpError: byId('mcp-error'),
  mcpAdd: byId<HTMLButtonElement>('mcp-add'),
  mcpCancel: byId<HTMLButtonElement>('mcp-cancel'),
  agentModeSelect: byId<HTMLSelectElement>('agent-mode-select'),
  approvalModeSelect: byId<HTMLSelectElement>('approval-mode-select'),
  effortSelect: byId<HTMLSelectElement>('effort-select'),
  runReadout: byId('run-readout'),
  executionDialog: byId<HTMLDialogElement>('execution-dialog'),
  executionTitle: byId('execution-title'),
  executionBody: byId('execution-body'),
  approvalDialog: byId<HTMLDialogElement>('approval-dialog'),
  approvalText: byId('approval-text'),
  approvalApprove: byId<HTMLButtonElement>('approval-approve'),
  approvalRevise: byId<HTMLButtonElement>('approval-revise'),
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: #${id}`);
  return element as T;
}

// --- model picker -----------------------------------------------------------

const PIN_STORAGE_KEY = 'gearvane.modelPin';

/** The model pinned for the next runs; empty means Auto. */
let modelPin = ((): string => {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
})();

function saveModelPin(): void {
  try {
    window.localStorage.setItem(PIN_STORAGE_KEY, modelPin);
  } catch {
    // A lost pin only means Auto next launch.
  }
}

/**
 * The downloadable weights, with a green marker beside those already
 * on disk. In the bridgeless webview there is no model directory,
 * so rows are read-only and say so instead of promising a download.
 */
async function catalogEntries(): Promise<ModelPickerEntry[]> {
  const present = new Set<string>();
  if (bridge.models) {
    try {
      const listed = await bridge.models.list();
      for (const entry of listed) {
        if (entry.present) present.add(entry.id);
      }
    } catch {
      // Status is best-effort; the list renders without it.
    }
  }

  // Grouped by `use`, which the catalog already carries: general, code,
  // small. Fifty flat rows are a list to scroll, not to choose from.
  return (MODEL_CATALOG as CatalogEntry[]).map((entry) =>
    bridge.models
      ? {
          id: entry.id,
          label: entry.id,
          group: entry.use,
          detail: `${formatMB(entry.bytes)}`,
          present: present.has(entry.id),
          download: { bytes: entry.bytes },
          license: entry.license,
          licenseUrl: entry.licenseUrl,
        }
      : {
          id: entry.id,
          label: entry.id,
          group: entry.use,
          detail: 'desktop app only',
        },
  );
}

/**
 * Everything the chat picker lists: Auto, every downloadable weight,
 * and the hosted models the active config exposes.
 */
async function pickerEntries(): Promise<ModelPickerEntry[]> {
  const entries: ModelPickerEntry[] = [
    {
      id: '',
      label: 'Auto',
      detail: 'classify the request, pick the tier',
    },
    ...(await catalogEntries()),
  ];

  const config = activeConfig;
  if (config) {
    // Only keyed hosted rows: keyless embedded models are already in
    // the catalog above, and showing them twice would be a duplicate.
    for (const row of hostedModelRows(config, loadKeys(keyStorage))) {
      if (row.keyless) continue;
      entries.push({
        id: row.label,
        label: row.label,
        // Grouped with the rest so the panel has no orphan heading; the
        // config's tier is what distinguishes them from local weights.
        group: `Hosted (${row.tier})`,
        detail: 'uses your provider key',
      });
    }
  }

  return entries;
}

const pickerHandlers = {
  install: async (entry: ModelPickerEntry): Promise<boolean> => {
    if (!bridge.models) return false;
    try {
      // downloadId rather than id: a hosted row's id is qualified as
      // provider/model, which is not what the catalog is keyed by.
      const result = await bridge.models.fetch(entry.downloadId ?? entry.id);
      return result.ok;
    } catch {
      return false;
    }
  },
  /**
   * Per-transfer progress.
   *
   * The bridge broadcasts every model's ticks on one channel, so this filters
   * to the one being installed. Without the filter a second download's bytes
   * would appear on the first model's chip.
   */
  subscribe: (entry: ModelPickerEntry, onProgress: (p: InstallProgress) => void): (() => void) => {
    const target = entry.downloadId ?? entry.id;
    if (!bridge.models?.onProgress) return () => {};
    return bridge.models.onProgress((progress) => {
      if (progress.id === target) onProgress({ done: progress.done, total: progress.total });
    });
  },
  cancel: async (entry: ModelPickerEntry): Promise<boolean> => {
    if (!bridge.models?.cancel) return false;
    const result = await bridge.models.cancel(entry.downloadId ?? entry.id);
    return result.ok === true;
  },
  confirmInstall: (entry: ModelPickerEntry): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const size = entry.download ? formatMB(entry.download.bytes) : '';
      els.modelInstallText.textContent =
        `${entry.label} is not on this device yet. ` +
        `Download ${size} now? It is served locally by GearVane — ` +
        'no key, no cloud, and it stays available offline.';
      // The license is part of the install decision: the user
      // agrees to it by downloading.
      const license = els.modelInstallLicense;
      license.textContent = '';
      license.hidden = !entry.license;
      if (entry.license) {
        const link = document.createElement('a');
        link.href = entry.licenseUrl ?? '#';
        link.textContent = `Licensed under ${entry.license}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        license.append('Weights are ', link, '.');
      }
      els.modelInstallDialog.returnValue = '';
      els.modelInstallDialog.addEventListener(
        'close',
        () => resolve(els.modelInstallDialog.returnValue === 'install'),
        { once: true },
      );
      if (typeof els.modelInstallDialog.showModal === 'function') {
        els.modelInstallDialog.showModal();
      } else {
        resolve(false);
      }
    }),
};

let picker: ModelPicker | undefined;

/**
 * (Re)build the header picker.
 *
 * Rebuilding rather than mutating keeps the component dumb: any
 * download — from here or from the Models dialog — ends with a
 * remount, and the green markers are always current.
 */
async function mountPicker(): Promise<void> {
  picker?.destroy();
  picker = undefined;
  els.modelPickerHost.textContent = '';

  const instance = createModelPicker({
    entries: await pickerEntries(),
    selected: modelPin,
    autoLabel: 'Auto',
    handlers: pickerHandlers,
    onSelect: pinModel,
  });
  els.modelPickerHost.append(instance.root);
  picker = instance;
}

/**
 * Pin the chat to a model, from either picker.
 *
 * The transcript is owned by the app and stored provider-agnostically, so a
 * switch never loses it: the next turn simply routes to the new model with
 * the full history available. The notice says exactly that, with the
 * transcript's estimated size.
 */
function pinModel(id: string): void {
  if (id === modelPin) return;
  modelPin = id;
  saveModelPin();
  syncRunReadout();
  const tokens = Math.max(1, Math.ceil(transcriptText(state).length / 4));
  showNotice(`Switched to ${id || 'Auto'}. Context carried over (≈${tokens} tokens).`);
}

/** Brief, non-blocking notice. Replaces any notice still on screen. */
function showNotice(text: string): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  // Restart the fade timer so consecutive notices each get the full delay.
  const timer = Number(toast.dataset.timer ?? 0);
  if (timer) clearTimeout(timer);
  toast.dataset.timer = String(
    setTimeout(() => {
      toast.hidden = true;
      toast.dataset.timer = '0';
    }, 4000),
  );
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
  role.textContent = message.role === 'user' ? 'You' : 'GearVane';
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
  // A pin previews the pinned model, so the badge says what will run.
  // Previewing must never break typing: with an empty or broken config
  // the router throws, and the composer has to keep working regardless.
  try {
    const preview = controller.preview(draft, [], modelPin || undefined);
    els.tierBadge.textContent = preview.tier;
    els.tierBadge.className = `tier-badge tier-${preview.tier}`;
    els.tierBadge.title = `${preview.provider}/${preview.model} - ${preview.reasons.join('; ')}`;
  } catch {
    els.tierBadge.textContent = 'no model';
    els.tierBadge.className = 'tier-badge tier-none';
    els.tierBadge.title = 'No model tiers configured';
  }
}

function renderSpend(): void {
  els.spendFill.style.width = '100%';
  els.spendFill.className = 'spend-fill';
  els.spendMeter.title = `$${state.sessionSpendUsd.toFixed(4)}`;
}

function renderComposer(): void {
  els.send.disabled = !canSubmit(state);
  els.cancel.hidden = !state.busy;
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

  // Ask-me-first: destructive prompts need an explicit approve. Revise
  // leaves the draft in the composer and focuses it.
  if (approvalMode === 'ask-first' && needsApproval(prompt)) {
    const approved = await showApproval(prompt);
    if (!approved) return;
    if (!state.draft.trim() || state.busy || !controller) return;
  }

  const messageId = nextId('turn');
  activeTaskId = messageId;
  const excerpt = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
  const activityId = addActivity({ kind: 'chat', title: excerpt, detail: 'sending' });
  dispatch({ type: 'submit', messageId });

  // Chat + Builder fans the same prompt out to the headless IDE agent in
  // parallel; both streams land in the Activity Hub.
  if (agentMode === 'pair') void runBuilderHeadless(prompt);

  try {
    const result = await controller.submit({
      taskId: messageId,
      prompt,
      stream: true,
      maxTokens: maxTokensFor(effortId),
      // A pinned model rides along; empty (Auto) omits it so the
      // router classifies the request as it always did.
      ...(modelPin ? { model: modelPin } : {}),
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
      updateActivity(activityId, {
        status: 'done',
        detail: result.tier + (result.model ? `/${result.model}` : ''),
        tier: result.tier,
        model: result.model,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        content: result.content.slice(0, 4000),
      });
    } else {
      dispatch({ type: 'failed', messageId, error: result.error ?? 'Request failed' });
      updateActivity(activityId, { status: 'failed', detail: result.error ?? 'Request failed' });
    }
  } catch (error) {
    dispatch({
      type: 'failed',
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    updateActivity(activityId, {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeTaskId = null;
    updateFromController();
    render();
    persistCurrentSession();
    renderBoard();
  }
}

function cancel(): void {
  if (builderCancel) {
    builderCancel();
    builderCancel = undefined;
    for (const activity of activities) {
      if (activity.kind === 'builder' && activity.status === 'running') {
        updateActivity(activity.id, { status: 'failed', detail: 'Cancelled' });
      }
    }
  }
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

interface CatalogEntry {
  id: string;
  file: string;
  url: string;
  bytes: number;
  use: string;
  bundled: boolean;
  license: string;
  licenseUrl: string;
}

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}

function groupHeader(title: string, note: string): HTMLElement {
  const header = document.createElement('h3');
  header.className = 'models-group-title';
  header.textContent = title;
  header.title = note;
  return header;
}

/**
 * Render the Models dialog: local weights from the static catalog with
 * live ready/download state, then the hosted mid and frontier rosters
 * from the active config with vault key state.
 */
async function showModels(): Promise<void> {
  const entries = MODEL_CATALOG as CatalogEntry[];
  els.modelsBody.textContent = '';

  const localGroup = document.createElement('div');
  localGroup.className = 'models-group';
  localGroup.dataset.tier = 'local';
  localGroup.append(groupHeader('Local — on this device', 'Downloaded weights served by the app itself'));

  let present = new Set<string>();
  if (bridge.models) {
    try {
      const listed = await bridge.models.list();
      present = new Set(listed.filter((entry) => entry.present).map((entry) => entry.id));
    } catch {
      // Status is best-effort; the catalog below renders regardless.
    }
  } else {
    const note = document.createElement('p');
    note.className = 'builder-help';
    note.textContent = 'Downloads need the desktop app; this list is what it offers.';
    localGroup.append(note);
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'health-row';

    const name = document.createElement('span');
    // The license travels with the row: a user choosing what to
    // download is choosing under which terms.
    const licenseLink = document.createElement('a');
    licenseLink.href = entry.licenseUrl;
    licenseLink.textContent = entry.license;
    licenseLink.target = '_blank';
    licenseLink.rel = 'noopener noreferrer';
    licenseLink.className = 'models-license';
    name.append(
      `${entry.id} — ${entry.use} (${formatMB(entry.bytes)}) · `,
      licenseLink,
    );

    const action = document.createElement('span');
    if (present.has(entry.id)) {
      action.textContent = 'ready';
      action.className = 'health-status-healthy';
    } else if (bridge.models) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost-button';
      button.textContent = 'Download';
      button.addEventListener('click', () => void downloadModel(entry, button, action));
      action.append(button);
    } else {
      action.textContent = entry.bundled ? 'in the installer' : 'desktop only';
      action.className = 'health-status-unknown';
    }

    row.append(name, action);
    localGroup.append(row);
  }
  els.modelsBody.append(localGroup);

  // Hosted tiers come from the active config: what the user can actually
  // route to, with vault key state beside each. Empty tiers (no keys in a
  // defaults-derived config) render nothing.
  const config = activeConfig;
  if (config) {
    type TierRows = ReturnType<typeof hostedModelRows>;
    const byTier = new Map<'mid' | 'frontier', TierRows>();
    for (const row of hostedModelRows(config, loadKeys(keyStorage))) {
      const list = byTier.get(row.tier) ?? [];
      list.push(row);
      byTier.set(row.tier, list);
    }
    const titles = {
      mid: 'Mid — hosted, needs keys',
      frontier: 'Frontier — hosted, needs keys',
    } as const;
    for (const [tier, title] of Object.entries(titles)) {
      const rows = byTier.get(tier as 'mid' | 'frontier') ?? [];
      if (rows.length === 0) continue;
      const group = document.createElement('div');
      group.className = 'models-group';
      group.dataset.tier = tier;
      group.append(groupHeader(title, 'Keys live in the Keys dialog or the shell environment'));
      for (const rowData of rows) {
        const row = document.createElement('div');
        row.className = 'health-row';
        const name = document.createElement('span');
        name.textContent = rowData.label;
        const state = document.createElement('span');
        state.textContent = rowData.keyless ? 'no key needed' : rowData.keyed ? 'key saved' : 'needs key';
        state.className =
          rowData.keyless || rowData.keyed ? 'health-status-healthy' : 'health-status-unknown';
        row.append(name, state);
        group.append(row);
      }
      els.modelsBody.append(group);
    }
  }

  if (typeof els.modelsDialog.showModal === 'function') els.modelsDialog.showModal();
}

async function downloadModel(
  entry: CatalogEntry,
  button: HTMLButtonElement,
  status: HTMLElement,
): Promise<void> {
  if (!bridge.models) return;
  button.disabled = true;
  button.textContent = 'Fetching…';
  const downloadId = addActivity({ kind: 'download', title: entry.id, detail: '0%' });
  const stop = bridge.models.onProgress((progress) => {
    if (progress.id !== entry.id) return;
    const pct =
      progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    button.textContent = `${pct}%`;
    updateActivity(downloadId, { detail: `${pct}%` });
  });
  try {
    const result = await bridge.models.fetch(entry.id);
    if (result.ok) {
      status.textContent = '';
      const ready = document.createElement('span');
      ready.textContent = 'ready';
      ready.className = 'health-status-healthy';
      status.append(ready);
      updateActivity(downloadId, { status: 'done', detail: 'ready' });
    } else {
      button.disabled = false;
      button.textContent = 'Retry';
      status.title = result.error ?? 'download failed';
      updateActivity(downloadId, { status: 'failed', detail: result.error ?? 'download failed' });
    }
  } catch {
    button.disabled = false;
    button.textContent = 'Retry';
  } finally {
    stop();
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
 * Routing posture chosen during onboarding.
 *
 * "local-first" is the default: local models for everyday work, hosted
 * models when a task needs them. "local-only" keeps every run on the
 * local tier — no hosted calls, no keys, fully offline.
 */
type Posture = 'local-first' | 'local-only';

const POSTURE_STORAGE_KEY = 'gearvane.posture';

function loadPosture(): Posture {
  try {
    return window.localStorage.getItem(POSTURE_STORAGE_KEY) === 'local-only'
      ? 'local-only'
      : 'local-first';
  } catch {
    return 'local-first';
  }
}

let pendingPosture: Posture = loadPosture();

function savePosture(): void {
  try {
    window.localStorage.setItem(POSTURE_STORAGE_KEY, pendingPosture);
  } catch {
    // Losing the posture only means the default next launch.
  }
}

/** The onboarding steps: welcome, theme, environment. */
const ONBOARDING_STEPS = ['welcome', 'theme', 'environment'] as const;
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
let onboardingStep: OnboardingStep = 'welcome';
/** Settings mode edits the theme step directly, without the wizard chrome. */
let appearanceMode: 'onboarding' | 'settings' = 'settings';

/**
 * Render the four appearance groups into a container.
 *
 * Everything is createElement and textContent: no template string is ever
 * parsed as HTML, so a preset name cannot inject markup. The group ids
 * match the static markup the smoke tests have always selected.
 */
function renderAppearanceGroups(container: HTMLElement): void {
  const makeOption = (
    group: HTMLElement,
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
    group.appendChild(button);
  };

  const group = (
    id: string,
    label: string,
    className: string,
  ): HTMLElement => {
    const section = document.createElement('section');
    section.className = 'appearance-group';
    const heading = document.createElement('h3');
    heading.textContent = label;
    const options = document.createElement('div');
    options.className = className;
    options.id = id;
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', label);
    section.append(heading, options);
    container.appendChild(section);
    return options;
  };

  const themes = group('appearance-themes', 'Theme', 'appearance-options');
  for (const theme of THEMES) {
    makeOption(themes, 'theme', theme.id, theme.name, theme.vibe);
  }

  const backgrounds = group('appearance-backgrounds', 'Background', 'appearance-options');
  for (const background of BACKGROUNDS) {
    makeOption(backgrounds, 'background', background.id, background.name, background.vibe);
  }

  const accents = group('appearance-accents', 'Accent', 'appearance-swatches');
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

  const motions = group('appearance-motion', 'Motion', 'appearance-options appearance-options-small');
  for (const motion of MOTIONS) {
    makeOption(motions, 'motion', motion.id, motion.name, motion.vibe);
  }
}

/** The welcome step: what GearVane is, and what the wizard sets up. */
function renderWelcomeStep(content: HTMLElement): void {
  const intro = document.createElement('p');
  intro.className = 'builder-help';
  intro.textContent =
    'GearVane runs models on this device and in your cloud accounts. ' +
    'A few quick choices make it yours: a look, and how models run. ' +
    'Everything can be changed later from the top bar.';
  content.appendChild(intro);
}

/** The theme step: the four appearance groups, previewing live. */
function renderThemeStep(content: HTMLElement): void {
  renderAppearanceGroups(content);
}

/** The environment step: routing posture and the default model. */
function renderEnvironmentStep(content: HTMLElement): void {
  const postureLabel = document.createElement('h3');
  postureLabel.className = 'onboarding-subhead';
  postureLabel.textContent = 'How models run';
  content.appendChild(postureLabel);

  const postureGroup = document.createElement('div');
  postureGroup.className = 'onboarding-posture';
  for (const option of [
    {
      id: 'local-first',
      name: 'Local first',
      vibe: 'Free local models for everyday work; hosted models join in when a task needs them.',
    },
    {
      id: 'local-only',
      name: 'Local only',
      vibe: 'Stay on local models. No hosted calls, no keys, fully offline.',
    },
  ] as const) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'onboarding-posture-card';
    card.dataset.posture = option.id;

    const name = document.createElement('span');
    name.className = 'onboarding-posture-name';
    name.textContent = option.name;
    const vibe = document.createElement('span');
    vibe.className = 'onboarding-posture-vibe';
    vibe.textContent = option.vibe;
    card.append(name, vibe);

    card.addEventListener('click', () => {
      pendingPosture = option.id;
      syncPostureCards();
    });
    postureGroup.appendChild(card);
  }
  content.appendChild(postureGroup);
  syncPostureCards();

  const modelLabel = document.createElement('h3');
  modelLabel.className = 'onboarding-subhead';
  modelLabel.textContent = 'What drives your requests';
  content.appendChild(modelLabel);

  const modelHelp = document.createElement('p');
  modelHelp.className = 'builder-help';
  modelHelp.textContent =
    'Auto classifies each request and picks a tier. A specific model ' +
    'always runs that model. You can change this any time from the ' +
    'model menu in the top bar.';
  content.appendChild(modelHelp);

  const host = document.createElement('span');
  host.className = 'onboarding-model-host';
  content.appendChild(host);
  void mountOnboardingPicker(host);
}

/**
 * The onboarding model picker: Auto plus every downloadable weight.
 *
 * Deliberately without hosted rows — onboarding runs before the
 * config resolves, and the default model is a local weight or Auto.
 * Choosing here writes the same pin the header picker uses.
 */
async function mountOnboardingPicker(host: HTMLElement): Promise<void> {
  const entries: ModelPickerEntry[] = [
    { id: '', label: 'Auto', detail: 'classify the request, pick the tier' },
    ...(await catalogEntries()),
  ];
  const instance = createModelPicker({
    entries,
    selected: modelPin,
    autoLabel: 'Auto',
    handlers: pickerHandlers,
    onSelect: pinModel,
  });
  host.textContent = '';
  host.append(instance.root);
}

/** Move the selected state onto the posture cards. */
function syncPostureCards(): void {
  const cards = Array.from(
    els.onboardingContent.querySelectorAll<HTMLButtonElement>('[data-posture]'),
  );
  for (const card of cards) {
    const selected = card.dataset.posture === pendingPosture;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  }
}

/** Render the current step and update the wizard chrome. */
function renderStep(): void {
  const wizard = appearanceMode === 'onboarding';
  const isFirst = onboardingStep === 'welcome';
  const isLast = onboardingStep === 'environment';

  els.onboardingSteps.hidden = !wizard;
  els.appearanceBack.hidden = !wizard || isFirst;
  els.appearanceNext.hidden = !wizard || isLast;
  els.appearanceSave.hidden = wizard ? !isLast : onboardingStep !== 'theme';

  if (wizard) {
    const dots = Array.from(els.onboardingSteps.querySelectorAll('.onboarding-step-dot'));
    const index = ONBOARDING_STEPS.indexOf(onboardingStep);
    dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
  }

  const content = els.onboardingContent;
  content.textContent = '';
  if (onboardingStep === 'welcome') renderWelcomeStep(content);
  else if (onboardingStep === 'theme') renderThemeStep(content);
  else renderEnvironmentStep(content);

  syncAppearanceButtons();
}

/**
 * Build the dialog once and keep it fed from the stored look.
 *
 * Save persists; Cancel and the Escape key both land here with any other
 * returnValue, which reverts the live preview to the opening snapshot.
 */
function wireAppearance(): void {
  els.appearanceDialog.addEventListener('close', () => {
    const saved = els.appearanceDialog.returnValue === 'save';
    if (saved) {
      saveAppearance(appearanceStorage, pendingAppearance);
      applyAppearance(document.documentElement, pendingAppearance);
      savePosture();
    } else {
      applyAppearance(document.documentElement, appearanceSnapshot);
      pendingAppearance = { ...appearanceSnapshot };
    }
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
  });

  els.appearanceBack.addEventListener('click', () => {
    const index = ONBOARDING_STEPS.indexOf(onboardingStep);
    const prev = ONBOARDING_STEPS[index - 1];
    if (prev) {
      onboardingStep = prev;
      renderStep();
    }
  });

  els.appearanceNext.addEventListener('click', () => {
    const index = ONBOARDING_STEPS.indexOf(onboardingStep);
    const next = ONBOARDING_STEPS[index + 1];
    if (next) {
      onboardingStep = next;
      renderStep();
    }
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
  appearanceMode = mode;
  pendingAppearance = loadAppearance(appearanceStorage);
  appearanceSnapshot = { ...pendingAppearance };
  pendingPosture = loadPosture();

  if (mode === 'onboarding') {
    onboardingStep = 'welcome';
    els.appearanceTitle.textContent = 'Make GearVane yours';
    els.appearanceLede.textContent =
      'A few quick choices to make GearVane yours. Everything can be ' +
      'changed later from the top bar.';
    els.appearanceCancel.textContent = 'Skip for now';
  } else {
    onboardingStep = 'theme';
    els.appearanceTitle.textContent = 'Appearance';
    els.appearanceLede.textContent =
      'Themes, background, accent, and motion. Changes apply instantly ' +
      'and are only kept when you save.';
    els.appearanceCancel.textContent = 'Cancel';
  }

  renderStep();
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
  // Say so when the keys cannot be encrypted at rest, rather than implying
  // a protection the platform did not provide.
  els.keysNote.textContent = vaultPersistent
    ? 'Keys stay on this device and are encrypted by your operating system.'
    : 'Keys stay on this device for this session only. This system has no ' +
      'secret store, so they are not written to disk and will be gone when ' +
      'the app closes.';
  els.keysNote.hidden = false;
}

/** False when the platform has no secret store: keys cannot be persisted. */
let vaultPersistent = true;

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
    syncKeysButton();
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
    void persistKeys(next).then(() => applyKeys());
    // The surrounding form uses method=dialog, so this submit closes it.
  });

  els.keysClear.addEventListener('click', () => {
    for (const input of inputs.values()) input.value = '';
    if (bridge.keys) void bridge.keys.clear().catch(() => {});
    vaultMirror.delete(STORAGE_KEY);
    clearKeys(keyStorage);
    applyKeys();
    syncKeysButton();
  });
}

// --- dashboard space ----------------------------------------------------------
// Eigent-style shell: spaces holding sessions, an activity hub, skills,
// connectors, and a composer command bar. Additive over the chat view:
// every pre-existing element id stays, so existing e2e keeps passing.

const deviceStore = {
  getItem: (key: string): string | null => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Device-local and non-essential; skip it.
    }
  },
};

let board: Board = loadBoard(deviceStore);

const EFFORT_STORAGE_KEY = 'gearvane.effort';
const APPROVAL_STORAGE_KEY = 'gearvane.approvalMode';
const AGENT_MODE_STORAGE_KEY = 'gearvane.agentMode';

let effortId = deviceStore.getItem(EFFORT_STORAGE_KEY) ?? DEFAULT_EFFORT;
if (!EFFORTS.some((effort) => effort.id === effortId)) effortId = DEFAULT_EFFORT;
let approvalMode: ApprovalMode = parseApprovalMode(deviceStore.getItem(APPROVAL_STORAGE_KEY));
let agentMode: AgentMode = parseAgentMode(deviceStore.getItem(AGENT_MODE_STORAGE_KEY));

interface BuilderStepView {
  iteration: number;
  text: string;
  calls: Array<{ name: string; ok: boolean }>;
}

interface Activity {
  id: string;
  kind: 'chat' | 'builder' | 'download';
  title: string;
  detail: string;
  status: 'running' | 'done' | 'failed';
  tier?: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  content?: string;
  steps?: BuilderStepView[];
  startedAt: number;
}

let activities: Activity[] = [];
let activityCounter = 0;

function addActivity(init: Omit<Activity, 'id' | 'status' | 'startedAt'>): string {
  activityCounter += 1;
  const activity: Activity = {
    ...init,
    id: `activity-${Date.now().toString(36)}-${activityCounter.toString(36)}`,
    status: 'running',
    startedAt: Date.now(),
  };
  activities = [activity, ...activities].slice(0, 20);
  renderActivity();
  return activity.id;
}

function updateActivity(id: string, patch: Partial<Activity>): void {
  activities = activities.map((activity) =>
    activity.id === id ? { ...activity, ...patch } : activity,
  );
  renderActivity();
}

/** Readout under the composer: what the next run uses. */
function syncRunReadout(): void {
  const effort = effortById(effortId);
  const model = modelPin || 'Auto';
  els.runReadout.textContent = `${model} · ${effort.label}`;
  els.runReadout.title =
    `Model: ${model}; thinking effort ${effort.label} ` +
    `(${effort.maxTokens} max tokens, ${effort.maxIterations} agent iterations)`;
}

function renderBoard(): void {
  renderSpaces();
  renderSessions();
  renderActivity();
  renderConnectors();
  syncRunReadout();
}

function renderSpaces(): void {
  els.spaceSelect.textContent = '';
  for (const space of board.spaces) {
    const option = document.createElement('option');
    option.value = space.id;
    option.textContent = space.name;
    els.spaceSelect.append(option);
  }
  const fresh = document.createElement('option');
  fresh.value = '__new__';
  fresh.textContent = '+ New space';
  els.spaceSelect.append(fresh);
  els.spaceSelect.value = board.activeSpaceId;
}

function renderSessions(): void {
  els.sessionsList.textContent = '';
  const sessions = sessionsInSpace(board, board.activeSpaceId);
  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No sessions yet.';
    els.sessionsList.append(empty);
    return;
  }
  for (const session of sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidebar-row' + (session.id === board.activeSessionId ? ' active' : '');
    button.title = session.title;
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = session.title;
    button.append(label);
    button.addEventListener('click', () => switchChatSession(session.id));
    els.sessionsList.append(button);
  }
}

function renderActivity(): void {
  els.activityList.textContent = '';
  if (activities.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No runs yet.';
    els.activityList.append(empty);
    return;
  }
  for (const activity of activities.slice(0, 8)) {
    const dot = document.createElement('span');
    dot.className = `activity-dot ${activity.status}`;
    dot.title = activity.status;

    const detail = activity.detail ? ` - ${activity.detail}` : '';
    const row = activity.steps || activity.content
      ? document.createElement('button')
      : document.createElement('div');
    row.className = 'sidebar-row';
    if (row instanceof HTMLButtonElement) {
      row.type = 'button';
      row.title = `${activity.title}${detail} (open run detail)`;
      row.addEventListener('click', () => openExecution(activity.id));
    } else {
      row.title = `${activity.title}${detail}`;
    }
    const text = document.createElement('span');
    text.className = 'row-label';
    text.textContent = `${activity.title}${detail}`;
    row.append(dot, text);
    els.activityList.append(row);
  }
}

function renderSkillsOnce(): void {
  els.skillsList.textContent = '';
  for (const skill of SKILLS) {
    const row = document.createElement('div');
    row.className = 'sidebar-row';
    row.title = skill.blurb;
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = skill.name;
    row.append(label);
    els.skillsList.append(row);
  }
}

function renderConnectors(): void {
  els.connectorsList.textContent = '';
  const servers = loadConnectors(deviceStore);
  if (servers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No servers yet.';
    els.connectorsList.append(empty);
    return;
  }
  for (const server of servers) {
    const row = document.createElement('div');
    row.className = 'sidebar-row';
    row.title = server.url ?? server.command ?? server.name;

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = `${server.name}${server.tools.length > 0 ? ` (${server.tools.length})` : ''}`;
    if (!server.enabled) label.textContent += ' (off)';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'connector-toggle';
    toggle.checked = server.enabled;
    toggle.setAttribute('aria-label', `Enable ${server.name}`);
    toggle.addEventListener('change', () => {
      toggleConnector(deviceStore, server.id);
      renderConnectors();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost-button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${server.name}`);
    remove.addEventListener('click', () => {
      removeConnector(deviceStore, server.id);
      renderConnectors();
    });

    row.append(label, toggle, remove);
    els.connectorsList.append(row);
  }
}

/** Snapshot the live transcript into its session and persist the board. */
function persistCurrentSession(): void {
  board = snapshotSession(board, board.activeSessionId, state.messages, state.draft);
  saveBoard(deviceStore, board);
}

function restoreSession(session: { messages: AppState['messages']; draft: string }): void {
  state = { ...state, messages: [...session.messages], draft: session.draft, busy: false, error: null };
  els.input.value = session.draft;
  autoGrow();
  if (session.messages.length === 0 && !els.welcome.isConnected) {
    els.transcript.querySelectorAll('.message').forEach((node) => node.remove());
    els.transcript.prepend(els.welcome);
  }
  render();
  renderBoard();
}

function switchChatSession(sessionId: string): void {
  persistCurrentSession();
  board = switchSession(board, sessionId);
  const session = board.sessions.find((entry) => entry.id === sessionId);
  if (session) restoreSession(session);
  saveBoard(deviceStore, board);
  els.input.focus();
}

function newChatSession(): void {
  persistCurrentSession();
  board = createSession(board, board.activeSpaceId);
  restoreSession({ messages: [], draft: '' });
  saveBoard(deviceStore, board);
  els.input.focus();
}

function showChatHome(): void {
  document.getElementById('ide-root')?.setAttribute('hidden', '');
  document.querySelector('.app')?.removeAttribute('hidden');
  for (const button of [els.navWorkspace, els.navFiles, els.navAutomations, els.navDispatch, els.navConfiguration]) {
    button.classList.toggle('active', button === els.navWorkspace);
  }
  els.input.focus();
}

function markNav(button: HTMLButtonElement): void {
  for (const entry of [els.navWorkspace, els.navFiles, els.navAutomations, els.navDispatch, els.navConfiguration]) {
    entry.classList.toggle('active', entry === button);
  }
}

let spaceDialogMode: 'rename' | 'create' = 'rename';

function openSpaceDialog(mode: 'rename' | 'create'): void {
  spaceDialogMode = mode;
  els.spaceName.value = mode === 'rename' ? (activeSpace(board)?.name ?? '') : '';
  if (typeof els.spaceDialog.showModal === 'function') els.spaceDialog.showModal();
  window.setTimeout(() => els.spaceName.focus(), 0);
}

/**
 * Approve-or-revise gate for destructive prompts.
 *
 * Resolves true on Approve, false on Revise, Escape, or dismiss. Revise
 * leaves the draft in the composer and focuses it, so editing is one
 * keystroke away.
 */
function showApproval(prompt: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const excerpt = prompt.length > 220 ? `${prompt.slice(0, 220)}...` : prompt;
    els.approvalText.textContent =
      `This request looks destructive: "${excerpt}". ` +
      'Approve to run it, or revise it first.';
    els.approvalDialog.returnValue = '';
    els.approvalDialog.addEventListener(
      'close',
      () => {
        const approved = els.approvalDialog.returnValue === 'approve';
        if (!approved) els.input.focus();
        resolve(approved);
      },
      { once: true },
    );
    if (typeof els.approvalDialog.showModal === 'function') {
      els.approvalDialog.showModal();
    } else {
      resolve(false);
    }
  });
}

/** Headless IDE agent for Chat + Builder mode: runs without mounting the IDE. */
interface HeadlessAgent {
  run(
    prompt: string,
    root: string,
    options?: { maxIterations?: number; mode?: 'ask' | 'build'; model?: string },
  ): Promise<{
    ok: boolean;
    result?: import('@gearvane/harness').AgentResult;
    error?: string;
    provider?: string;
    model?: string;
  }>;
  cancel(): void;
  onStep(handler: (step: import('@gearvane/harness').AgentStep) => void): () => void;
}

let headlessAgent: HeadlessAgent | undefined;
let resolveHeadlessRoot: (() => Promise<string | null>) | undefined;
let builderCancel: (() => void) | undefined;

async function runBuilderHeadless(prompt: string): Promise<void> {
  const agent = headlessAgent;
  if (!agent) {
    els.hint.textContent = 'Chat + Builder needs a workspace: open the IDE once, then retry.';
    els.hint.classList.add('warn');
    return;
  }
  const root = (await resolveHeadlessRoot?.()) ?? null;
  if (!root) {
    els.hint.textContent = 'Chat + Builder needs a workspace: open the IDE once, then retry.';
    els.hint.classList.add('warn');
    return;
  }
  if (approvalMode === 'ask-first' && needsApproval(prompt)) {
    const approved = await showApproval(prompt);
    if (!approved) return;
  }
  const excerpt = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
  const id = addActivity({ kind: 'builder', title: excerpt, detail: 'starting' });
  builderCancel = () => agent.cancel();
  const steps: BuilderStepView[] = [];
  const stop = agent.onStep((step) => {
    steps.push({
      iteration: step.iteration,
      text: step.content.slice(0, 2000),
      calls: step.toolCalls.map((call) => ({
        name: call.name,
        ok: step.results.find((entry) => entry.name === call.name)?.ok ?? false,
      })),
    });
    updateActivity(id, { detail: `iteration ${step.iteration}`, steps: [...steps] });
  });
  try {
    const response = await agent.run(prompt, root, {
      maxIterations: maxIterationsFor(effortId),
      mode: 'build',
      ...(modelPin ? { model: modelPin } : {}),
    });
    if (response.ok && response.result) {
      const driver = response.provider && response.model
        ? `${response.provider}/${response.model}, `
        : '';
      updateActivity(id, {
        status: 'done',
        detail: `${driver}${response.result.iterations} iterations, ${response.result.stopReason}`,
        model: response.model,
        content: response.result.content.slice(0, 4000),
        steps: [...steps],
      });
    } else {
      updateActivity(id, { status: 'failed', detail: response.error ?? 'unknown problem' });
    }
  } catch (error) {
    updateActivity(id, {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    stop();
    builderCancel = undefined;
  }
}

/** Split-view run detail: run info beside its steps. */
function openExecution(activityId: string): void {
  const activity = activities.find((entry) => entry.id === activityId);
  if (!activity) return;
  els.executionTitle.textContent = `${activity.kind === 'chat' ? 'Chat' : activity.kind === 'builder' ? 'Builder' : 'Download'} run`;
  els.executionBody.textContent = '';

  const split = document.createElement('div');
  split.className = 'execution-split';

  const meta = document.createElement('div');
  meta.className = 'execution-meta';
  const rows: Array<[string, string]> = [
    ['Status', activity.status],
    ['Detail', activity.detail || '-'],
  ];
  if (activity.tier) rows.push(['Tier', activity.tier]);
  if (activity.model) rows.push(['Model', activity.model]);
  if (activity.costUsd !== undefined) rows.push(['Cost', `$${activity.costUsd.toFixed(4)}`]);
  if (activity.durationMs !== undefined) rows.push(['Duration', `${activity.durationMs}ms`]);
  for (const [label, value] of rows) {
    const line = document.createElement('div');
    line.textContent = `${label}: ${value}`;
    meta.append(line);
  }
  split.append(meta);

  const steps = document.createElement('div');
  steps.className = 'execution-steps';
  if (activity.steps) {
    for (const step of activity.steps) {
      const box = document.createElement('details');
      box.className = 'execution-step';
      const summary = document.createElement('summary');
      const calls = step.calls.map((call) => `${call.name} (${call.ok ? 'ok' : 'failed'})`).join(', ');
      summary.textContent = `Iteration ${step.iteration}${calls ? ` - ${calls}` : ''}`;
      const body = document.createElement('pre');
      body.textContent = step.text || '(no output)';
      box.append(summary, body);
      steps.append(box);
    }
  }
  if (activity.content) {
    const box = document.createElement('details');
    box.className = 'execution-step';
    box.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Answer';
    const body = document.createElement('pre');
    body.textContent = activity.content;
    box.append(summary, body);
    steps.append(box);
  }
  if (steps.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No steps recorded for this run yet.';
    steps.append(empty);
  }
  split.append(steps);
  els.executionBody.append(split);

  if (typeof els.executionDialog.showModal === 'function') els.executionDialog.showModal();
}

function wireSpace(): void {
  // Narrow screens start with the sidebar out of the way.
  try {
    if (window.matchMedia('(max-width: 48rem)').matches) {
      document.querySelector('.shell')?.classList.add('sidebar-collapsed');
    }
  } catch {
    // matchMedia is universal here; a failure only keeps the sidebar open.
  }

  els.sidebarToggle.addEventListener('click', () => {
    document.querySelector('.shell')?.classList.toggle('sidebar-collapsed');
  });

  els.effortSelect.value = effortId;
  els.approvalModeSelect.value = approvalMode;
  els.agentModeSelect.value = agentMode;
  els.effortSelect.addEventListener('change', () => {
    effortId = els.effortSelect.value;
    deviceStore.setItem(EFFORT_STORAGE_KEY, effortId);
    syncRunReadout();
  });
  els.approvalModeSelect.addEventListener('change', () => {
    approvalMode = parseApprovalMode(els.approvalModeSelect.value);
    deviceStore.setItem(APPROVAL_STORAGE_KEY, approvalMode);
  });
  els.agentModeSelect.addEventListener('change', () => {
    agentMode = parseAgentMode(els.agentModeSelect.value);
    deviceStore.setItem(AGENT_MODE_STORAGE_KEY, agentMode);
    syncRunReadout();
  });

  els.navHome.addEventListener('click', showChatHome);
  els.navWorkspace.addEventListener('click', showChatHome);
  els.navFiles.addEventListener('click', () => {
    markNav(els.navFiles);
    document.getElementById('ide-toggle')?.click();
  });
  els.navAutomations.addEventListener('click', () => {
    markNav(els.navAutomations);
    const dialog = document.getElementById('builder-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  });
  els.navDispatch.addEventListener('click', () => {
    markNav(els.navDispatch);
    els.input.focus();
  });
  els.navConfiguration.addEventListener('click', () => {
    markNav(els.navConfiguration);
    els.keysButton.click();
  });

  els.sessionNew.addEventListener('click', newChatSession);

  els.spaceSelect.addEventListener('change', () => {
    if (els.spaceSelect.value === '__new__') {
      openSpaceDialog('create');
      els.spaceSelect.value = board.activeSpaceId;
      return;
    }
    persistCurrentSession();
    const target = els.spaceSelect.value;
    const newest = sessionsInSpace(board, target)[0];
    if (newest) {
      board = { ...board, activeSpaceId: target, activeSessionId: newest.id };
      restoreSession(newest);
      saveBoard(deviceStore, board);
    }
  });
  els.spaceRename.addEventListener('click', () => openSpaceDialog('rename'));
  els.spaceDialog.addEventListener('close', () => {
    if (els.spaceDialog.returnValue !== 'save') return;
    const name = els.spaceName.value.trim();
    if (!name) return;
    if (spaceDialogMode === 'create') {
      persistCurrentSession();
      board = createSpace(board, name);
      const session = activeSession(board);
      if (session) restoreSession({ messages: [], draft: '' });
    } else {
      board = renameSpace(board, board.activeSpaceId, name);
    }
    saveBoard(deviceStore, board);
    renderBoard();
  });

  els.connectorAdd.addEventListener('click', () => {
    els.mcpJson.value = '';
    els.mcpError.hidden = true;
    els.mcpError.textContent = '';
    if (typeof els.mcpDialog.showModal === 'function') els.mcpDialog.showModal();
  });
  els.mcpCancel.addEventListener('click', () => els.mcpDialog.close());
  els.mcpAdd.addEventListener('click', () => {
    const parsed = parseMcpServerJson(els.mcpJson.value);
    if (!parsed.ok) {
      els.mcpError.textContent = parsed.error;
      els.mcpError.hidden = false;
      return;
    }
    addConnector(deviceStore, parsed.draft);
    els.mcpDialog.close();
    renderConnectors();
  });

  els.approvalApprove.addEventListener('click', () => els.approvalDialog.close('approve'));
  els.approvalRevise.addEventListener('click', () => els.approvalDialog.close('revise'));

  renderSkillsOnce();
  renderBoard();
}

// --- wiring -----------------------------------------------------------------

async function resolveConfig(): Promise<{
  config: GearVaneConfig;
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
    const response = await fetch('./gearvane.config.json');
    if (response.ok) {
      const { parseConfig } = await import('@gearvane/core');
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
 * Device-local workspace storage for the web backend, beside the
 * appearance settings and the key vault.
 *
 * A never-throwing wrapper: losing the workspace must not kill the app,
 * and the backend treats a missing snapshot as a fresh workspace.
 */
const webFsStorage: WebFsStorage = {
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
};

/**
 * The key vault.
 *
 * In the desktop app the main process owns the file and encrypts it through
 * the OS secret store (see keys-host.ts); the renderer only ever sees the
 * decrypted values it needs, through the bridge. `loadKeys` is then a cached
 * read of that mirror, so every existing caller keeps working unchanged.
 *
 * Without the bridge — the Android webview, which has no secret store — this
 * is the localStorage vault: device-local and still never written to a config
 * file or a log, but plaintext on disk, which is why the dialog says so.
 */
const vaultMirror = new Map<string, string>();

const keyStorage: KeyStorage = {
  getItem: (key) => {
    if (bridge.keys) return vaultMirror.has(key) ? (vaultMirror.get(key) as string) : null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    vaultMirror.set(key, value);
    if (bridge.keys) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Device-local and non-essential; skip it.
    }
  },
  removeItem: (key) => {
    vaultMirror.delete(key);
    if (bridge.keys) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Already gone or disabled; either way the goal is met.
    }
  },
};

/**
 * Pull the vault through the bridge and mirror it locally.
 *
 * Sanitization happens in the main process too, so a compromised file cannot
 * reintroduce a variable the allowlist dropped. Never throws: a vault that
 * will not load means no hosted tier, not a failed boot.
 */
async function syncVault(): Promise<void> {
  if (!bridge.keys) return;
  try {
    const state = await bridge.keys.read();
    vaultPersistent = state.persistent;
    vaultMirror.set(STORAGE_KEY, JSON.stringify(state.keys));
  } catch {
    vaultMirror.delete(STORAGE_KEY);
  }
  syncKeysButton();
}

/** Push the dialog's fields through the bridge, falling back to localStorage. */
async function persistKeys(next: Record<string, string>): Promise<void> {
  if (bridge.keys) {
    try {
      const saved = await bridge.keys.save(next);
      vaultMirror.set(STORAGE_KEY, JSON.stringify(saved));
      return;
    } catch {
      // Fall through so the session still has the keys.
    }
  }
  saveKeys(keyStorage, next);
}

/**
 * Apply the onboarding posture to a resolved config.
 *
 * "local-only" disables escalation, so every run stays on the local
 * tier and retries local models instead of reaching for hosted ones.
 * The config file is never rewritten — the posture is a device-local
 * preference, like the look.
 */
function applyPosture(config: GearVaneConfig): GearVaneConfig {
  if (loadPosture() !== 'local-only') return config;
  return {
    ...config,
    router: {
      ...config.router,
      escalation: { ...config.router.escalation, enabled: false },
    },
  };
}

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

  // The vault must be in the mirror before the config resolves: the hosted
  // tiers are keyed by what it holds, so reading it first is what makes a
  // key-enabled tier appear on boot.
  await syncVault();

  const { config, error, fromDefaults } = await resolveConfig();
  activeConfig = applyPosture(config);
  configFromDefaults = fromDefaults ?? false;
  state = { ...state };
  controller = buildController(config);
  wireKeys();
  syncKeysButton();

  // Dashboard shell: sidebar, spaces, sessions, activity, skills,
  // connectors, and the composer command bar.
  wireSpace();
  {
    const session = activeSession(board);
    if (session && (session.messages.length > 0 || session.draft)) {
      restoreSession(session);
    } else {
      renderBoard();
    }
  }

  if (error) {
    els.hint.textContent = `Config problem: ${error}`;
    els.hint.classList.add('warn');
  }

  els.send.addEventListener('click', () => void send());
  els.cancel.addEventListener('click', cancel);
  els.health.addEventListener('click', () => void showHealth());
  els.modelsButton.addEventListener('click', () => void showModels());

  // The header picker reflects what is on disk, so rebuild it once
  // the config is known, and again whenever the Models dialog
  // closes — downloads there must show up here without a reload.
  void mountPicker();
  els.modelsDialog.addEventListener('close', () => void mountPicker());

  const builderToggle = document.getElementById('builder-toggle');
  const builderDialog = document.getElementById('builder-dialog');
  if (builderToggle && builderDialog) {
    builderToggle.addEventListener('click', () => {
      if (builderDialog instanceof HTMLDialogElement) builderDialog.showModal();
    });
  }

  // The chat view's IDE button. It stays visible wherever the IDE can
  // mount — over host bridges on desktop, over the device-local web
  // backend elsewhere — and is hidden by the mount block below only
  // where neither exists.
  const ideToggle = document.getElementById('ide-toggle');

  els.clear.addEventListener('click', () => {
    controller?.cancelAll();
    activeTaskId = null;
    state = { ...initialState() };

    // The welcome panel is removed on first message, so put it back.
    if (!els.welcome.isConnected) {
      els.transcript.prepend(els.welcome);
    }
    els.transcript.querySelectorAll('.message').forEach((node) => node.remove());
    els.input.value = '';
    autoGrow();
    render();
    persistCurrentSession();
    renderBoard();
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
  // exist — everywhere else (the Android webview, a plain browser) the
  // device-local web backend provides files and an Ask agent instead, and
  // the IDE mounts over that. Monaco is bundled, so the chat view pays
  // nothing until the IDE opens.
  //
  // On launch the IDE opens straight into the last workspace. With no stored
  // workspace the app opens on chat instead of popping a native folder dialog
  // uninvited; the IDE button takes it from there.
  const ideHost = document.getElementById('ide');
  const ideRoot = document.getElementById('ide-root');
  const appRoot = document.querySelector('.app');
  const hostIde = bridge.terminal && bridge.ideFs && bridge.agent;
  // The web backend fills exactly the gap the webview has: no host bridges
  // at all. Where real bridges exist it is never created, so desktop
  // behaviour is untouched — and its localStorage seed never writes there.
  const webBackend = !hostIde
    ? createWebBackend({
        config: () => activeConfig ?? defaultConfig(readEnv()),
        env: readEnv,
        storage: webFsStorage,
      })
    : null;
  const terminal = bridge.terminal;
  const ideFs = bridge.ideFs ?? webBackend?.ideFs;
  const agent = bridge.agent ?? webBackend?.agent;
  const ideCapable = Boolean(ideHost && ideRoot && ideFs && agent);

  // Headless agent for Chat + Builder mode: the same bridge the IDE view
  // uses, without mounting the IDE. Runs land in the Activity Hub.
  headlessAgent = agent
    ? {
        run: (prompt, root, options) =>
          agent.run(prompt, root, { ...options, keys: loadKeys(keyStorage) }),
        cancel: () => agent.cancel(),
        onStep: (handler) => agent.onStep(handler),
      }
    : undefined;
  resolveHeadlessRoot = async () => {
    const stored = storedWorkspaceRoot();
    if (stored) return stored;
    if (bridge.workspaceRoot) {
      try {
        return await bridge.workspaceRoot();
      } catch {
        return null;
      }
    }
    try {
      return (await webBackend?.workspaceRoot()) ?? null;
    } catch {
      return null;
    }
  };

  if (!ideCapable && ideToggle instanceof HTMLButtonElement) {
    ideToggle.hidden = true;
  }

  if (
    ideCapable && ideHost && ideRoot && appRoot &&
    ideFs && agent
  ) {
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
          modelPicker: bridge.models
            ? {
                catalog: () => catalogEntries(),
                install: async (id) => {
                  try {
                    return (await bridge.models?.fetch(id))?.ok ?? false;
                  } catch {
                    return false;
                  }
                },
                confirmInstall: (entry) => pickerHandlers.confirmInstall(entry),
                // Same progress and cancel the chat header gets, so "silent"
                // means no dialog in both places rather than no feedback in
                // one of them.
                subscribe: (id, onProgress) =>
                  pickerHandlers.subscribe(
                    { id, label: id, download: { bytes: 0 } },
                    onProgress,
                  ),
                cancel: async (id) => pickerHandlers.cancel?.({ id, label: id }) ?? false,
              }
            : undefined,
          maxIterations: () => maxIterationsFor(effortId),
          confirmDestructive: async (prompt) => {
            if (approvalMode !== 'ask-first') return true;
            return showApproval(prompt);
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
          // this handler and its first passing end-to-end test. Without a
          // host picker (web backend) the fixed device workspace opens.
          const stored = storedWorkspaceRoot();
          if (stored) {
            mounted = await mountIde(stored);
            return;
          }
          const root = bridge.workspaceRoot
            ? await bridge.workspaceRoot()
            : await webBackend?.workspaceRoot() ?? null;
          if (root) mounted = await mountIde(root);
        })();
      });
    }

    const chatToggle = document.getElementById('ide-chat-toggle');
    chatToggle?.addEventListener('click', showChat);

    const folderButton = document.getElementById('ide-folder-button');
    // The web backend owns one fixed workspace, so the folder picker has
    // nothing to pick there and stays hidden with it.
    if (folderButton && !bridge.workspaceRoot) {
      folderButton.setAttribute('hidden', '');
    }
    folderButton?.addEventListener('click', () => {
      void (async () => {
        const root = bridge.workspaceRoot ? await bridge.workspaceRoot() : null;
        if (root) {
          // A fresh view for a fresh folder: models from the old workspace
          // must not survive the switch. The pending root rides through the
          // reload in session storage, which dies with the tab.
          sessionStorage.setItem('gearvane.ide.pendingRoot', root);
          window.location.reload();
        }
      })();
    });

    wireIdeDialogButtons();

    const pending = sessionStorage.getItem('gearvane.ide.pendingRoot');
    if (pending) {
      sessionStorage.removeItem('gearvane.ide.pendingRoot');
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

    const modelsToggle = document.getElementById('ide-models-toggle');
    modelsToggle?.addEventListener('click', () => void showModels());

    const appearanceIdeToggle = document.getElementById('ide-appearance-toggle');
    appearanceIdeToggle?.addEventListener('click', () => openAppearance('settings'));
  }

  /** Last workspace, so the IDE opens where the user left it. */
  function storedWorkspaceRoot(): string | null {
    try {
      return localStorage.getItem('gearvane.ide.root');
    } catch {
      return null;
    }
  }

  function rememberWorkspaceRoot(root: string): void {
    try {
      localStorage.setItem('gearvane.ide.root', root);
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