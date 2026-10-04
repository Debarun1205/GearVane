/**
 * Session persistence.
 *
 * The point of a session file is that an interrupted run can be resumed, so
 * three failure modes matter more than they would for ordinary caching:
 *
 * - a **corrupt or partial** file must not stop the app from starting, so
 *   anything unparseable is discarded rather than thrown
 * - a file written by an **older version** must be readable, so the shape is
 *   versioned and unknown fields are dropped rather than rejected
 * - **secrets must never be written**, so anything that looks like a key is
 *   stripped on the way out and never on the way back in
 *
 * The last one is the reason this module is not just a JSON helper. An agent
 * session contains command lines, file contents, and model responses, all of
 * which can contain a credential the user pasted in. A session file is the
 * most likely thing to be committed to a repository by accident, so it is
 * treated as untrusted on write.
 */

import type { ConversationMessage } from '@gearvane/core';

/** Storage the session store writes through. */
export interface SessionStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory storage. The default in tests and in a browser without storage. */
export class MemorySessionStorage implements SessionStorage {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

/** Current on-disk shape. Bump when a change needs migrating. */
export const SESSION_VERSION = 1;

/** What a resumed run needs in order to continue. */
export interface SessionState {
  id: string;
  task: string;
  /** The conversation, trimmed or not depending on what was last sent. */
  messages: ConversationMessage[];
  /** Absolute workspace root the run was confined to. */
  workspaceRoot: string;
  system?: string;
  createdAt: number;
  updatedAt: number;

  /** Running totals, so a resumed session still knows what it spent. */
  tokensIn?: number;
  tokensOut?: number;
  compactions?: number;

  /** True when the loop had already finished and this is only history. */
  finished?: boolean;
}

interface StoredSession extends SessionState {
  version: number;
}

/** How a persisted session compares with the requested one. */
export type ResumeStatus =
  | 'resumed'
  | 'migrated'
  | 'empty'
  | 'corrupt'
  | 'not_found';

/** Fields dropped on load because they are not part of the current shape. */
function sanitiseMessage(value: unknown): ConversationMessage | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const role = record['role'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    return null;
  }

  if (typeof record['content'] !== 'string') return null;

  const message: ConversationMessage = {
    role,
    content: record['content'],
  };

  if (role === 'assistant' && Array.isArray(record['toolCalls'])) {
    const calls = record['toolCalls']
      .filter(
        (call): call is Record<string, unknown> =>
          call !== null && typeof call === 'object',
      )
      .map((call) => ({
        name: String(call['name'] ?? ''),
        arguments:
          call['arguments'] !== null && typeof call['arguments'] === 'object'
            ? (call['arguments'] as Record<string, unknown>)
            : {},
      }))
      // A call with no name cannot be dispatched, so keeping it would only
      // produce a request the provider rejects.
      .filter((call) => call.name !== '');

    if (calls.length > 0) message.toolCalls = calls;
  }

  if (role === 'tool') {
    if (typeof record['toolCallId'] === 'string') message.toolCallId = record['toolCallId'];
    if (typeof record['name'] === 'string') message.name = record['name'];
  }

  return message;
}

/**
 * Patterns that look like credentials.
 *
 * A blunt list on purpose. False positives cost a little context; a false
 * negative writes a live key to disk where it can be committed.
 */
/**
 * Each rule pairs a pattern with how to rebuild the match.
 *
 * Written as pairs rather than one pattern list inspected at replacement time,
 * because the capture layout differs per rule and a single shared callback is
 * how a URL ends up with its username and scheme lost.
 */
const SECRET_RULES: Array<{
  pattern: RegExp;
  replace: (match: string, groups: string[]) => string;
}> = [
  {
    // PEM blocks first: largest and most distinctive, and letting a narrower
    // pattern match inside one would leave fragments behind.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[redacted private key]',
  },
  {
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => '[redacted]',
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    replace: () => '[redacted]',
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => '[redacted]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
    replace: () => 'Bearer [redacted]',
  },
  {
    // URL credentials. Declared before the assignment rule because a URL
    // password often contains a word like "secret", which the assignment rule
    // would otherwise match in the middle of, mangling the host.
    //
    // Group 1 is the whole userinfo section, so the username survives and only
    // the password is dropped.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]{4,})@/gi,
    replace: (_match, groups) => `${groups[0] ?? ''}:[redacted]@`,
  },
  {
    // key = "value" assignments, which is how they appear in command output.
    // Group 1 is the variable name and is kept, so the transcript reads.
    pattern: /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|credential)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"',}]{8,}["']?/gi,
    replace: (_match, groups) =>
      (groups[0] ? `${groups[0]}=[redacted]` : '[redacted]'),
  },
  {
    // A .env style line with no obvious variable name, e.g. a bare token.
    pattern: /^\s*([A-Z][A-Z0-9_]{6,})\s*=\s*[^\s"']{12,}\s*$/gm,
    replace: (_match, groups) => `${groups[0] ?? ''}=[redacted]`,
  },
];

/**
 * Replace anything credential-shaped with a marker.
 *
 * Applied to the whole serialised session rather than to individual fields,
 * because a key can turn up inside a file the agent read, a command it ran, or
 * a model response, and none of those are distinguishable from ordinary text.
 */
export function redact(text: string): string {
  let output = text;

  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    output = output.replace(
      rule.pattern,
      (...args: unknown[]) => {
        const groups = (args.slice(1, -2) as unknown[]).map((group) =>
          typeof group === 'string' ? group : '',
        );
        return rule.replace(args[0] as string, groups);
      },
    );
  }

  return output;
}

export interface SessionStoreOptions {
  /** Prefix for storage keys. */
  namespace?: string;
  /** Maximum sessions retained. Oldest are evicted first. */
  maxSessions?: number;
  /**
   * Strip credential-shaped text before writing.
   *
   * On by default. Turning it off means session files may contain live keys,
   * which is almost never what anyone wants.
   */
  redact?: boolean;
  /** Injected clock, so tests do not depend on wall time. */
  now?: () => number;
}

export interface ResumeResult {
  status: ResumeStatus;
  state?: SessionState;
  /** Set when a session was dropped rather than loaded. */
  reason?: string;
}

export class SessionStore {
  private readonly namespace: string;
  private readonly maxSessions: number;
  private readonly shouldRedact: boolean;
  private readonly now: () => number;

  constructor(
    private readonly storage: SessionStorage,
    options: SessionStoreOptions = {},
  ) {
    this.namespace = options.namespace ?? 'gearvane.session.';
    this.maxSessions = options.maxSessions ?? 20;
    this.shouldRedact = options.redact ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  private key(id: string): string {
    return `${this.namespace}${id}`;
  }

  private async index(): Promise<string[]> {
    const keys = await this.storage.keys();
    return keys.filter((key) => key.startsWith(this.namespace));
  }

  /**
   * Write a session.
   *
   * The id is taken from the state rather than generated here, so a caller
   * resuming a run keeps the same id and a new run gets a fresh one.
   */
  async save(state: SessionState): Promise<void> {
    const record: StoredSession = {
      ...state,
      messages: state.messages.map((message) => ({
        ...message,
        content: message.content,
      })),
      version: SESSION_VERSION,
      updatedAt: this.now(),
    };

    let serialised = JSON.stringify(record);

    if (this.shouldRedact) {
      serialised = redact(serialised);
    }

    await this.storage.set(this.key(state.id), serialised);
    await this.evict();
  }

  /** Load a session, reporting why if it cannot be used. */
  async load(id: string): Promise<ResumeResult> {
    const raw = await this.storage.get(this.key(id));
    if (raw === null) return { status: 'not_found' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated file is the expected failure here, not an exceptional one.
      return { status: 'corrupt', reason: 'not valid JSON' };
    }

    if (parsed === null || typeof parsed !== 'object') {
      return { status: 'corrupt', reason: 'not an object' };
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record['task'] !== 'string' || typeof record['id'] !== 'string') {
      return { status: 'corrupt', reason: 'missing task or id' };
    }

    if (typeof record['workspaceRoot'] !== 'string') {
      // Without the root there is nothing to confine the resumed run to, and
      // resuming into an unknown directory would be worse than not resuming.
      return { status: 'corrupt', reason: 'missing workspace root' };
    }

    const messages = Array.isArray(record['messages'])
      ? (record['messages'] as unknown[]).map(sanitiseMessage).filter(
          (message): message is ConversationMessage => message !== null,
        )
      : [];

    const version = typeof record['version'] === 'number' ? record['version'] : 0;

    const state: SessionState = {
      id: record['id'],
      task: record['task'],
      messages,
      workspaceRoot: record['workspaceRoot'],
      createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
      updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
    };

    if (typeof record['system'] === 'string') state.system = record['system'];
    if (typeof record['tokensIn'] === 'number') state.tokensIn = record['tokensIn'];
    if (typeof record['tokensOut'] === 'number') state.tokensOut = record['tokensOut'];
    if (typeof record['compactions'] === 'number') state.compactions = record['compactions'];
    if (record['finished'] === true) state.finished = true;

    return {
      // A file with no version predates versioning, which is only a migration
      // if it actually needs reshaping. Current shape means no change needed.
      status: version === SESSION_VERSION ? 'resumed' : 'migrated',
      state,
    };
  }

  async remove(id: string): Promise<void> {
    await this.storage.remove(this.key(id));
  }

  /** Summaries of every stored session, newest first. */
  async list(): Promise<
    Array<{ id: string; task: string; updatedAt: number; finished: boolean }>
  > {
    const keys = await this.index();
    const summaries = [];

    for (const key of keys) {
      const result = await this.load(key.slice(this.namespace.length));
      if (!result.state) continue;
      summaries.push({
        id: result.state.id,
        task: result.state.task,
        updatedAt: result.state.updatedAt,
        finished: result.state.finished === true,
      });
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Drop the oldest sessions beyond the retention limit. */
  private async evict(): Promise<void> {
    const summaries = await this.list();
    for (const summary of summaries.slice(this.maxSessions)) {
      await this.remove(summary.id);
    }
  }
}