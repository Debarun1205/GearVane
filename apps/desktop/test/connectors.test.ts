import { describe, expect, it } from 'vitest';

import {
  addConnector,
  loadConnectors,
  parseMcpServerJson,
  removeConnector,
  toggleConnector,
  type ConnectorStorage,
} from '../src/connectors.js';

function memoryStorage(seed?: string): ConnectorStorage {
  let value: string | null = seed ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

describe('parseMcpServerJson', () => {
  it('accepts a url server with tools', () => {
    const parsed = parseMcpServerJson(
      JSON.stringify({ name: 'Docs', url: 'https://docs.example/mcp', tools: ['search'] }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.name).toBe('Docs');
      expect(parsed.draft.tools).toEqual(['search']);
    }
  });

  it('accepts a command server without tools', () => {
    const parsed = parseMcpServerJson(JSON.stringify({ name: 'gh', command: 'gh mcp' }));
    expect(parsed.ok).toBe(true);
  });

  it('rejects missing names, transports, and bad tools', () => {
    expect(parseMcpServerJson('nope').ok).toBe(false);
    expect(parseMcpServerJson('[]').ok).toBe(false);
    expect(parseMcpServerJson(JSON.stringify({ url: 'https://x.example' })).ok).toBe(false);
    expect(parseMcpServerJson(JSON.stringify({ name: 'x' })).ok).toBe(false);
    expect(
      parseMcpServerJson(JSON.stringify({ name: 'x', url: 'https://x.example', tools: 'no' })).ok,
    ).toBe(false);
  });
});

describe('connector registry', () => {
  it('adds, toggles, and removes servers', () => {
    const storage = memoryStorage();
    const first = addConnector(storage, { name: 'Docs', url: 'https://d.example', tools: [] });
    const second = addConnector(storage, { name: 'Docs', url: 'https://e.example', tools: [] });
    // Same name twice must not collide on id.
    expect(first.id).not.toBe(second.id);
    expect(loadConnectors(storage)).toHaveLength(2);

    toggleConnector(storage, first.id);
    expect(loadConnectors(storage).find((server) => server.id === first.id)?.enabled).toBe(false);

    removeConnector(storage, first.id);
    expect(loadConnectors(storage).map((server) => server.id)).toEqual([second.id]);
  });

  it('reads corrupt storage as empty', () => {
    expect(loadConnectors(memoryStorage('not json{'))).toEqual([]);
    expect(loadConnectors(memoryStorage('{"a":1}'))).toEqual([]);
  });
});
