/**
 * Storage abstraction.
 *
 * The desktop renderer has no localStorage, and an Android webview may have
 * it disabled, so persistence goes through an interface the host
 * implements. This keeps the app usable in both environments instead of
 * assuming a browser.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory store, used in tests and as a fallback. */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

/**
 * Store backed by localStorage when available, otherwise memory.
 *
 * A private-mode or storage-disabled webview must not break the app, so the
 * probe is defensive and falls back rather than throwing.
 */
export class SafeStore implements KeyValueStore {
  private readonly fallback = new MemoryStore();

  private get backing(): KeyValueStore | null {
    try {
      const storage = (globalThis as { localStorage?: Storage }).localStorage;
      if (!storage) return null;

      // Probe: a quota error only surfaces on write in some browsers.
      const probe = '__waypoint_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage as unknown as KeyValueStore;
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    const backing = this.backing;
    if (!backing) return this.fallback.get(key);
    try {
      return await backing.get(key);
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const backing = this.backing;
    if (!backing) return this.fallback.set(key, value);
    try {
      await backing.set(key, value);
    } catch {
      await this.fallback.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    const backing = this.backing;
    if (!backing) return this.fallback.delete(key);
    try {
      await backing.delete(key);
    } catch {
      await this.fallback.delete(key);
    }
  }

  async keys(): Promise<string[]> {
    const backing = this.backing;
    if (!backing) return this.fallback.keys();
    try {
      return await backing.keys();
    } catch {
      return this.fallback.keys();
    }
  }
}

/**
 * Persisted conversation history.
 *
 * History is capped and malformed entries are dropped rather than throwing,
 * because a corrupt file must not stop the app from starting.
 */
export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  at: number;
  tier?: string;
  model?: string;
  costUsd?: number;
}

export class ConversationStore {
  static readonly KEY = 'waypoint.conversations';
  static readonly MAX_ENTRIES = 50;
  static readonly MAX_MESSAGE_CHARS = 20_000;

  constructor(private readonly store: KeyValueStore) {}

  async list(): Promise<StoredMessage[]> {
    const raw = await this.store.get(ConversationStore.KEY);
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt history is discarded rather than blocking startup.
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isStoredMessage).slice(-ConversationStore.MAX_ENTRIES);
  }

  async append(messages: StoredMessage[]): Promise<void> {
    const existing = await this.list();

    // Truncate very long messages so one runaway response cannot fill the
    // storage quota.
    const trimmed = messages.map((message) => ({
      ...message,
      content: message.content.slice(0, ConversationStore.MAX_MESSAGE_CHARS),
    }));

    const merged = [...existing, ...trimmed].slice(-ConversationStore.MAX_ENTRIES);
    await this.store.set(ConversationStore.KEY, JSON.stringify(merged));
  }

  async clear(): Promise<void> {
    await this.store.delete(ConversationStore.KEY);
  }
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['role'] === 'string' &&
    typeof record['content'] === 'string' &&
    typeof record['at'] === 'number'
  );
}