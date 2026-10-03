/**
 * The IDE view.
 *
 * A layout with a file tree on the left, an editor in the centre, a terminal
 * along the bottom, and the agent panel on the right. Each pane is its own
 * module; this one only arranges them and wires the interactions between them.
 *
 * ## Why this is a separate module
 *
 * The IDE is the largest surface in the app and the only one where the panes
 * need to talk to each other: opening a file from the tree puts it in the
 * editor, and the agent's tool calls should reveal the file it touched. Keeping
 * the wiring in one place means the individual panes stay simple.
 */

import type { AgentResult, AgentStep } from '@waypoint/harness';

import { installMonacoEnvironment, languageForPath, monaco } from './monaco.js';
import { buildTree, renderTree, type TreeNode } from './file-tree.js';
import { createTerminal, type TerminalBridge } from './terminal.js';
import {
  CompletionCache,
  MAX_CONSECUTIVE_FAILURES,
  buildFimRequest,
  fetchCompletion,
  shouldComplete,
  type InlineModel,
} from './inline-complete.js';
import type { FsEntry } from './fs-store.js';

/**
 * Filesystem access for the IDE.
 *
 * Implemented by the main process, where Node exists. The renderer must never
 * import `node:fs` itself: this bundle also ships inside the Android webview,
 * and a bare `node:` import fails the whole module there.
 */
export interface FsBridge {
  list(): Promise<{ ok: boolean; entries?: FsEntry[]; error?: string }>;
  read(path: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  write(path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  remove(path: string): Promise<{ ok: boolean; error?: string }>;
  search(query: string): Promise<{ ok: boolean; content?: string; error?: string }>;
}

/** One file an agent run created or changed, with its before-state. */
export interface FileChange {
  path: string;
  /** Null when the file did not exist before the run. */
  original: string | null;
  current: string;
}

/**
 * A file open in the editor.
 *
 * `savedValue` is what the file looked like the last time it was read or
 * written. Comparing against it is what makes the dirty dot honest: a file
 * whose content matches the disk is clean even if it was edited and undone.
 */
interface OpenFile {
  path: string;
  name: string;
  model: monaco.editor.ITextModel;
  savedValue: string;
  dirty: boolean;
}

/**
 * Agent access for the IDE.
 *
 * The loop itself runs in the main process; this is the narrow surface the
 * renderer sees. Prompts go one way, steps and the final result come back.
 */
export interface AgentBridge {
  run(
    prompt: string,
    options?: { mode?: 'ask' | 'build' },
  ): Promise<{
    ok: boolean;
    result?: AgentResult;
    error?: string;
    changed?: FileChange[];
  }>;
  cancel(): void;
  onStep(handler: (step: AgentStep) => void): () => void;
}

export interface IdeViewOptions {
  workspaceRoot: string;
  terminal: TerminalBridge;
  fs: FsBridge;
  agent: AgentBridge;
  /**
   * Local model for ghost-text completions. Absent when no local server is
   * configured, and ghost text stays off rather than failing per keystroke.
   */
  completion?: InlineModel;
  /** Called when the agent touches a file, so the editor can reveal it. */
  onAgentFile?: (path: string) => void;
}

export class IdeView {
  private readonly options: IdeViewOptions;

  private container: HTMLElement | undefined;
  private editor: monaco.editor.IStandaloneCodeEditor | undefined;
  private openFiles = new Map<string, OpenFile>();
  private activePath: string | undefined;
  private treeRoot: TreeNode[] = [];
  private agentRunning = false;
  private agentUnsubscribe: (() => void) | undefined;

  constructor(options: IdeViewOptions) {
    this.options = options;
  }

  /** Mount the view into a container. */
  mount(container: HTMLElement): void {
    this.container = container;
    installMonacoEnvironment();

    container.append(
      this.buildTreePane(),
      this.buildEditorPane(),
      this.buildAgentPane(),
      this.buildBottomPane(),
    );

    void this.refreshTree();
  }

  /* ---------------------------------------------------------------- */
  /* Panes                                                             */
  /* ---------------------------------------------------------------- */

  private buildTreePane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'ide-pane ide-tree-pane';
    pane.innerHTML = '';
    pane.append(this.header('Explorer'));

    const search = document.createElement('input');
    search.className = 'ide-search-input';
    search.type = 'search';
    search.placeholder = 'Search files… (Enter)';
    search.setAttribute('aria-label', 'Search file contents');
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.runSearch(search.value);
    });
    pane.append(search);

    const results = document.createElement('div');
    results.className = 'ide-search-results';
    pane.append(results);
    this.searchResults = results;

    const body = document.createElement('div');
    body.className = 'ide-tree-body';
    pane.append(body);

    // Re-rendered on refresh; the body is replaced rather than mutated so a
    // stale node cannot survive a file being deleted under it.
    this.treeBody = body;

    const refresh = document.createElement('button');
    refresh.className = 'ide-refresh';
    refresh.type = 'button';
    refresh.title = 'Refresh the file tree';
    refresh.textContent = '↻';
    refresh.addEventListener('click', () => void this.refreshTree());
    pane.append(refresh);

    return pane;
  }

  private treeBody: HTMLElement | undefined;
  private searchResults: HTMLElement | undefined;

  /**
   * Run a content search and render path:line hits.
   *
   * The search itself runs in the main process through the same tool the
   * agent uses, so what the user sees is what the agent would find.
   */
  private async runSearch(query: string): Promise<void> {
    if (!this.searchResults) return;
    const trimmed = query.trim();
    if (!trimmed) {
      this.searchResults.textContent = '';
      return;
    }

    this.searchResults.textContent = 'Searching…';
    const result = await this.options.fs.search(trimmed);

    this.searchResults.textContent = '';
    if (!result.ok) {
      this.searchResults.textContent = result.error ?? 'Search failed.';
      return;
    }

    const lines = (result.content ?? '').split('\n').filter(Boolean);
    if (lines.length === 0 || (lines.length === 1 && lines[0]?.startsWith('No matches'))) {
      this.searchResults.textContent = `No matches for "${trimmed}".`;
      return;
    }

    for (const line of lines) {
      // path:line: text — but informational footers start with … or (.
      if (line.startsWith('…') || line.startsWith('(')) {
        const note = document.createElement('div');
        note.className = 'ide-search-note';
        note.textContent = line;
        this.searchResults.append(note);
        continue;
      }

      const separator = line.indexOf(':');
      const second = separator === -1 ? -1 : line.indexOf(':', separator + 1);
      if (separator === -1 || second === -1) continue;

      const path = line.slice(0, separator);
      const lineNumber = Number(line.slice(separator + 1, second));
      const text = line.slice(second + 1).trim();
      if (!path || !Number.isInteger(lineNumber)) continue;

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ide-search-row';
      row.title = `${path}:${lineNumber}`;

      const location = document.createElement('span');
      location.className = 'ide-search-location';
      location.textContent = `${path}:${lineNumber}`;
      const snippet = document.createElement('span');
      snippet.className = 'ide-search-snippet';
      snippet.textContent = text;
      row.append(location, snippet);

      row.addEventListener('click', () => void this.openFile(path, lineNumber));
      this.searchResults.append(row);
    }
  }

  private buildEditorPane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'ide-pane ide-editor-pane';
    pane.append(this.header('Editor'));

    const tabBar = document.createElement('div');
    tabBar.className = 'ide-tabbar';
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Open files');
    pane.append(tabBar);
    this.tabBar = tabBar;

    const host = document.createElement('div');
    host.className = 'ide-editor-host';
    pane.append(host);

    this.editor = monaco.editor.create(host, {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: 'selection',
      value: '// Select a file from the tree, or describe a change to the agent.\n',
    });

    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void this.saveActive(),
    );

    this.registerGhostText();

    this.renderTabs();
    return pane;
  }

  private ghostAbort: AbortController | undefined;
  private ghostFailures = 0;
  private ghostCache = new CompletionCache();
  private ghostRegistration: monaco.IDisposable | undefined;

  /**
   * Ghost-text completions from the local model.
   *
   * Each keystroke aborts the previous request: without that, slow responses
   * arrive for text the user has already moved past, and the ghost describes
   * a cursor position that no longer exists. After repeated failures (Ollama
   * down, model not pulled) the provider unregisters until remount, because
   * a failing fetch per keystroke is pure console noise.
   */
  private registerGhostText(): void {
    const inline = this.options.completion;
    if (!inline) return;

    this.ghostRegistration = monaco.languages.registerInlineCompletionsProvider(
      { scheme: 'file' },
      {
        provideInlineCompletions: async (model, position, _context, token) => {
          const line = model.getLineContent(position.lineNumber);
          const linePrefix = line.slice(0, position.column - 1);
          if (!shouldComplete(linePrefix)) return { items: [] };

          const prefix = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const suffix = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: model.getLineCount() + 1,
            endColumn: 1,
          });

          const cached = this.ghostCache.get(prefix, suffix);
          if (cached !== undefined) {
            return { items: [{ insertText: cached }] };
          }

          this.ghostAbort?.abort();
          const request = new AbortController();
          this.ghostAbort = request;
          token.onCancellationRequested(() => request.abort());

          const fim = buildFimRequest(inline, prefix, suffix);
          let ghost: string | undefined;
          try {
            ghost = await fetchCompletion(fim, request.signal);
          } catch {
            this.ghostFailures += 1;
            if (this.ghostFailures >= MAX_CONSECUTIVE_FAILURES) {
              this.ghostRegistration?.dispose();
              this.ghostRegistration = undefined;
              this.setStatus(
                'Ghost text off: the local model is unreachable. Start Ollama and reopen the folder to retry.',
              );
            }
            return { items: [] };
          }

          if (ghost === undefined) return { items: [] };
          this.ghostFailures = 0;
          this.ghostCache.set(prefix, suffix, ghost);
          return { items: [{ insertText: ghost }] };
        },
        freeInlineCompletions: () => {
          this.ghostAbort?.abort();
        },
      },
    );
  }

  private tabBar: HTMLElement | undefined;

  /** A file open in the editor, with what was last saved. */
  private renderTabs(): void {
    if (!this.tabBar) return;
    this.tabBar.textContent = '';

    for (const [path, file] of this.openFiles) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ide-tab' + (path === this.activePath ? ' ide-tab-active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(path === this.activePath));
      tab.title = path;

      const label = document.createElement('span');
      label.className = 'ide-tab-label';
      label.textContent = file.dirty ? `● ${file.name}` : file.name;
      tab.append(label);

      const close = document.createElement('span');
      close.className = 'ide-tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${file.name}`);
      close.addEventListener('click', (event) => {
        // The tab click underneath must not also fire and switch to a file
        // that is about to close.
        event.stopPropagation();
        this.closeFile(path);
      });
      tab.append(close);

      tab.addEventListener('click', () => void this.openFile(path));
      this.tabBar.append(tab);
    }
  }

  private buildBottomPane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'ide-pane ide-bottom-pane';

    const tabs = document.createElement('div');
    tabs.className = 'ide-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Bottom panel');
    pane.append(tabs);

    const terminalHost = document.createElement('div');
    terminalHost.className = 'ide-terminal-host';
    pane.append(terminalHost);

    const problemsHost = document.createElement('div');
    problemsHost.className = 'ide-problems-host';
    problemsHost.setAttribute('hidden', '');
    pane.append(problemsHost);
    this.problemsHost = problemsHost;
    this.renderProblems();

    const showTerminal = (): void => {
      terminalHost.removeAttribute('hidden');
      problemsHost.setAttribute('hidden', '');
      terminalTab.classList.add('ide-tab-active');
      problemsTab.classList.remove('ide-tab-active');
    };
    const showProblems = (): void => {
      problemsHost.removeAttribute('hidden');
      terminalHost.setAttribute('hidden', '');
      problemsTab.classList.add('ide-tab-active');
      terminalTab.classList.remove('ide-tab-active');
    };

    const terminalTab = this.tab('Terminal', true, showTerminal);
    const problemsTab = this.tab('Problems', false, showProblems);
    tabs.append(terminalTab, problemsTab);
    this.problemsTab = problemsTab;

    this.terminal = createTerminal(terminalHost, this.options.terminal, this.options.workspaceRoot);

    return pane;
  }

  private terminal: ReturnType<typeof createTerminal> | undefined;
  private problemsHost: HTMLElement | undefined;
  private problemsTab: HTMLElement | undefined;
  private problemCount = 0;

  private header(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'ide-pane-header';
    node.textContent = text;
    return node;
  }

  private tab(text: string, active: boolean, onSelect: () => void): HTMLElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `ide-tab${active ? ' ide-tab-active' : ''}`;
    node.textContent = text;
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(active));
    node.addEventListener('click', () => {
      onSelect();
      node.setAttribute('aria-selected', 'true');
    });
    return node;
  }

  /**
   * Failed tool calls from the last agent run.
   *
   * Not a linter and not pretending to be one: these are the calls that
   * actually failed, with the model's own error text. An empty list means no
   * run has failed yet, which the pane says rather than implying clean code.
   */
  private renderProblems(failures: Array<{ name: string; error: string }> = []): void {
    this.problemCount = failures.length;
    if (this.problemsTab) {
      this.problemsTab.textContent =
        failures.length > 0 ? `Problems (${failures.length})` : 'Problems';
    }
    if (!this.problemsHost) return;
    this.problemsHost.textContent = '';

    if (failures.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ide-problems-empty';
      empty.textContent = 'No failed tool calls from the last run.';
      this.problemsHost.append(empty);
      return;
    }

    for (const failure of failures) {
      const row = document.createElement('div');
      row.className = 'ide-problem-row';

      const name = document.createElement('span');
      name.className = 'ide-problem-name';
      name.textContent = failure.name;
      const message = document.createElement('span');
      message.className = 'ide-problem-message';
      message.textContent = failure.error;
      row.append(name, message);
      this.problemsHost.append(row);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Files                                                              */
  /* ---------------------------------------------------------------- */

  /** List the workspace and rebuild the tree. */
  async refreshTree(): Promise<void> {
    if (!this.treeBody) return;

    const entries = await this.listWorkspace();
    this.treeRoot = buildTree(entries, this.options.workspaceRoot);

    this.treeBody.textContent = '';
    renderTree(this.treeBody, this.treeRoot, (path) => void this.openFile(path));
  }

  /**
   * List the workspace through the main process.
   *
   * The bridge returns structured entries rather than rendered text, so there
   * is nothing to parse back. Containment is enforced on the main-process
   * side by the same `Workspace` code as the harness tools.
   */
  private async listWorkspace(): Promise<
    Array<{ name: string; path: string; isDirectory: boolean; size?: number }>
  > {
    const result = await this.options.fs.list();

    if (!result.ok || !result.entries) {
      this.setStatus(result.error ?? 'Could not list the workspace.');
      return [];
    }

    return result.entries;
  }

  /** Open a file in the editor, creating a model if needed. */
  async openFile(path: string, line?: number): Promise<void> {
    if (!this.editor) return;

    const existing = this.openFiles.get(path);
    if (existing) {
      this.editor.setModel(existing.model);
      this.activePath = path;
      this.renderTabs();
      if (line !== undefined) this.revealLine(line);
      return;
    }

    const result = await this.options.fs.read(path);

    if (!result.ok || result.content === undefined) {
      this.setStatus(result.error ?? `Could not open ${path}.`);
      return;
    }

    const model = monaco.editor.createModel(
      result.content,
      languageForPath(path),
      monaco.Uri.file(`${this.options.workspaceRoot}/${path}`),
    );

    const file: OpenFile = {
      path,
      name: path.split('/').pop() ?? path,
      model,
      savedValue: result.content,
      dirty: false,
    };
    this.openFiles.set(path, file);
    this.editor.setModel(model);
    this.activePath = path;
    if (line !== undefined) this.revealLine(line);

    // Dirty state follows the content, not the keystrokes: an edit that is
    // undone returns the file to clean without a save.
    model.onDidChangeContent(() => {
      file.dirty = model.getValue() !== file.savedValue;
      this.renderTabs();
    });

    this.renderTabs();
  }

  /** Save the active file. Bound to Ctrl+S in the editor pane. */
  async saveActive(): Promise<void> {
    const path = this.activePath;
    const file = path ? this.openFiles.get(path) : undefined;

    if (!path || !file) {
      this.setStatus('Nothing to save.');
      return;
    }

    const value = file.model.getValue();
    const result = await this.options.fs.write(path, value);

    if (result.ok) {
      file.savedValue = value;
      file.dirty = false;
      this.renderTabs();
    }

    this.setStatus(
      result.ok ? `Saved ${path}.` : (result.error ?? `Could not save ${path}.`),
    );
  }

  /**
   * Close a tab.
   *
   * A dirty tab asks before discarding, through a blocking confirm. It is the
   * ugliest dialog in the app and the only honest one available without a
   * custom modal: silently dropping edits would be worse, and autosaving
   * would write files the user never asked to write.
   */
  closeFile(path: string): void {
    const file = this.openFiles.get(path);
    if (!file) return;

    if (file.dirty && !window.confirm(`Discard unsaved changes to ${file.name}?`)) {
      return;
    }

    file.model.dispose();
    this.openFiles.delete(path);

    if (this.activePath === path) {
      const remaining = [...this.openFiles.keys()];
      const next = remaining[remaining.length - 1];
      if (next && this.editor) {
        this.editor.setModel(this.openFiles.get(next)?.model ?? null);
        this.activePath = next;
      } else {
        this.activePath = undefined;
      }
    }

    this.renderTabs();
  }

  /** Reveal a file the agent touched. */
  revealFile(path: string): void {
    void this.openFile(path);
  }

  /** Center the editor on a 1-based line number. */
  private revealLine(line: number): void {
    if (!this.editor || line < 1) return;
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column: 1 });
  }

  /* ---------------------------------------------------------------- */
  /* Agent prompt                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * The prompt box.
   *
   * Describe the site and the agent builds it: it lists the templates, picks
   * one, scaffolds it, and refines the files. There is no shell here on
   * purpose — commands run in the terminal below, where the user can see
   * them, rather than invisibly inside a run.
   */
  private buildAgentPane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'ide-pane ide-agent-pane';
    pane.append(this.header('Agent'));

    const hint = document.createElement('p');
    hint.className = 'ide-agent-hint';
    hint.textContent =
      'Describe the site to build. No shell access: run commands in the terminal.';
    pane.append(hint);

    const input = document.createElement('textarea');
    input.className = 'ide-agent-input';
    input.placeholder = 'A landing page for a coffee shop with a menu and contact form…';
    input.setAttribute('aria-label', 'Describe the site to build');
    pane.append(input);
    this.agentInput = input;

    const modeLabel = document.createElement('label');
    modeLabel.className = 'ide-agent-mode-label';
    modeLabel.textContent = 'Mode ';
    const mode = document.createElement('select');
    mode.className = 'ide-agent-mode';
    mode.setAttribute('aria-label', 'Agent mode');
    for (const [value, label] of [
      ['build', 'Build — create and change files'],
      ['ask', 'Ask — read-only, answers only'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      mode.append(option);
    }
    modeLabel.append(mode);
    pane.append(modeLabel);
    this.agentMode = mode;

    const row = document.createElement('div');
    row.className = 'ide-agent-row';

    const build = document.createElement('button');
    build.className = 'ide-agent-button';
    build.type = 'button';
    build.textContent = 'Build';
    build.addEventListener('click', () => void this.runAgentPrompt());
    pane.append(build);
    this.agentBuildButton = build;

    const stop = document.createElement('button');
    stop.className = 'ide-agent-button ide-agent-stop';
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.disabled = true;
    stop.addEventListener('click', () => this.stopAgentPrompt());
    pane.append(stop);
    this.agentStopButton = stop;

    row.append(build, stop);
    pane.append(row);

    const log = document.createElement('div');
    log.className = 'ide-agent-log';
    pane.append(log);
    this.agentLog = log;

    return pane;
  }

  private agentInput: HTMLTextAreaElement | undefined;
  private agentMode: HTMLSelectElement | undefined;
  private agentBuildButton: HTMLButtonElement | undefined;
  private agentStopButton: HTMLButtonElement | undefined;
  private agentLog: HTMLElement | undefined;

  private setAgentRunning(running: boolean): void {
    this.agentRunning = running;
    if (this.agentBuildButton) this.agentBuildButton.disabled = running;
    if (this.agentStopButton) this.agentStopButton.disabled = !running;
  }

  private agentLogLine(text: string, className?: string): void {
    if (!this.agentLog) return;
    const line = document.createElement('div');
    if (className) line.className = className;
    // textContent, never innerHTML: tool names and model output come from
    // outside this page.
    line.textContent = text;
    this.agentLog.append(line);
    this.agentLog.scrollTop = this.agentLog.scrollHeight;
  }

  private async runAgentPrompt(): Promise<void> {
    const prompt = this.agentInput?.value.trim() ?? '';
    if (!prompt || this.agentRunning) return;

    this.setAgentRunning(true);
    if (this.agentLog) this.agentLog.textContent = '';

    this.agentUnsubscribe = this.options.agent.onStep((step) => {
      for (const call of step.toolCalls) {
        const result = step.results.find((entry) => entry.name === call.name);
        this.agentLogLine(
          `${call.name} (${result?.ok ? 'ok' : 'failed'})`,
          result?.ok ? 'ide-agent-ok' : 'ide-agent-failed',
        );
      }
      if (step.content.trim()) this.agentLogLine(step.content.trim());
    });

    try {
      const mode = this.agentMode?.value === 'ask' ? 'ask' : 'build';
      const response = await this.options.agent.run(prompt, { mode });

      if (!response.ok || !response.result) {
        this.agentLogLine(`Failed: ${response.error ?? 'unknown problem'}`, 'ide-agent-failed');
        return;
      }

      const result = response.result;
      this.agentLogLine(result.content);
      this.agentLogLine(
        `${result.iterations} iteration(s), stopped: ${result.stopReason}`,
        'ide-agent-meta',
      );

      this.renderProblems(result.failedToolCalls);

      await this.refreshTree();

      const touched = this.touchedFiles(result.steps);
      const last = touched[touched.length - 1];
      if (last) {
        await this.openFile(last);
        this.options.onAgentFile?.(last);
      }

      if (response.changed && response.changed.length > 0) {
        this.renderChanges(response.changed);
      }
    } finally {
      this.agentUnsubscribe?.();
      this.agentUnsubscribe = undefined;
      this.setAgentRunning(false);
    }
  }

  private stopAgentPrompt(): void {
    this.options.agent.cancel();
    this.agentLogLine('Stopping…', 'ide-agent-meta');
  }

  /* ---------------------------------------------------------------- */
  /* Change review                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * What the run created or changed, with per-file review.
   *
   * Edits land on disk the moment the agent makes them, so review happens
   * after the fact rather than before. Accept keeps the file and dismisses
   * it from the list; Revert writes back the before-state, or deletes the
   * file when the run created it. A file edited again after review reappears
   * on the next run, which is correct: it changed again.
   */
  private renderChanges(changed: FileChange[]): void {
    const section = document.createElement('div');
    section.className = 'ide-changes';

    const title = document.createElement('div');
    title.className = 'ide-changes-title';
    title.textContent = `Changed files (${changed.length})`;
    section.append(title);

    const dismissAll = document.createElement('button');
    dismissAll.type = 'button';
    dismissAll.className = 'ide-agent-button ide-changes-keep';
    dismissAll.textContent = 'Keep all';
    dismissAll.addEventListener('click', () => section.remove());
    section.append(dismissAll);

    const prune = (): void => {
      if (section.querySelectorAll('.ide-change-row').length === 0) {
        section.remove();
      }
    };

    for (const change of changed) {
      section.append(this.renderChangeRow(change, prune));
    }

    this.agentLog?.append(section);
    this.agentLog?.append(this.changesNote(changed));
  }

  private changesNote(changed: FileChange[]): HTMLElement {
    const note = document.createElement('div');
    note.className = 'ide-agent-meta';
    note.textContent =
      'Review covers files the run created or changed, within snapshot caps. ' +
      `Showing ${changed.length} file(s).`;
    return note;
  }

  private renderChangeRow(change: FileChange, onDone: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ide-change-row';

    const label = document.createElement('span');
    label.className = 'ide-change-path';
    label.textContent = `${change.original === null ? 'new' : 'modified'}  ${change.path}`;
    label.title = change.path;
    row.append(label);

    const diff = document.createElement('button');
    diff.type = 'button';
    diff.className = 'ide-change-button';
    diff.textContent = 'Diff';
    diff.addEventListener('click', () => this.openDiff(change));
    row.append(diff);

    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'ide-change-button ide-change-revert';
    revert.textContent = 'Revert';
    revert.title =
      change.original === null
        ? 'Delete this file (the run created it)'
        : 'Restore the content from before the run';
    revert.addEventListener('click', () => {
      void (async () => {
        if (await this.revertChange(change)) {
          row.remove();
          onDone();
        }
      })();
    });
    row.append(revert);

    return row;
  }

  /**
   * Restore a file to its before-state.
   *
   * Returns false when the revert itself failed, so the row stays and the
   * error stays visible. A failed revert that removed the row would read as
   * success.
   */
  private async revertChange(change: FileChange): Promise<boolean> {
    if (change.original === null) {
      const result = await this.options.fs.remove(change.path);
      if (!result.ok) {
        this.setStatus(result.error ?? `Could not delete ${change.path}.`);
        return false;
      }
      this.closeFileSilently(change.path);
    } else {
      const result = await this.options.fs.write(change.path, change.original);
      if (!result.ok) {
        this.setStatus(result.error ?? `Could not revert ${change.path}.`);
        return false;
      }
      const open = this.openFiles.get(change.path);
      if (open) {
        open.model.setValue(change.original);
        open.savedValue = change.original;
        open.dirty = false;
        this.renderTabs();
      }
    }

    await this.refreshTree();
    this.setStatus(
      change.original === null ? `Deleted ${change.path}.` : `Reverted ${change.path}.`,
    );
    return true;
  }

  /** Forget an open file without asking. Used after deleting its file. */
  private closeFileSilently(path: string): void {
    const file = this.openFiles.get(path);
    if (!file) return;
    file.model.dispose();
    this.openFiles.delete(path);
    if (this.activePath === path) this.activePath = undefined;
    this.renderTabs();
  }

  /** Show a side-by-side diff of before and after. */
  private openDiff(change: FileChange): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog dialog-wide ide-diff-dialog';

    const title = document.createElement('h2');
    title.className = 'ide-diff-title';
    title.textContent = change.path;
    dialog.append(title);

    const host = document.createElement('div');
    host.className = 'ide-diff-host';
    dialog.append(host);

    const row = document.createElement('div');
    row.className = 'ide-agent-row';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ide-agent-button';
    close.textContent = 'Close';
    close.addEventListener('click', () => dialog.close());
    row.append(close);
    dialog.append(row);

    document.body.append(dialog);

    const original = monaco.editor.createModel(
      change.original ?? '',
      languageForPath(change.path),
    );
    const modified = monaco.editor.createModel(
      change.current,
      languageForPath(change.path),
    );
    const diff = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: true,
    });
    diff.setModel({ original, modified });

    dialog.addEventListener(
      'close',
      () => {
        diff.dispose();
        original.dispose();
        modified.dispose();
        dialog.remove();
      },
      { once: true },
    );

    dialog.showModal();
  }

  private status: HTMLElement | undefined;

  private setStatus(message: string): void {
    if (!this.status) {
      this.status = document.createElement('div');
      this.status.className = 'ide-status';
      this.container?.append(this.status);
    }
    this.status.textContent = message;
  }

  /* ---------------------------------------------------------------- */
  /* Agent                                                              */
  /* ---------------------------------------------------------------- */

  /** Files the agent has touched, newest last. */
  touchedFiles(steps: AgentStep[]): string[] {
    const seen: string[] = [];
    for (const step of steps) {
      for (const call of step.toolCalls) {
        if (call.name !== 'read_file' && call.name !== 'edit_file' && call.name !== 'write_file') {
          continue;
        }
        const path = call.arguments['path'];
        if (typeof path === 'string' && !seen.includes(path)) seen.push(path);
      }
    }
    return seen;
  }

  dispose(): void {
    // A run that outlives its view has no visible output and looks hung.
    if (this.agentRunning) this.options.agent.cancel();
    this.agentUnsubscribe?.();
    this.ghostAbort?.abort();
    this.ghostRegistration?.dispose();
    this.terminal?.dispose();
    this.editor?.dispose();
    for (const file of this.openFiles.values()) file.model.dispose();
    this.openFiles.clear();
  }
}