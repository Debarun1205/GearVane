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

import type { AgentStep } from '@waypoint/harness';

import { installMonacoEnvironment, languageForPath, monaco } from './monaco.js';
import { buildTree, renderTree, type TreeNode } from './file-tree.js';
import { createTerminal, type TerminalBridge } from './terminal.js';
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
}

/** A file open in the editor. */
interface OpenFile {
  path: string;
  model: monaco.editor.ITextModel;
}

export interface IdeViewOptions {
  workspaceRoot: string;
  terminal: TerminalBridge;
  fs: FsBridge;
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

  constructor(options: IdeViewOptions) {
    this.options = options;
  }

  /** Mount the view into a container. */
  mount(container: HTMLElement): void {
    this.container = container;
    installMonacoEnvironment();

    container.append(this.buildTreePane(), this.buildEditorPane(), this.buildBottomPane());

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

  private buildEditorPane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'ide-pane ide-editor-pane';
    pane.append(this.header('Editor'));

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

    return pane;
  }

  private buildBottomPane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'ide-pane ide-bottom-pane';

    const tabs = document.createElement('div');
    tabs.className = 'ide-tabs';
    tabs.append(this.tab('Terminal', true), this.tab('Problems', false));
    pane.append(tabs);

    const terminalHost = document.createElement('div');
    terminalHost.className = 'ide-terminal-host';
    pane.append(terminalHost);

    this.terminal = createTerminal(terminalHost, this.options.terminal, this.options.workspaceRoot);

    return pane;
  }

  private terminal: ReturnType<typeof createTerminal> | undefined;

  private header(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'ide-pane-header';
    node.textContent = text;
    return node;
  }

  private tab(text: string, active: boolean): HTMLElement {
    const node = document.createElement('span');
    node.className = `ide-tab${active ? ' ide-tab-active' : ''}`;
    node.textContent = text;
    return node;
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
  async openFile(path: string): Promise<void> {
    if (!this.editor) return;

    const existing = this.openFiles.get(path);
    if (existing) {
      this.editor.setModel(existing.model);
      this.activePath = path;
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

    this.openFiles.set(path, { path, model });
    this.editor.setModel(model);
    this.activePath = path;
  }

  /** Save the active file. Bound to Ctrl+S in the editor pane. */
  async saveActive(): Promise<void> {
    const path = this.activePath;
    const file = path ? this.openFiles.get(path) : undefined;

    if (!path || !file) {
      this.setStatus('Nothing to save.');
      return;
    }

    const result = await this.options.fs.write(path, file.model.getValue());

    this.setStatus(
      result.ok ? `Saved ${path}.` : (result.error ?? `Could not save ${path}.`),
    );
  }

  /** Reveal a file the agent touched. */
  revealFile(path: string): void {
    void this.openFile(path);
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
    this.terminal?.dispose();
    this.editor?.dispose();
    for (const file of this.openFiles.values()) file.model.dispose();
    this.openFiles.clear();
  }
}