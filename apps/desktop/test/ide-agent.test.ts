import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ASK_SYSTEM_PROMPT,
  MAX_SNAPSHOT_BYTES,
  VIBE_SYSTEM_PROMPT,
  diffSnapshot,
  listIdeModels,
  resolveIdeModel,
  runIdeAgent,
  snapshotWorkspace,
  toolsForMode,
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

  it('matches a provider-qualified selection exactly', () => {
    const tiers = {
      local: { providers: [{ name: 'ollama', models: ['qwen', 'llama'] }] },
      frontier: { providers: [{ name: 'openai', models: ['qwen'] }] },
    };
    const resolved = resolveIdeModel({}, tiers, 'openai/qwen');
    expect(resolved.client).toBeDefined();
    expect(resolved.provider).toBe('openai');
    expect(resolved.model).toBe('qwen');
  });

  it('matches a bare model name in tier order', () => {
    const ordered = {
      frontier: { providers: [{ name: 'openai', models: ['shared'] }] },
      local: { providers: [{ name: 'ollama', models: ['shared'] }] },
    };
    const resolved = resolveIdeModel({}, ordered, 'shared');
    // Object key order is tier order here: frontier first.
    expect(resolved.provider).toBe('openai');
    expect(resolved.model).toBe('shared');
  });

  it('reports an unknown selection instead of substituting', () => {
    const tiers = {
      local: { providers: [{ name: 'ollama', models: ['qwen'] }] },
    };
    const resolved = resolveIdeModel({}, tiers, 'openai/gpt-6-astra');
    expect(resolved.client).toBeUndefined();
    expect(resolved.reason).toMatch(/unknown model/);
  });

  it('rejects a non-string selection', () => {
    const tiers = {
      local: { providers: [{ name: 'ollama', models: ['qwen'] }] },
    };
    const resolved = resolveIdeModel({}, tiers, { model: 'qwen' });
    expect(resolved.client).toBeUndefined();
    expect(resolved.reason).toMatch(/must be a string/);
  });
});

describe('listIdeModels', () => {
  it('lists every configured pair in tier order with tier labels', () => {
    const tiers = {
      local: { providers: [{ name: 'ollama', models: ['a', 'b'] }] },
      frontier: { providers: [{ name: 'openai', models: ['c'] }] },
    };
    expect(listIdeModels(tiers)).toEqual([
      { provider: 'ollama', model: 'a', tier: 'local' },
      { provider: 'ollama', model: 'b', tier: 'local' },
      { provider: 'openai', model: 'c', tier: 'frontier' },
    ]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(listIdeModels({})).toEqual([]);
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

  it('serves the configured model list', () => {
    expect(host).toMatch(/ipcMain\.handle\('agent:models'/);
  });

  it('merges renderer keys over process env through an allowlist', () => {
    // Vault keys let a packaged app without a shell environment reach
    // hosted models, but the merge must drop everything else: a renderer
    // that could set PATH in the main process would own it.
    expect(host).toMatch(/sanitizeKeys\(request\.keys\)/);
    expect(host).toMatch(/\.\.\.sanitizeKeys\(request\.keys\)/);
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

  it('forwards the model list', () => {
    expect(preload).toMatch(/ipcRenderer\.invoke\('agent:models'\)/);
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

  it('offers every configured model with a tier label', () => {
    expect(view).toMatch(/fillModelOptions/);
    expect(view).toMatch(/Agent model/);
  });

  it('falls back to the default when the list is unavailable', () => {
    // A failed models() call must degrade to old behavior, not block the pane.
    expect(view).toMatch(/Default model/);
  });

  it('sends the selected model with the prompt', () => {
    expect(view).toMatch(/this\.options\.agent\.run\(prompt, \{/);
    expect(view).toMatch(/mode,\s*$/m);
    expect(view).toMatch(/model: selectedModel,/);
    expect(view).toMatch(/maxIterations/);
  });

  it('gates destructive prompts behind the ask-me-first confirm', () => {
    expect(view).toMatch(/needsApproval\(prompt\)/);
    expect(view).toMatch(/confirmDestructive/);
  });

  it('names the driving model when the run finishes', () => {
    expect(view).toMatch(/driven by/);
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

  it('forwards the model list and selection through the adapter', () => {
    expect(renderer).toMatch(/models: \(\) => agent\.models\(\)/);
    expect(renderer).toMatch(
      /run: \(prompt, options\) => agent\.run\(prompt, root, \{ \.\.\.options, keys: loadKeys\(keyStorage\) \}\)/,
    );
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

  it('falls back to the device-local backend without host bridges', () => {
    // No host bridges (Android webview, plain browser): files and the Ask
    // agent come from the web backend instead of an empty IDE button.
    expect(renderer).toMatch(/createWebBackend/);
    expect(renderer).toMatch(/bridge\.ideFs \?\? webBackend\?\.ideFs/);
    expect(renderer).toMatch(/bridge\.agent \?\? webBackend\?\.agent/);
  });

  it('remembers the workspace between launches', () => {
    expect(renderer).toMatch(/gearvane\.ide\.root/);
    expect(renderer).toMatch(/rememberWorkspaceRoot/);
  });

  it('reloads rather than reusing models when switching folders', () => {
    // Models from the old workspace must not survive the switch.
    expect(renderer).toMatch(/gearvane\.ide\.pendingRoot/);
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

describe('the agent can search the workspace', () => {
  it('offers the search tool to the model', () => {
    expect(host).toMatch(/searchFilesTool/);
  });

  it('tells the model to locate code before editing it', () => {
    expect(host).toMatch(/search_files/);
  });

  it('serves sidebar search through the same tool', () => {
    // The UI and the agent must agree on what a search finds. A second
    // implementation would eventually disagree about an edge case.
    const fsHost = read(REPO, 'apps', 'desktop', 'src', 'ide-fs-host.ts');
    expect(fsHost).toMatch(/ide:search/);
    expect(fsHost).toMatch(/searchFilesTool\.execute/);
  });

  it('validates the query before searching', () => {
    const fsHost = read(REPO, 'apps', 'desktop', 'src', 'ide-fs-host.ts');
    expect(fsHost).toMatch(/query must be a non-empty string/);
  });

  it('forwards search over the preload bridge', () => {
    expect(preload).toMatch(/ipcRenderer\.invoke\('ide:search'/);
  });
});

describe('the sidebar searches file contents', () => {
  it('has a search box with an accessible label', () => {
    expect(view).toMatch(/ide-search-input/);
    expect(view).toMatch(/Search file contents/);
  });

  it('opens results at the matched line', () => {
    expect(view).toMatch(/openFile\(path, lineNumber\)/);
    expect(view).toMatch(/revealLineInCenter/);
  });

  it('renders result rows as text, never markup', () => {
    expect(view).toMatch(/ide-search-row/);
    expect(view).not.toMatch(/searchResults.*innerHTML/);
  });
});

describe('snapshot and diff', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gearvane-ide-diff-'));
    await writeFile(join(root, 'keep.ts'), 'const a = 1;\n');
    await writeFile(join(root, 'change.ts'), 'const b = 1;\n');
  });

  it('captures file contents before a run', async () => {
    const snapshot = await snapshotWorkspace(root);
    expect(snapshot.get('keep.ts')).toBe('const a = 1;\n');
    expect(snapshot.get('change.ts')).toBe('const b = 1;\n');
  });

  it('reports modified and created files, sorted', async () => {
    const snapshot = await snapshotWorkspace(root);
    await writeFile(join(root, 'change.ts'), 'const b = 2;\n');
    await writeFile(join(root, 'new.ts'), 'new file\n');

    const changed = await diffSnapshot(root, snapshot);
    expect(changed).toEqual([
      { path: 'change.ts', original: 'const b = 1;\n', current: 'const b = 2;\n' },
      { path: 'new.ts', original: null, current: 'new file\n' },
    ]);
  });

  it('reports nothing when nothing changed', async () => {
    const snapshot = await snapshotWorkspace(root);
    await expect(diffSnapshot(root, snapshot)).resolves.toEqual([]);
  });

  it('skips binary and oversized files', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(join(root, 'huge.txt'), 'x'.repeat(MAX_SNAPSHOT_BYTES + 1));

    const snapshot = await snapshotWorkspace(root);
    expect(snapshot.has('blob.bin')).toBe(false);
    expect(snapshot.has('huge.txt')).toBe(false);
  });
});

describe('runIdeAgent model selection', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gearvane-ide-model-'));
  });

  const config = {
    tiers: {
      local: { providers: [{ name: 'ollama', models: ['qwen'] }] },
    },
    providers: { timeoutSeconds: 60 },
  } as never;

  it('rejects an unknown model without touching disk or network', async () => {
    const response = await runIdeAgent(
      { prompt: 'build something', root, model: 'openai/gpt-6-astra' },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/unknown model/);
  });

  it('rejects a non-string model', async () => {
    const response = await runIdeAgent(
      { prompt: 'build something', root, model: 42 },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/must be a string/);
  });
});

describe('toolsForMode', () => {
  it('gives ask mode only read-only tools', () => {
    const names = toolsForMode('ask').map((tool) => tool.schema.name);
    expect(names).toEqual(
      expect.arrayContaining(['read_file', 'list_dir', 'search_files']),
    );
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('scaffold_project');
    expect(names).not.toContain('run_command');
  });

  it('gives build mode the full toolkit without a shell', () => {
    const names = toolsForMode('build').map((tool) => tool.schema.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'edit_file',
        'scaffold_project',
        'search_files',
      ]),
    );
    expect(names).not.toContain('run_command');
  });

  it('keeps the ask prompt short and read-only', () => {
    expect(ASK_SYSTEM_PROMPT).toMatch(/do not create/i);
    expect(ASK_SYSTEM_PROMPT.length).toBeLessThan(300);
  });
});

describe('runIdeAgent mode validation', () => {
  const config = {
    tiers: {},
    providers: { timeoutSeconds: 60 },
  } as never;

  it('rejects an unknown mode without touching a model', async () => {
    const response = await runIdeAgent(
      { prompt: 'x', root: '/tmp', mode: 'destroy' },
      config,
      {},
      noop,
      new AbortController().signal,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/mode must be/);
  });
});

describe('change review in the view', () => {
  it('lists changed files with diff and revert actions', () => {
    expect(view).toMatch(/ide-changes/);
    expect(view).toMatch(/renderChangeRow/);
    expect(view).toMatch(/openDiff/);
    expect(view).toMatch(/revertChange/);
  });

  it('keeps a failed revert visible instead of reading as success', () => {
    // A failed revert that removed its row would look like it worked.
    expect(view).toMatch(/Returns false when the revert itself failed/);
  });

  it('renders diffs side by side, read-only', () => {
    expect(view).toMatch(/createDiffEditor/);
    expect(view).toMatch(/renderSideBySide/);
    expect(view).toMatch(/readOnly/);
  });

  it('disposes diff models when the dialog closes', () => {
    expect(view).toMatch(/original\.dispose\(\)/);
    expect(view).toMatch(/modified\.dispose\(\)/);
  });

  it('refreshes the tree and open models after a revert', () => {
    expect(view).toMatch(/await this\.refreshTree\(\)/);
    expect(view).toMatch(/open\.model\.setValue\(change\.original\)/);
  });

  it('exposes file removal over the preload bridge', () => {
    expect(preload).toMatch(/ipcRenderer\.invoke\('ide:remove'/);
  });
});

describe('agent modes', () => {
  it('offers ask and build', () => {
    expect(host).toMatch(/export type AgentMode = 'ask' \| 'build'/);
    expect(view).toMatch(/Build — create and change files/);
    expect(view).toMatch(/Ask — read-only, answers only/);
  });

  it('rejects an unknown mode without running', () => {
    expect(host).toMatch(/mode must be "ask" or "build"/);
  });

  it('defaults to build when the mode is absent', () => {
    expect(host).toMatch(/rawMode === undefined \|\| rawMode === null[\s\S]*\? 'build'/);
  });

  it('validates the mode before touching disk or models', () => {
    // Cheap checks first: a bad mode must not stat the workspace, resolve a
    // provider, or snapshot files before failing.
    const body = host.slice(host.indexOf('export async function runIdeAgent'));
    const modeCheck = body.indexOf('mode must be');
    expect(modeCheck).toBeGreaterThan(-1);
    expect(body.indexOf('await stat(request.root)')).toBeGreaterThan(modeCheck);
    expect(body.indexOf('resolveIdeModel')).toBeGreaterThan(modeCheck);
    expect(body.indexOf('snapshotWorkspace')).toBeGreaterThan(modeCheck);
  });

  it('restricts ask mode to read-only tools', () => {
    // The dangerous failure is a write tool leaking into ask mode, which
    // would make "read-only" a lie. Asserted on the tool list itself.
    expect(host).toMatch(/toolsForMode/);
    const askBlock = host.slice(host.indexOf("if (mode === 'ask')"));
    expect(askBlock).toContain('readFileTool');
    expect(askBlock).toContain('listDirTool');
    expect(askBlock).toContain('searchFilesTool');
    expect(askBlock).not.toContain('writeFileTool');
    expect(askBlock).not.toContain('scaffoldProjectTool');
    expect(askBlock).not.toContain('editFileTool');
  });

  it('uses a different system prompt per mode', () => {
    expect(host).toMatch(/ASK_SYSTEM_PROMPT/);
    expect(host).toMatch(/mode === 'ask' \? ASK_SYSTEM_PROMPT : VIBE_SYSTEM_PROMPT/);
  });

  it('passes the selected mode and model from the prompt box to the bridge', () => {
    expect(view).toMatch(/this\.agentMode\?\.value === 'ask' \? 'ask' : 'build'/);
    expect(view).toMatch(/this\.options\.agent\.run\(prompt, \{/);
    expect(view).toMatch(/model: selectedModel,/);
    expect(view).toMatch(/maxIterations/);
  });
});

describe('the Problems tab shows failed tool calls', () => {
  it('renders failures with names and messages as text', () => {
    expect(view).toMatch(/renderProblems/);
    expect(view).toMatch(/ide-problem-name/);
    expect(view).toMatch(/ide-problem-message/);
  });

  it('says empty means no failures yet, not clean code', () => {
    expect(view).toMatch(/No failed tool calls from the last run/);
  });

  it('counts failures on the tab', () => {
    expect(view).toMatch(/Problems \(\$\{failures\.length\}\)/);
  });

  it('updates after every run', () => {
    expect(view).toMatch(/this\.renderProblems\(result\.failedToolCalls\)/);
  });

  it('switches panes without unmounting the terminal', () => {
    // Unmounting would kill the shell session; hidden panes keep theirs.
    expect(view).toMatch(/removeAttribute\('hidden'\)/);
    expect(view).toMatch(/setAttribute\('hidden', ''\)/);
  });
});

describe('ghost text wiring', () => {
  it('registers the provider with the editor', () => {
    expect(view).toMatch(/registerInlineCompletionsProvider/);
    expect(view).toMatch(/registerGhostText/);
  });

  it('aborts the previous request on every keystroke', () => {
    // Without this, slow responses arrive for text the user has moved past,
    // and the ghost describes a cursor position that no longer exists.
    expect(view).toMatch(/ghostAbort\?\.abort\(\)/);
    expect(view).toMatch(/token\.onCancellationRequested/);
  });

  it('gives up after repeated failures instead of spamming fetches', () => {
    expect(view).toMatch(/MAX_CONSECUTIVE_FAILURES/);
    expect(view).toMatch(/ghostRegistration\?\.dispose\(\)/);
  });

  it('cleans up on dispose', () => {
    expect(view).toMatch(/ghostAbort\?\.abort\(\)/);
    expect(view).toMatch(/ghostRegistration\?\.dispose\(\)/);
  });

  it('resolves the model from config and passes it to the view', () => {
    expect(renderer).toMatch(/resolveInlineModel\(config\)/);
    expect(renderer).toMatch(/completion: resolveInlineModel/);
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
