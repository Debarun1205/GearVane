import { describe, expect, it } from 'vitest';

import {
  ConversationStore,
  MemoryStore,
  SafeStore,
  type KeyValueStore,
} from '../src/storage.js';

describe('MemoryStore', () => {
  it('stores and reads values', async () => {
    const store = new MemoryStore();
    await store.set('a', '1');
    await expect(store.get('a')).resolves.toBe('1');
  });

  it('returns null for a missing key', async () => {
    await expect(new MemoryStore().get('nope')).resolves.toBeNull();
  });

  it('deletes values', async () => {
    const store = new MemoryStore();
    await store.set('a', '1');
    await store.delete('a');
    await expect(store.get('a')).resolves.toBeNull();
  });

  it('lists keys', async () => {
    const store = new MemoryStore();
    await store.set('a', '1');
    await store.set('b', '2');
    await expect(store.keys()).resolves.toEqual(['a', 'b']);
  });
});

describe('SafeStore', () => {
  it('falls back to memory when localStorage is absent', async () => {
    // An Electron renderer has no localStorage, so the app must still work.
    const store = new SafeStore();
    await store.set('a', '1');
    await expect(store.get('a')).resolves.toBe('1');
  });

  it('uses localStorage when it is usable', async () => {
    const backing = new Map<string, string>();
    const fake = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
      clear: () => backing.clear(),
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() {
        return backing.size;
      },
    } as unknown as Storage;

    (globalThis as { localStorage?: Storage }).localStorage = fake;
    try {
      const store = new SafeStore();
      await store.set('a', '1');
      await expect(store.get('a')).resolves.toBe('1');
      await expect(store.keys()).resolves.toContain('a');
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('falls back when localStorage throws on write', async () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    } as unknown as Storage;

    (globalThis as { localStorage?: Storage }).localStorage = throwing;
    try {
      // A quota error must not break the app; the value is held in memory.
      const store = new SafeStore();
      await store.set('a', '1');
      await expect(store.get('a')).resolves.toBe('1');
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('ConversationStore', () => {
  const message = (id: string, content = 'hello') => ({
    id,
    role: 'user',
    content,
    at: 1_700_000_000_000,
  });

  it('returns nothing when empty', async () => {
    await expect(new ConversationStore(new MemoryStore()).list()).resolves.toEqual([]);
  });

  it('appends and lists messages', async () => {
    const store = new ConversationStore(new MemoryStore());
    await store.append([message('a')]);
    await store.append([message('b')]);

    const listed = await store.list();
    expect(listed.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('survives corrupt stored data', async () => {
    // A corrupt file must not stop the app from starting.
    const backing = new MemoryStore();
    await backing.set(ConversationStore.KEY, '{not json');
    await expect(new ConversationStore(backing).list()).resolves.toEqual([]);
  });

  it('drops entries that are not messages', async () => {
    const backing = new MemoryStore();
    await backing.set(
      ConversationStore.KEY,
      JSON.stringify([message('a'), null, { id: 5 }, 'nope']),
    );
    const listed = await new ConversationStore(backing).list();
    expect(listed.map((entry) => entry.id)).toEqual(['a']);
  });

  it('caps the number of stored entries', async () => {
    const backing = new MemoryStore();
    const store = new ConversationStore(backing);

    const many = Array.from({ length: ConversationStore.MAX_ENTRIES + 20 }, (_, i) =>
      message(`m${i}`),
    );
    await store.append(many);

    const listed = await store.list();
    expect(listed.length).toBe(ConversationStore.MAX_ENTRIES);
    // The newest entries survive.
    expect(listed[listed.length - 1]?.id).toBe(`m${many.length - 1}`);
  });

  it('truncates a very long message', async () => {
    const backing = new MemoryStore();
    const store = new ConversationStore(backing);
    await store.append([message('big', 'x'.repeat(50_000))]);

    const [stored] = await store.list();
    expect(stored?.content.length).toBe(ConversationStore.MAX_MESSAGE_CHARS);
  });

  it('clears history', async () => {
    const backing: KeyValueStore = new MemoryStore();
    const store = new ConversationStore(backing);
    await store.append([message('a')]);
    await store.clear();
    await expect(store.list()).resolves.toEqual([]);
  });
});