import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards on the agent panel.
 *
 * The panel is a webview, so it cannot be exercised without VS Code. What can
 * be checked is the source: that it renders through textContent rather than
 * innerHTML, that it confines writes to the workspace, and that it never
 * claims to be a sandbox.
 *
 * The last one matters most. A panel that says "sandboxed" while offering a
 * gated shell would mislead exactly the person most likely to be harmed.
 */

// Three levels up: test/ -> extension root -> apps/ -> repository root.
// Two was the first attempt and produced apps/apps/vscode-extension/..., which
// failed with a doubled path rather than a missing file.
const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const panel = read(REPO, 'apps', 'vscode-extension', 'src', 'agent-panel.ts');
const manifest = JSON.parse(
  read(REPO, 'apps', 'vscode-extension', 'package.json'),
) as {
  contributes: { commands: Array<{ command: string; title: string }> };
  dependencies: Record<string, string>;
  keybindings?: Array<{ command: string; key: string }>;
};

describe('the agent panel exists and is wired up', () => {
  it('is registered as a command', () => {
    expect(
      manifest.contributes.commands.some((c) => c.command === 'waypoint.agent'),
    ).toBe(true);
  });

  it('has a keybinding', () => {
    // A command nobody can reach is not a feature.
    expect(manifest.keybindings?.some((k) => k.command === 'waypoint.agent')).toBe(true);
  });

  it('depends on the harness', () => {
    expect(manifest.dependencies['@waypoint/harness']).toBeTruthy();
  });

  it('is reachable from the extension entry point', () => {
    const entry = read(REPO, 'apps', 'vscode-extension', 'src', 'extension.ts');
    expect(entry).toContain('waypoint.agent');
    expect(entry).toContain('AgentPanel');
  });
});

describe('the panel renders safely', () => {
  /**
   * Tool names, file paths, and model output all reach the DOM. A panel that
   * built markup by concatenation would turn a file name into an element.
   */
  it('uses textContent for model and tool output', () => {
    expect(panel).toMatch(/node\.textContent = text/);
  });

  it('never assigns innerHTML', () => {
    expect(panel).not.toMatch(/\.innerHTML\s*=/);
  });

  it('renders into the DOM rather than building markup', () => {
    // The panel has no preview iframe; it renders steps directly. The safety
    // property is that nothing goes through innerHTML, so a tool name or file
    // path cannot become an element.
    expect(panel).toMatch(/document\.createElement/);
    expect(panel).toMatch(/log\.append/);
  });
});

describe('the panel confines writes to the workspace', () => {
  it('constructs a Workspace for the run', () => {
    expect(panel).toMatch(/new Workspace\(root\)/);
  });

  it('refuses to run without a workspace', () => {
    // An agent with no root has nothing to confine it to, and running anyway
    // would write wherever the process happened to be.
    expect(panel).toMatch(/workspaceRoot\(\)/);
    expect(panel).toMatch(/Open a folder first/);
  });

  it('passes the workspace to the agent context', () => {
    expect(panel).toMatch(/context:\s*\{\s*workspace/);
  });

  it('offers the scaffold tools so prompts can start projects', () => {
    // Without these a "build me a site" prompt has file tools but no way to
    // begin, and the run wanders.
    expect(panel).toMatch(/builderTools\(\)/);
  });

  it('installs the real filesystem for scaffold writes', () => {
    // The extension host is Node, but the scaffold tools write through an
    // injected bridge that starts out empty. Without this every write fails.
    expect(panel).toMatch(/installNodeFileSystem\(\)/);
  });
});

describe('the panel is honest about containment', () => {
  it('says there is no sandbox', () => {
    // The single most important sentence in the panel.
    expect(panel).toMatch(/there is no sandbox/i);
  });

  it('explains that gating is not containment', () => {
    expect(panel).toMatch(/gated, not sandboxed|gated, not contained/i);
  });

  it('warns before enabling shell access', () => {
    // A checkbox that silently enabled command execution would be the worst
    // possible default.
    expect(panel).toMatch(/showWarningMessage/);
  });

  it('asks for approval per command', () => {
    expect(panel).toMatch(/approve:\s*async/);
  });
});

describe('the panel does not leak state', () => {
  it('cancels the run when the panel closes', () => {
    // A run that outlives its panel has no visible output and looks like the
    // agent hung.
    expect(panel).toMatch(/onDidDispose/);
    expect(panel).toMatch(/controller\?\.abort\(\)/);
  });

  it('restricts local resource roots to the extension', () => {
    // Without this a webview message could make the host load arbitrary files.
    expect(panel).toMatch(/localResourceRoots/);
  });

  it('uses a nonce for inline scripts', () => {
    expect(panel).toMatch(/makeNonce/);
    expect(panel).toMatch(/script-src/);
  });
});

describe('the panel handles failure', () => {
  it('reports a missing provider rather than hanging', () => {
    expect(panel).toMatch(/No usable provider/);
  });

  it('survives a thrown error from the loop', () => {
    // A thrown command leaves a red notification and a log line, never an
    // unhandled rejection in the extension host.
    expect(panel).toMatch(/catch \(error\)/);
    expect(panel).toMatch(/state\.error/);
  });

  it('disables send while running', () => {
    // Two concurrent runs would interleave tool calls and produce a transcript
    // nobody can read.
    expect(panel).toMatch(/send\.disabled = state\.running/);
  });
});