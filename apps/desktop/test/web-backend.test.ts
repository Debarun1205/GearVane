import { describe, expect, it } from 'vitest';

import { defaultConfig } from '@waypoint/core';

import {
  WEB_WORKSPACE_ROOT,
  WebAgentBridge,
  WebWorkspace,
  createWebBackend,
  type WebFsStorage,
} from '../src/web-backend.js';

function memoryStorage(initial?: string): WebFsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set('waypoint.webfs.v1', initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('WebWorkspace files', () => {
  it('seeds an orienting README on first launch', () => {
    const workspace = new WebWorkspace(memoryStorage());
    expect(workspace.list().map((entry) => entry.path)).toEqual(['README.md']);
    expect(workspace.read('README.md').content).toMatch(/no terminal/i);
  });

  it('does not reseed over an existing workspace', () => {
    const storage = memoryStorage();
    const first = new WebWorkspace(storage);
    first.write('notes.txt', 'hello');
    const second = new WebWorkspace(storage);
    expect(second.list().map((entry) => entry.path).sort()).toEqual(['README.md', 'notes.txt']);
  });

  it('restores a corrupt snapshot to the seed instead of crashing', () => {
    const workspace = new WebWorkspace(memoryStorage('not json{'));
    expect(workspace.list().map((entry) => entry.path)).toEqual(['README.md']);
  });

  it('lists top-level entries with directories first', () => {
    const workspace = new WebWorkspace(memoryStorage());
    workspace.write('b.txt', 'b');
    workspace.write('src/a.ts', 'a');
    workspace.write('a.txt', 'a');
    expect(workspace.list()).toEqual([
      { name: 'src', path: 'src', isDirectory: true },
      // Code-point sort, so capitals come first; deterministic either way.
      { name: 'README.md', path: 'README.md', isDirectory: false, size: expect.any(Number) },
      { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1 },
      { name: 'b.txt', path: 'b.txt', isDirectory: false, size: 1 },
    ]);
  });

  it('reads, writes, and removes files', () => {
    const workspace = new WebWorkspace(memoryStorage());
    expect(workspace.write('src/app.ts', 'const x = 1;').ok).toBe(true);
    expect(workspace.read('src/app.ts')).toEqual({ ok: true, content: 'const x = 1;' });
    expect(workspace.remove('src/app.ts')).toEqual({ ok: true });
    expect(workspace.read('src/app.ts').ok).toBe(false);
  });

  it('removes whole directory subtrees', () => {
    const workspace = new WebWorkspace(memoryStorage());
    workspace.write('src/a.ts', 'a');
    workspace.write('src/b.ts', 'b');
    expect(workspace.remove('src')).toEqual({ ok: true });
    expect(workspace.read('src/a.ts').ok).toBe(false);
  });

  it('rejects escaping paths', () => {
    const workspace = new WebWorkspace(memoryStorage());
    expect(workspace.read('../etc/passwd').ok).toBe(false);
    expect(workspace.write('..', 'x').ok).toBe(false);
    expect(workspace.remove('a/../../b').ok).toBe(false);
    expect(workspace.list().map((entry) => entry.path)).toEqual(['README.md']);
  });

  it('searches path:line hits like the desktop backend', () => {
    const workspace = new WebWorkspace(memoryStorage());
    workspace.write('a.txt', 'hello world\nsecond hello\n');
    workspace.write('b.txt', 'nothing here\n');
    const result = workspace.search('hello');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('a.txt:1: hello world\na.txt:2: second hello');
  });

  it('reports no matches as empty content', () => {
    const workspace = new WebWorkspace(memoryStorage());
    expect(workspace.search('zzz')).toEqual({ ok: true, content: '' });
  });
});

describe('WebAgentBridge', () => {
  const deps = {
    config: () => defaultConfig(),
    env: () => ({}),
  };

  it('lists every configured model in tier order', async () => {
    const models = await new WebAgentBridge(deps).models();
    expect(models.length).toBeGreaterThan(10);
    expect(models[0]?.tier).toBe('local');
  });

  it('rejects an empty prompt', async () => {
    const response = await new WebAgentBridge(deps).run('   ', 'root', { mode: 'ask' });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/non-empty/);
  });

  it('refuses build mode instead of pretending to edit files', async () => {
    const response = await new WebAgentBridge(deps).run('make a site', 'root', { mode: 'build' });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/desktop/);
  });

  it('rejects an unknown model selection', async () => {
    const response = await new WebAgentBridge(deps).run('hi', 'root', {
      mode: 'ask',
      model: 'nosuch/model',
    });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/unknown model/);
  });

  it('reports an unreachable model as a failed run, not a crash', async () => {
    // No servers answer in the test environment; the bridge must surface
    // the provider error as data, matching the desktop agent contract. One
    // discard-port provider and no retries keep this to milliseconds.
    const config = defaultConfig();
    config.tiers.local.providers = [{ name: 'ollama', baseUrl: 'http://localhost:9', models: ['x'] }];
    config.tiers.mid.providers = [];
    config.tiers.frontier.providers = [];
    config.providers.maxRetries = 0;
    config.providers.retryBaseDelay = 0;
    config.providers.retryMaxDelay = 0;
    config.router.escalation.maxAttemptsPerTier = 1;
    config.router.escalation.maxEscalations = 0;
    const agent = new WebAgentBridge({ config: () => config, env: () => ({}) });
    const response = await agent.run('fix a typo', 'root', { mode: 'ask' });
    expect(response.ok).toBe(false);
    expect(typeof response.error).toBe('string');
  });

  it('cancels and unsubscribes without throwing', () => {
    const agent = new WebAgentBridge(deps);
    expect(() => agent.cancel()).not.toThrow();
    expect(typeof agent.onStep(() => {})).toBe('function');
  });
});

describe('createWebBackend', () => {
  it('serves the fixed workspace root and the seeded tree', async () => {
    const backend = createWebBackend({
      config: () => defaultConfig(),
      env: () => ({}),
      storage: memoryStorage(),
    });
    await expect(backend.workspaceRoot()).resolves.toBe(WEB_WORKSPACE_ROOT);
    const listed = await backend.ideFs.list(WEB_WORKSPACE_ROOT);
    expect(listed.ok).toBe(true);
    expect(listed.entries?.map((entry) => entry.path)).toEqual(['README.md']);
  });
});
