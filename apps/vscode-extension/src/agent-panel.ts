/**
 * The coding agent panel.
 *
 * A webview beside the editor that runs the harness agent loop over the open
 * workspace. This is the part that makes the extension an IDE assistant rather
 * than a set of one-shot commands.
 *
 * ## What it can do
 *
 * Read, write, edit, and list files, confined to the workspace through the
 * same `Workspace` containment the CLI uses, including the symlink check. With
 * shell access explicitly enabled per session, it can also run commands.
 *
 * ## What it cannot do
 *
 * There is no sandbox. Shell commands are gated, and an approved command can
 * still read any file the user can. The panel says so the first time shell
 * access is requested, rather than burying it in the README.
 *
 * ## Why the webview and not a tree view
 *
 * An agent run is a conversation with tool calls interleaved. Rendering that
 * into a tree view or the output channel produces a wall of text nobody can
 * read. The webview renders the same step data the loop returns, with no
 * framework, so the extension stays a 10 KB bundle with no runtime
 * dependencies.
 */

import * as vscode from 'vscode';

import {
  ToolRegistry,
  Workspace,
  createShellTool,
  fileTools,
  runAgent,
  type AgentResult,
  type AgentStep,
  type Tool,
} from '@waypoint/harness';

import { SafetyManager, type WaypointConfig } from '@waypoint/core';

/** Messages from the webview to the extension. */
interface Inbound {
  type: 'ask' | 'cancel' | 'enableShell' | 'disableShell' | 'ready';
  text?: string;
}

interface RunState {
  running: boolean;
  shellEnabled: boolean;
  steps: AgentStep[];
  result?: AgentResult;
  error?: string;
  /** Set once, the first time the user is asked about shell access. */
  explainedNoSandbox: boolean;
}

const RUN_DEFAULTS: RunState = {
  running: false,
  shellEnabled: false,
  steps: [],
  explainedNoSandbox: false,
};

export class AgentPanel {
  private panel: vscode.WebviewPanel | undefined;
  private state: RunState = { ...RUN_DEFAULTS };
  private controller: AbortController | undefined;
  private history: Array<{ role: 'user' | 'assistant'; text: string }> = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getConfig: () => WaypointConfig,
    private readonly workspaceRoot: () => string | undefined,
  ) {}

  /** Bring the panel into view, creating it on first use. */
  reveal(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'waypoint.agent',
      'Waypoint Agent',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Local resource roots restricted to this extension, so a webview
        // message cannot make the host load arbitrary files.
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      // Cancelling on close is deliberate: a run that outlives its panel has
      // no visible output and looks like the agent hung.
      this.controller?.abort();
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      (message: Inbound) => void this.receive(message),
      undefined,
      this.disposables,
    );
  }

  private readonly disposables: vscode.Disposable[] = [];

  private async receive(message: Inbound): Promise<void> {
    switch (message.type) {
      case 'enableShell':
        await this.enableShell();
        return;
      case 'disableShell':
        this.state.shellEnabled = false;
        this.post();
        return;
      case 'cancel':
        this.controller?.abort();
        return;
      case 'ask':
        await this.ask(message.text ?? '');
        return;
      default:
        return;
    }
  }

  private async enableShell(): Promise<void> {
    if (this.state.explainedNoSandbox) {
      this.state.shellEnabled = true;
      this.post();
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      'Shell access is gated, not sandboxed. ' +
        'Blocked commands are refused and consequential ones need your approval, ' +
        'but an approved command can still read any file you can. There is no sandbox.',
      { modal: true },
      // MessageItem rather than a bare string, so each option has an explicit
      // title. The API accepts both; the bare form is ambiguous about which
      // string is the label when there is more than one.
      { title: 'Enable for this session' },
      { title: 'Cancel' },
    );

    // Recorded whichever way it went: the explanation is the point, and a
    // second request should not ask again.
    this.state.explainedNoSandbox = true;

    if (answer?.title === 'Enable for this session') {
      this.state.shellEnabled = true;
    }

    this.post();
  }

  private async ask(text: string): Promise<void> {
    const task = text.trim();
    if (!task || this.state.running) return;

    const root = this.workspaceRoot();
    if (!root) {
      this.state.error = 'Open a folder first. The agent needs a workspace to work in.';
      this.post();
      return;
    }

    const { model, providerName } = await this.resolveModel();
    if (!model) {
      this.state.error =
        'No usable provider is configured. Check your model health, or start a local server.';
      this.post();
      return;
    }

    const agentModel = model;

    this.state.running = true;
    this.state.error = undefined;
    this.state.result = undefined;
    this.state.steps = [];
    this.history.push({ role: 'user', text: task });
    this.post();

    this.controller = new AbortController();

    const workspace = new Workspace(root);
    const registry = new ToolRegistry(this.toolkit());

    try {
      const result = await runAgent(task, {
        model: agentModel,
        registry,
        context: { workspace, maxReadBytes: 256 * 1024 },
        maxIterations: 20,
        signal: this.controller.signal,
        onStep: (step) => {
          this.state.steps.push(step);
          this.post();
        },
      });

      this.state.result = result;
      this.history.push({ role: 'assistant', text: result.content });
    } catch (error) {
      this.state.error = (error as Error).message;
    } finally {
      this.state.running = false;
      this.controller = undefined;
      this.post();
    }

    void providerName;
  }

  private toolkit(): Tool[] {
    const tools: Tool[] = [...fileTools()];

    if (this.state.shellEnabled) {
      tools.push(
        createShellTool({
          safety: new SafetyManager(this.getConfig().safety),
          approve: async (request) => {
            const answer = await vscode.window.showWarningMessage(
              `Allow ${request.operation}?`,
              { modal: true },
              { title: 'Run' },
              { title: 'Cancel' },
            );
            return answer?.title === 'Run';
          },
        }),
      );
    }

    return tools;
  }

  /**
   * First provider that answers.
   *
   * The same choice the CLI makes: an agent run is already the expensive path,
   * so overriding the user's configuration by routing here would be worse than
   * not routing at all.
   */
  private async resolveModel(): Promise<{
    model?: import('@waypoint/harness').AgentModel;
    providerName?: string;
  }> {
    const { ProviderFactory } = await import('@waypoint/core');

    const factory = new ProviderFactory({
      env: process.env as Record<string, string | undefined>,
    });

    for (const tier of Object.values(this.getConfig().tiers)) {
      for (const provider of tier.providers) {
        let client;
        try {
          client = factory.create(provider);
        } catch {
          continue;
        }

        return {
          providerName: provider.name,
          model: {
            complete: (prompt, options) => client.complete(prompt, options),
          },
        };
      }
    }

    return {};
  }

  private post(): void {
    void this.panel?.webview.postMessage({ type: 'state', state: this.state });
  }

  /**
   * The panel document.
   *
   * Built as a string with a strict Content-Security-Policy and a nonce. The
   * only script is inline and carries the nonce; nothing is loaded from a
   * remote origin, because a panel that fetched a remote script would be able
   * to run whatever that origin served.
   */
  private html(): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  :root { color-scheme: dark; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    margin: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  #log { flex: 1; overflow-y: auto; padding: 1rem; }
  .step { border-left: 2px solid var(--vscode-panel-border); padding-left: 0.75rem; margin-bottom: 0.9rem; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .tool-ok::before { content: 'ok  '; color: var(--vscode-testing-iconPassed); }
  .tool-failed::before { content: 'err '; color: var(--vscode-testing-iconFailed); }
  .dim { opacity: 0.7; }
  .error { color: var(--vscode-errorForeground); }
  .answer { white-space: pre-wrap; margin: 0.5rem 0; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 0.6rem; }
  textarea {
    width: 100%; resize: vertical; min-height: 3.5rem;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 0.5rem; font: inherit;
  }
  .row { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0; border-radius: 2px; padding: 0.4rem 0.8rem; cursor: pointer; font: inherit;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  label.shell { display: flex; align-items: center; gap: 0.35rem; font-size: 0.9em; }
</style>
</head>
<body>
<div id="log"></div>
<footer>
  <textarea id="input" placeholder="Describe a change. Enter sends, Shift+Enter adds a line."></textarea>
  <div class="row">
    <button id="send">Send</button>
    <button id="cancel" class="secondary" disabled>Stop</button>
    <label class="shell">
      <input type="checkbox" id="shell" />
      Allow commands
    </label>
    <span class="dim" id="status"></span>
  </div>
</footer>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const send = document.getElementById('send');
const cancel = document.getElementById('cancel');
const shell = document.getElementById('shell');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: tool names and file paths come from a model.
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(state) {
  log.textContent = '';
  shell.checked = state.shellEnabled;

  for (const step of state.steps) {
    const block = el('div', 'step');
    for (const call of step.toolCalls) {
      const result = step.results.find(r => r.name === call.name);
      block.append(el('div', 'tool ' + (result && result.ok ? 'tool-ok' : 'tool-failed'), call.name));
    }
    if (step.content && step.content.trim()) {
      block.append(el('div', 'answer dim', step.content.trim()));
    }
    log.append(block);
  }

  if (state.error) log.append(el('div', 'error', state.error));

  if (state.result) {
    log.append(el('div', 'answer', state.result.content));
    const meta = el('div', 'dim',
      state.result.iterations + ' iteration(s), ' +
      state.result.tokensIn + '/' + state.result.tokensOut + ' tokens, ' +
      'stopped: ' + state.result.stopReason);
    log.append(meta);
    if (state.result.failedToolCalls.length > 0) {
      log.append(el('div', 'error', state.result.failedToolCalls.length + ' tool call(s) failed'));
    }
  }

  send.disabled = state.running;
  cancel.disabled = !state.running;
  document.getElementById('status').textContent =
    state.running ? 'running' : (state.shellEnabled ? 'shell on' : '');

  log.scrollTop = log.scrollHeight;
}

send.addEventListener('click', () => {
  const text = input.value;
  if (!text.trim()) return;
  input.value = '';
  vscodeApi.postMessage({ type: 'ask', text });
});

cancel.addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));

shell.addEventListener('change', () => {
  vscodeApi.postMessage({ type: shell.checked ? 'enableShell' : 'disableShell' });
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send.click();
  }
});

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'state') render(event.data.state);
});

vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.controller?.abort();
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}