import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  VIBE_SYSTEM_PROMPT,
  resolveIdeModel,
  runIdeAgent,
} from '../src/ide-agent-host.js';

/**
 * IDE agent tests.
 *
 * The loop itself runs in the main process, which vitest cannot host, so the
 * strategy is split: the pure pieces (validation, model resolution, the
 * system prompt) are executed, and the IPC wiring is guarded at the source
 * level. A guard that only checks text is weaker than execution, and each one
 * below says what it would take to make it stronger.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const host = read(REPO, 'apps', 'desktop', 'src', 'ide-agent-host.ts');
const view = read(REPO, 'apps', 'desktop', 'src', 'ide', 'ide-view.ts');
const preload = read(REPO, 'apps', 'desktop', 'src', 'preload.cjs');
const main = read(REPO, 'apps', 'desktop', 'src', 'main.ts');
const renderer = read(REPO, 'apps', 'desktop', 'src', 'renderer.ts');

const noop = (): void => {};

describe('the system prompt', () => {
  it('names the scaffold tools in order', () => {
    expect(VIBE_SYSTEM_PROMPT).toMatch(/list_templates/);
    expect(VIBE_SYSTEM_PROMPT).toMatch(/scaffold_project/);
    expect(VIBE_SYSTEM_PROMPT.indexOf('list_templates')).toBeLessThan(
      VIBE_SYSTEM_PROMPT.indexOf('scaffold_project'),
    );
  });

  it('tells the model there is no shell', () => {
    // Without this the model will ask for a tool that does not exist, burning
    // iterations on failed calls before giving up.
    expect(VIBE_SYSTEM_PROMPT).toMatch(/no shell/i);
  });

  it('is short enough to send on every iteration', () => {
    expect(VIBE_SYSTEM_PROMPT.length).toBeLessThan(500);
  });
});

describe('runIdeAgent validation', () => {
  const config = {
    tiers: {},
    providers: { timeoutSeconds: 60 },
  } as never;

  it('rejects an empty prompt without touching a model', async () => {
    const response = await runIdeAgent(
      { prompt: '   ', root: '/tmp' },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/prompt/);
  });

  it('rejects a missing root without touching a model', async () => {
    const response = await runIdeAgent(
      { prompt: 'build something', root: '' },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/root/);
  });

  it('rejects a root that does not exist', async () => {
    const response = await runIdeAgent(
      { prompt: 'build something', root: '/definitely/not/a/real/dir-xyz' },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/does not exist/);
  });

  it('caps maxIterations', async () => {
    // A renderer passing maxIterations: 1e9 must not produce an unbounded run.
    // This fails before any model call, so the cap is observable here.
    const response = await runIdeAgent(
      { prompt: 'x', root: '/definitely/not/a/real/dir-xyz', maxIterations: 1e9 },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    // Still fails on the missing root first; the cap matters once the root is
    // real, and its presence is asserted structurally below.
    expect(response.ok).toBe(false);
    expect(host).toMatch(/Math\.min\(Math\.floor\(request\.maxIterations\), 50\)/);
  });
});

describe('resolveIdeModel', () => {
  it('reports when nothing is configured', () => {
    const resolved = resolveIdeModel({}, {});
    expect(resolved.client).toBeUndefined();
    expect(resolved.reason).toMatch(/no usable provider/);
  });

  it('skips a provider with no base URL', () => {
    const resolved = resolveIdeModel(
      {},
      { local: { providers: [{ name: 'made-up-provider', models: ['m'] }] } },
    );
    expect(resolved.client).toBeUndefined();
  });

  it('returns a client without contacting the network', () => {
    // create() must not connect; the health check happens on first use.
    const resolved = resolveIdeModel(
      {},
      { local: { providers: [{ name: 'ollama', models: ['qwen'] }] } },
    );
    expect(resolved.client).toBeDefined();
    expect(resolved.provider).toBe('ollama');
  });
});

describe('the main process wires the handler', () => {
  it('registers the run and cancel channels', () => {
    expect(host).toMatch(/ipcMain\.handle\('agent:run'/);
    expect(host).toMatch(/ipcMain\.on\('agent:cancel'/);
  });

  it('rejects a second run while one is active', () => {
    // Two interleaved runs would produce a transcript nobody can read.
    expect(host).toMatch(/already in progress/);
  });

  it('guards step events against a destroyed sender', () => {
    expect(host).toMatch(/isDestroyed\(\)/);
  });

  it('is registered from main', () => {
    expect(main).toMatch(/registerIdeAgentHandlers/);
  });
});

describe('the preload bridge exposes the agent', () => {
  it('forwards run, cancel, and step events', () => {
    expect(preload).toMatch(/agent:\s*\{/);
    expect(preload).toMatch(/ipcRenderer\.invoke\('agent:run'/);
    expect(preload).toMatch(/ipcRenderer\.send\('agent:cancel'/);
    expect(preload).toMatch(/ipcRenderer\.on\('agent:step'/);
  });

  it('returns an unsubscribe function for step events', () => {
    // Otherwise every mount leaks a listener into the next one.
    expect(preload).toMatch(/removeListener\('agent:step'/);
  });
});

describe('the IDE view runs prompts', () => {
  it('has a prompt box with an accessible label', () => {
    expect(view).toMatch(/ide-agent-input/);
    expect(view).toMatch(/aria-label/);
  });

  it('has Build and Stop controls', () => {
    expect(view).toMatch(/ide-agent-button/);
    expect(view).toMatch(/ide-agent-stop/);
  });

  it('disables Build while running', () => {
    expect(view).toMatch(/agentBuildButton\) this\.agentBuildButton\.disabled = running/);
  });

  it('renders steps as text, never markup', () => {
    // Tool names and model output come from outside the page.
    expect(view).toMatch(/agentLogLine/);
    expect(view).not.toMatch(/agentLog.*innerHTML/);
  });

  it('refreshes the tree and reveals touched files when done', () => {
    expect(view).toMatch(/await this\.refreshTree\(\)/);
    expect(view).toMatch(/touchedFiles\(result\.steps\)/);
    expect(view).toMatch(/await this\.openFile\(last\)/);
  });

  it('says there is no shell in the prompt pane', () => {
    expect(view).toMatch(/No shell access/);
  });

  it('cancels the run when the view is disposed', () => {
    expect(view).toMatch(/if \(this\.agentRunning\) this\.options\.agent\.cancel\(\)/);
  });
});

describe('the renderer gates the IDE on all three bridges', () => {
  it('hides the toggle unless everything exists', () => {
    // A single ideCapable flag computed from all three bridges, used for both
    // the toggle and the mount. Splitting the two was how the toggle and the
    // mount disagreed in an earlier version.
    expect(renderer).toMatch(/bridge\.terminal && bridge\.ideFs && bridge\.agent/);
    expect(renderer).toMatch(/if \(!ideCapable && ideToggle/);
  });

  it('passes the agent bridge into the view', () => {
    expect(renderer).toMatch(/agent:\s*\{/);
  });

  it('opens the IDE full-window instead of a dialog', () => {
    // The IDE used to live in a <dialog>; it is the app now, so the dialog
    // must be gone and the mount must target the window root.
    const html = read(REPO, 'apps', 'desktop', 'renderer', 'index.html');
    expect(html).not.toMatch(/ide-dialog/);
    expect(html).toMatch(/id="ide-root"/);
    expect(renderer).toMatch(/getElementById\('ide-root'\)/);
  });

  it('shows chat when the bridges are absent', () => {
    // The same bundle runs in the Android webview, which has no bridges at
    // all. Gating the IDE must leave the chat visible there, not a blank
    // window with a hidden everything.
    expect(renderer).toMatch(/ideCapable/);
    expect(renderer).toMatch(/removeAttribute\('hidden'\)/);
  });

  it('remembers the workspace between launches', () => {
    expect(renderer).toMatch(/waypoint\.ide\.root/);
    expect(renderer).toMatch(/rememberWorkspaceRoot/);
  });

  it('reloads rather than reusing models when switching folders', () => {
    // Models from the old workspace must not survive the switch.
    expect(renderer).toMatch(/waypoint\.ide\.pendingRoot/);
    expect(renderer).toMatch(/window\.location\.reload\(\)/);
  });
});

describe('the editor has working tabs', () => {
  it('renders a tab bar with roles for assistive tech', () => {
    expect(view).toMatch(/ide-tabbar/);
    expect(view).toMatch(/role.*tablist/);
    expect(view).toMatch(/aria-selected/);
  });

  it('tracks dirtiness against the saved content, not keystrokes', () => {
    // An edit that is undone returns the file to clean without a save.
    expect(view).toMatch(/onDidChangeContent/);
    expect(view).toMatch(/model\.getValue\(\) !== file\.savedValue/);
  });

  it('clears the dirty flag on save', () => {
    expect(view).toMatch(/file\.savedValue = value/);
    expect(view).toMatch(/file\.dirty = false/);
  });

  it('asks before discarding a dirty tab', () => {
    // A blocking confirm is the ugliest honest option: silently dropping
    // edits would be worse, and autosaving writes unasked-for files.
    expect(view).toMatch(/window\.confirm\(/);
    expect(view).toMatch(/Discard unsaved changes/);
  });

  it('stops the close click from switching to the closing tab', () => {
    expect(view).toMatch(/event\.stopPropagation\(\)/);
  });

  it('falls back to another tab when the active one closes', () => {
    expect(view).toMatch(/remaining\[remaining\.length - 1\]/);
  });
});

describe('the hidden attribute actually hides', () => {
  it('overrides the flex display on both views', () => {
    // .app sets display:flex, which beats [hidden]. Without this rule the IDE
    // and the chat render on top of each other and both accept input.
    const css = read(REPO, 'apps', 'desktop', 'renderer', 'styles.css');
    expect(css).toMatch(/\.app\[hidden\]/);
    expect(css).toMatch(/#ide-root\[hidden\]/);
  });
});
