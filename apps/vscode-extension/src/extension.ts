import * as vscode from 'vscode';

import {
  ConfigError,
  HealthChecker,
  Orchestrator,
  SafetyManager,
  defaultConfig,
  parseConfig,
  type ExecutionResult,
  type HealthResult,
  type RoutingDecision,
  type GearVaneConfig,
} from '@gearvane/core';

import {
  emptyState,
  formatDuration,
  formatUsd,
  healthIcon,
  tierIcon,
  type SessionEntry,
  type SessionState,
} from './session.js';
import { AgentPanel } from './agent-panel.js';

const MAX_LOG_ENTRIES = 100;

interface LogEntry {
  at: number;
  taskId: string;
  tier: string;
  model: string;
  confidence: number;
  escalated: boolean;
  success?: boolean;
  costUsd: number;
  durationMs?: number;
  reasons: string[];
}

/**
 * VS Code integration for GearVane.
 *
 * The extension does not fork the editor: it reads the selection, asks the
 * core which tier should handle it, and runs the request through the same
 * orchestrator the CLI and app use.
 */
export class GearVaneExtension implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('GearVane');
  private readonly disposables: vscode.Disposable[] = [];

  private config: GearVaneConfig = defaultConfig();
  private orchestrator: Orchestrator | undefined;
  private configPath: string | undefined;
  private readonly log: LogEntry[] = [];
  private state: SessionState = emptyState();
  private readonly onStateChanged = new vscode.EventEmitter<SessionState>();
  private readonly treeProvider: vscode.TreeDataProvider<SessionNode>;
  private agentPanel: AgentPanel | undefined;

  readonly stateChanged = this.onStateChanged.event;

  constructor(
    private readonly extensionUri: vscode.Uri = vscode.Uri.file(__filename),
  ) {
    this.treeProvider = new SessionTreeProvider(this);
    this.disposables.push(this.output, this.onStateChanged);
  }

  /**
   * The agent panel, created on first use.
   *
   * Built with getters rather than values so it always sees the current
   * config; an agent panel holding a stale routing config would quietly behave
   * differently from the rest of the extension.
   */
  private agent(): AgentPanel {
    if (!this.agentPanel) {
      this.agentPanel = new AgentPanel(
        this.extensionUri,
        () => this.config,
        () => this.workspaceRoot(),
      );
      this.disposables.push(this.agentPanel);
    }
    return this.agentPanel;
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // --- lifecycle -----------------------------------------------------------

  async activate(context: vscode.ExtensionContext): Promise<void> {
    await this.reloadConfig();

    this.disposables.push(
      vscode.window.registerTreeDataProvider('gearvane.session', this.treeProvider),
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration('gearvane')) await this.reloadConfig();
      }),
      vscode.workspace.onDidSaveTextDocument(async () => {
        // A saved config file may change routing, so reload rather than
        // continuing to use a stale model list.
        if (this.configPath && isYamlOrJson(this.configPath)) await this.reloadConfig();
      }),
    );

    for (const command of [
      'gearvane.routeSelection',
      'gearvane.explainSelection',
      'gearvane.ask',
      'gearvane.agent',
      'gearvane.health',
      'gearvane.spend',
      'gearvane.showLog',
      'gearvane.pinModel',
      'gearvane.clearPin',
    ]) {
      this.disposables.push(
        vscode.commands.registerCommand(command, () => this.run(command)),
      );
    }

    context.subscriptions.push(...this.disposables);
    this.logLine('GearVane extension activated');
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Disposal must not throw during shutdown.
      }
    }
  }

  private async run(command: string): Promise<void> {
    try {
      switch (command) {
        case 'gearvane.routeSelection':
          await this.routeSelection();
          break;
        case 'gearvane.explainSelection':
          await this.explainSelection();
          break;
        case 'gearvane.ask':
          await this.ask();
          break;
        case 'gearvane.agent':
          this.agent().reveal();
          break;
        case 'gearvane.health':
          await this.checkHealth();
          break;
        case 'gearvane.spend':
          this.showSpend();
          break;
        case 'gearvane.showLog':
          this.showLog();
          break;
        case 'gearvane.pinModel':
          await this.pinModel();
          break;
        case 'gearvane.clearPin':
          await this.clearPin();
          break;
        default:
          this.logLine(`Unhandled command: ${command}`);
      }
    } catch (error) {
      // A thrown command leaves a red notification and a log line, never an
      // unhandled rejection in the extension host.
      const message = error instanceof ConfigError ? error.message : String(error);
      this.logLine(`error: ${message}`);
      void vscode.window.showErrorMessage(`GearVane: ${message}`);
    }
  }

  // --- config --------------------------------------------------------------

  async reloadConfig(): Promise<void> {
    const settings = vscode.workspace.getConfiguration('gearvane');
    const explicit = settings.get<string>('configPath', '').trim();

    try {
      const { config, path: found } = explicit
        ? { config: await this.readConfigFile(explicit), path: explicit }
        : await this.discoverConfig();

      this.config = applyOverrides(config, {
        tier: settings.get<string>('tier', 'auto'),
        model: settings.get<string>('model', '').trim(),
      });

      this.configPath = found;
      this.orchestrator = new Orchestrator(this.config, {
        env: process.env as Record<string, string | undefined>,
      });

      this.logLine(
        found ? `Loaded config from ${found}` : 'Using built-in default config',
      );
      this.publish();
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error);
      this.logLine(`config error: ${message}`);
      void vscode.window.showErrorMessage(`GearVane config: ${message}`);
      this.config = defaultConfig();
      this.orchestrator = undefined;
    }
  }

  /**
   * Read and parse a config file.
   *
   * vscode.workspace.fs is async only, so this is too. Reading synchronously
   * would block the extension host on every config reload.
   */
  private async readConfigFile(path: string): Promise<GearVaneConfig> {
    const uri = vscode.Uri.file(path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    if (text.trim() === '') return defaultConfig();
    return parseConfig(text, path.endsWith('.json') ? 'json' : 'yaml');
  }

  /** Search the workspace folders for a config. */
  private async discoverConfig(): Promise<{ config: GearVaneConfig; path?: string }> {
    const names = [
      'gearvane.config.json',
      'gearvane.config.yaml',
      'gearvane.yaml',
      'config.yaml',
    ];

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      for (const name of names) {
        const candidate = vscode.Uri.joinPath(folder.uri, name);
        if (await uriExists(candidate)) {
          return {
            config: await this.readConfigFile(candidate.fsPath),
            path: candidate.fsPath,
          };
        }
      }
    }

    return { config: defaultConfig() };
  }

  // --- commands ------------------------------------------------------------

  private async routeSelection(): Promise<void> {
    const selection = await this.currentSelection();
    if (!selection) return;

    const decision = this.decisionFor(selection.text, selection.files);
    const detail = decision.reasons.map((reason) => `  - ${reason}`).join('\n');

    void vscode.window.showInformationMessage(
      `GearVane: ${decision.tier} / ${decision.provider.name}/${decision.model} ` +
        `(${Math.round(decision.confidence * 100)}%)\n${detail}`,
      { modal: false },
    );

    this.logDecision({
      at: Date.now(),
      taskId: 'selection',
      tier: decision.tier,
      model: decision.model,
      confidence: decision.confidence,
      escalated: decision.escalated,
      costUsd: 0,
      reasons: decision.reasons,
    });
    this.publish();
  }

  private async explainSelection(): Promise<void> {
    const selection = await this.currentSelection();
    if (!selection) return;

    const decision = this.decisionFor(selection.text, selection.files);
    const lines = [
      `# GearVane routing decision`,
      ``,
      `**Tier:** ${decision.tier}`,
      `**Model:** ${decision.provider.name}/${decision.model}`,
      `**Confidence:** ${Math.round(decision.confidence * 100)}%`,
      ``,
      `## Why`,
      ...decision.reasons.map((reason) => `- ${reason}`),
      ``,
      `## Files considered`,
      ...(selection.files.length > 0
        ? selection.files.map((file) => `- \`${file}\``)
        : ['- none']),
      ``,
      `## Configuration`,
      `- Source: ${this.configPath ?? 'built-in defaults'}`,
      `- Per-task budget: $`,
    ];

    const document = await vscode.workspace.openTextDocument({
      content: lines.join('\n'),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document);
  }

  private async ask(): Promise<void> {
    const question = await vscode.window.showInputBox({
      prompt: 'Ask (GearVane picks the model)',
      placeHolder: 'e.g. explain what this function does',
    });
    if (!question) return;

    const files = this.activeFilePaths();
    const orchestrator = this.requireOrchestrator();

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GearVane' },
      async (progress) => {
        progress.report({ message: 'routing' });
        const result: ExecutionResult = await orchestrator.execute(
          `vscode-${Date.now().toString(36)}`,
          question,
          {
            filesTouched: files,
            maxTokens: this.maxTokens(),
          },
        );

        progress.report({ message: result.tier ?? '' });
        this.recordResult(result);
        this.publish();

        if (result.success) {
          const document = await vscode.workspace.openTextDocument({
            content: result.content,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(document, { preview: true });
        } else {
          void vscode.window.showErrorMessage(
            `GearVane failed after ${result.attempts} attempts: ${result.error ?? 'unknown error'}`,
          );
        }
      },
    );
  }

  private async checkHealth(): Promise<void> {
    const checker = new HealthChecker(this.config, undefined, { timeoutMs: 5000 });
    const results = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GearVane health' },
      () => checker.checkAll(),
    );

    const summary = summariseHealth(results);
    void vscode.window.showInformationMessage(`GearVane: ${summary}`);
    this.logLine(`health: ${summary}`);
  }

  private showSpend(): void {
    const status = this.requireOrchestrator().spend.getStatus();
    this.output.show(true);
    this.logLine(
      `spend  session $${status.sessionSpend.toFixed(4)} ` +
        `task $${status.taskSpend.toFixed(4)}`,
    );
    void vscode.window.showInformationMessage(
      `GearVane session spend $${status.sessionSpend.toFixed(2)}`,
    );
  }

  private showLog(): void {
    this.output.show(true);
    if (this.log.length === 0) {
      this.logLine('No routing decisions recorded in this session yet.');
      return;
    }
    for (const entry of this.log) {
      this.output.appendLine(
        `[${new Date(entry.at).toISOString()}] ${entry.tier} ${entry.model} ` +
          `${Math.round(entry.confidence * 100)}%` +
          (entry.success === undefined ? '' : entry.success ? ' ok' : ' failed') +
          (entry.durationMs ? ` ${formatDuration(entry.durationMs)}` : ''),
      );
    }
  }

  private async pinModel(): Promise<void> {
    const decision = this.decisionFor('list the available models', []);
    const suggestion = `${decision.provider.name}/${decision.model}`;

    const model = await vscode.window.showInputBox({
      prompt: 'Pin this model for the workspace',
      value: suggestion,
      placeHolder: 'anthropic/claude-sonnet-4-20250514',
    });
    if (!model) return;

    await vscode.workspace
      .getConfiguration('gearvane')
      .update('model', model, vscode.ConfigurationTarget.Workspace);
    await this.reloadConfig();
    void vscode.window.showInformationMessage(`GearVane pinned to ${model}`);
  }

  private async clearPin(): Promise<void> {
    await vscode.workspace
      .getConfiguration('gearvane')
      .update('model', undefined, vscode.ConfigurationTarget.Workspace);
    await this.reloadConfig();
    void vscode.window.showInformationMessage('GearVane: pinned model cleared');
  }

  // --- helpers -------------------------------------------------------------

  private maxTokens(): number {
    return vscode.workspace.getConfiguration('gearvane').get<number>('maxTokens', 2048);
  }

  private requireOrchestrator(): Orchestrator {
    if (!this.orchestrator) {
      throw new ConfigError('No usable model tiers configured. Check gearvane.configPath.');
    }
    return this.orchestrator;
  }

  private activeFilePaths(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders[0];
    if (!folder) return [];
    const relative = vscode.workspace.asRelativePath(folder.uri);
    return relative ? [relative] : [];
  }

  private async currentSelection(): Promise<{ text: string; files: string[] } | undefined> {
    const editor = vscode.window.activeTextEditor;
    const includeSelection = vscode.workspace
      .getConfiguration('gearvane')
      .get<boolean>('includeSelectionInPrompt', true);

    if (editor && includeSelection) {
      const text = editor.document.getText(editor.selection).trim();
      if (text.length > 0) {
        const file = vscode.workspace.asRelativePath(editor.document.uri);
        return { text, files: file ? [file] : [] };
      }
    }

    const fallback = await vscode.window.showInputBox({
      prompt: 'Describe the task',
      placeHolder: 'e.g. fix the failing test in auth.test.ts',
    });
    if (!fallback) return undefined;

    return { text: fallback, files: this.activeFilePaths() };
  }

  private decisionFor(description: string, files: string[]): RoutingDecision {
    return this.requireOrchestrator().router.route(`preview-${files.length}`, {
      description,
      filesTouched: files,
      errorLoops: 0,
      testFailures: 0,
    });
  }

  private recordResult(result: ExecutionResult): void {
    this.logDecision({
      at: Date.now(),
      taskId: result.taskId,
      tier: result.tier ?? 'unknown',
      model: result.model ?? 'unknown',
      confidence: result.confidence,
      escalated: result.escalated,
      success: result.success,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      reasons: result.reasons,
    });
  }

  private logDecision(entry: LogEntry): void {
    this.log.push(entry);
    if (this.log.length > MAX_LOG_ENTRIES) this.log.shift();

    this.output.appendLine(
      `route ${entry.tier} ${entry.model} ${Math.round(entry.confidence * 100)}%` +
        (entry.success === undefined ? '' : entry.success ? ' ok' : ' failed'),
    );
  }

  private logLine(message: string): void {
    this.output.appendLine(message);
  }

  private publish(): void {
    const routing = this.log
      .slice(-5)
      .reverse()
      .map<SessionEntry>((entry) => ({
        label: `${entry.tier} · ${entry.model}`,
        description: `${Math.round(entry.confidence * 100)}%${
          entry.success === false ? ' failed' : ''
        }`,
        icon: tierIcon(entry.tier),
      }));

    const status = this.orchestrator?.spend.getStatus();

    const spend: SessionEntry[] = status
      ? [
          {
            label: `Session  ${formatUsd(status.sessionSpend)}`,
            icon: 'account',
          },
          {
            label: `Task  ${formatUsd(status.taskSpend)}`,
            icon: 'account',
          },
        ]
      : [{ label: 'No configuration loaded', icon: healthIcon('unknown'), description: '' }];

    this.state = { routing, spend, health: this.state.health };
    this.onStateChanged.fire(this.state);
  }

  setHealth(results: HealthResult[]): void {
    this.state = {
      ...this.state,
      health: results.map<SessionEntry>((result) => ({
        label: `${result.provider}/${result.model}`,
        description: result.status,
        icon: healthIcon(result.status),
      })),
    };
    this.onStateChanged.fire(this.state);
  }

  getState(): SessionState {
    return this.state;
  }

  getTreeProvider(): vscode.TreeDataProvider<SessionNode> {
    return this.treeProvider;
  }

  /** Exposed for tests: gate a command the way the deployment tools do. */
  gate(command: string): ReturnType<SafetyManager['check']> {
    return new SafetyManager(this.config.safety).check(command);
  }
}

function summariseHealth(results: HealthResult[]): string {
  const counts = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0 };
  for (const result of results) counts[result.status] += 1;

  if (results.length === 0) return 'no models configured';
  return (
    `${counts.healthy} healthy, ${counts.degraded} degraded, ` +
    `${counts.unhealthy} unhealthy, ${counts.unknown} unknown`
  );
}

function applyOverrides(
  config: GearVaneConfig,
  overrides: { tier: string; model: string },
): GearVaneConfig {
  const next: GearVaneConfig = {
    ...config,
    router: { ...config.router },
  };

  if (overrides.model) {
    next.router.manualOverride = overrides.model;
  }

  if (overrides.tier && overrides.tier !== 'auto') {
    // Pinning a tier is expressed as a manual override of that tier's first
    // model, so the override resolver validates it and warns when it does not
    // match anything configured.
    const tier = next.tiers[overrides.tier as keyof GearVaneConfig['tiers']];
    const provider = tier?.providers[0];
    const model = provider?.models[0];

    if (provider && model) {
      next.router.manualOverride = `${provider.name}/${model}`;
    } else {
      void vscode.window.showWarningMessage(
          `GearVane: tier "${overrides.tier}" has no configured provider; ` +
            'falling back to automatic routing.',
        );
    }
  }

  return next;
}

function isYamlOrJson(path: string): boolean {
  return /\.(ya?ml|json)$/i.test(path);
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// --- tree view --------------------------------------------------------------

export class SessionNode {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly icon: string,
    readonly section?: string,
  ) {}
}

class SessionTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  constructor(private readonly extension: GearVaneExtension) {}

  getTreeItem(node: SessionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.tooltip = `${node.section ?? ''} ${node.label}`.trim();
    return item;
  }

  getChildren(node?: SessionNode): SessionNode[] {
    if (node) return [];

    const state = this.extension.getState();
    const nodes: SessionNode[] = [];

    for (const entry of state.routing) {
      nodes.push(
        new SessionNode(entry.label, entry.description ?? '', entry.icon ?? 'question', 'route'),
      );
    }
    for (const entry of state.spend) {
      nodes.push(
        new SessionNode(entry.label, entry.description ?? '', entry.icon ?? 'account', 'spend'),
      );
    }
    for (const entry of state.health) {
      nodes.push(
        new SessionNode(entry.label, entry.description ?? '', entry.icon ?? 'question', 'health'),
      );
    }

    return nodes;
  }
}

export function activate(context: vscode.ExtensionContext): GearVaneExtension {
  const extension = new GearVaneExtension(context.extensionUri);
  void extension.activate(context);
  return extension;
}

export function deactivate(): void {
  // Disposal is handled by context.subscriptions.
}