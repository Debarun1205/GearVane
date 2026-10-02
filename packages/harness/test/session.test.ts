import { describe, expect, it } from 'vitest';

import {
  MemorySessionStorage,
  SESSION_VERSION,
  SessionStore,
  redact,
  type SessionState,
} from '../src/session/store.js';

/**
 * Session persistence tests.
 *
 * Three properties are load-bearing, and two of them are about what must NOT
 * happen rather than about what must:
 *
 * - a corrupt file never throws
 * - a credential never reaches storage
 * - a resumed conversation is still structurally valid for the provider
 */

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    task: 'fix the typo',
    messages: [{ role: 'user', content: 'fix the typo in README.md' }],
    workspaceRoot: '/home/dev/project',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function store(options = {}) {
  let clock = 2_000;
  const storage = new MemorySessionStorage();
  const sessions = new SessionStore(storage, {
    now: () => (clock += 1),
    ...options,
  });
  return { sessions, storage };
}

describe('saving and loading', () => {
  it('round-trips a session', async () => {
    const { sessions } = store();
    await sessions.save(state());

    const result = await sessions.load('s1');
    expect(result.status).toBe('resumed');
    expect(result.state?.task).toBe('fix the typo');
    expect(result.state?.workspaceRoot).toBe('/home/dev/project');
  });

  it('round-trips tool calls and results', async () => {
    const { sessions } = store();
    await sessions.save(
      state({
        messages: [
          { role: 'user', content: 'read a.ts' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', content: 'export const a = 1;', name: 'read_file', toolCallId: 'call_0' },
        ],
      }),
    );

    const result = await sessions.load('s1');
    const messages = result.state?.messages ?? [];

    expect(messages).toHaveLength(3);
    expect(messages[1]?.toolCalls?.[0]?.name).toBe('read_file');
    expect(messages[1]?.toolCalls?.[0]?.arguments).toEqual({ path: 'a.ts' });
    expect(messages[2]?.toolCallId).toBe('call_0');
  });

  it('reports not_found for an unknown id', async () => {
    const { sessions } = store();
    expect((await sessions.load('nope')).status).toBe('not_found');
  });

  it('stamps updatedAt on save', async () => {
    const { sessions } = store();
    await sessions.save(state({ updatedAt: 1 }));

    const result = await sessions.load('s1');
    expect(result.state?.updatedAt).toBeGreaterThan(1);
  });

  it('keeps running totals so a resumed run knows its spend', async () => {
    const { sessions } = store();
    await sessions.save(
      state({ tokensIn: 500, tokensOut: 120, compactions: 2, finished: true }),
    );

    const result = await sessions.load('s1');
    expect(result.state?.tokensIn).toBe(500);
    expect(result.state?.tokensOut).toBe(120);
    expect(result.state?.compactions).toBe(2);
    expect(result.state?.finished).toBe(true);
  });

  it('removes a session', async () => {
    const { sessions } = store();
    await sessions.save(state());
    await sessions.remove('s1');

    expect((await sessions.load('s1')).status).toBe('not_found');
  });

  it('lists sessions newest first', async () => {
    const { sessions } = store();
    await sessions.save(state({ id: 'old', task: 'older' }));
    await sessions.save(state({ id: 'new', task: 'newer' }));

    const listed = await sessions.list();
    expect(listed[0]?.id).toBe('new');
    expect(listed.map((s) => s.id)).toContain('old');
  });

  it('evicts beyond the retention limit', async () => {
    const { sessions } = store({ maxSessions: 2 });
    for (const id of ['a', 'b', 'c']) {
      await sessions.save(state({ id }));
    }

    const listed = await sessions.list();
    expect(listed).toHaveLength(2);
    // The oldest went first.
    expect(listed.map((s) => s.id)).not.toContain('a');
  });
});

describe('corrupt and partial files', () => {
  /**
   * A truncated file is the expected failure, not an exceptional one: a crash
   * mid-write leaves exactly this behind. It must never propagate.
   */
  it('discards a file that is not JSON', async () => {
    const { sessions, storage } = store();
    await sessions.save(state());
    await storage.set('waypoint.session.s1', '{ truncated');

    const result = await sessions.load('s1');
    expect(result.status).toBe('corrupt');
    expect(result.state).toBeUndefined();
  });

  it('discards a file that is not an object', async () => {
    const { sessions, storage } = store();
    await storage.set('waypoint.session.s1', '"just a string"');

    expect((await sessions.load('s1')).status).toBe('corrupt');
  });

  it('discards a session with no workspace root', async () => {
    // Resuming into an unknown directory would be worse than not resuming: the
    // run would be confined to nothing, or to whatever happened to be current.
    const { sessions, storage } = store();
    await storage.set(
      'waypoint.session.s1',
      JSON.stringify({ version: 1, id: 's1', task: 'x', messages: [] }),
    );

    const result = await sessions.load('s1');
    expect(result.status).toBe('corrupt');
    expect(result.reason).toMatch(/workspace root/i);
  });

  it('discards a session with no task', async () => {
    const { sessions, storage } = store();
    await storage.set(
      'waypoint.session.s1',
      JSON.stringify({ version: 1, id: 's1', workspaceRoot: '/p', messages: [] }),
    );

    expect((await sessions.load('s1')).status).toBe('corrupt');
  });

  it('does not throw from list when a file is corrupt', async () => {
    const { sessions, storage } = store();
    await sessions.save(state({ id: 'good' }));
    await storage.set('waypoint.session.bad', 'not json at all');

    const listed = await sessions.list();
    expect(listed.map((s) => s.id)).toEqual(['good']);
  });

  it('skips malformed messages rather than failing the session', async () => {
    const { sessions, storage } = store();
    await storage.set(
      'waypoint.session.s1',
      JSON.stringify({
        version: SESSION_VERSION,
        id: 's1',
        task: 't',
        workspaceRoot: '/p',
        messages: [
          { role: 'user', content: 'good' },
          { role: 'nonsense', content: 'bad role' },
          null,
          { role: 'user' },
          { content: 'no role' },
        ],
      }),
    );

    const result = await sessions.load('s1');
    expect(result.status).toBe('resumed');
    expect(result.state?.messages).toHaveLength(1);
    expect(result.state?.messages[0]?.content).toBe('good');
  });

  it('drops a tool call with no name', async () => {
    // Keeping it would produce a request the provider rejects.
    const { sessions, storage } = store();
    await storage.set(
      'waypoint.session.s1',
      JSON.stringify({
        version: SESSION_VERSION,
        id: 's1',
        task: 't',
        workspaceRoot: '/p',
        messages: [
          { role: 'assistant', content: '', toolCalls: [{ name: '', arguments: {} }] },
        ],
      }),
    );

    const result = await sessions.load('s1');
    expect(result.state?.messages[0]?.toolCalls).toBeUndefined();
  });

  it('reports a versioned file as migrated', async () => {
    const { sessions, storage } = store();
    await storage.set(
      'waypoint.session.s1',
      JSON.stringify({
        version: 0,
        id: 's1',
        task: 'old format',
        workspaceRoot: '/p',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    const result = await sessions.load('s1');
    expect(result.status).toBe('migrated');
    // Still usable, which is the point of migrating rather than rejecting.
    expect(result.state?.task).toBe('old format');
  });

  it('drops unknown fields rather than rejecting the file', async () => {
    const { sessions, storage } = store();
    await storage.set(
      'waypoint.session.s1',
      JSON.stringify({
        version: SESSION_VERSION,
        id: 's1',
        task: 't',
        workspaceRoot: '/p',
        messages: [],
        somethingFromTheFuture: { nested: true },
      }),
    );

    expect((await sessions.load('s1')).status).toBe('resumed');
  });
});

describe('secrets never reach storage', () => {
  it('redacts a provider-style key', () => {
    expect(redact('key is sk-abcdefghijklmnopqrstuvwx')).toContain('[redacted]');
    expect(redact('key is sk-abcdefghijklmnopqrstuvwx')).not.toContain(
      'abcdefghijklmnopqrstuvwx',
    );
  });

  it('redacts a GitHub token', () => {
    const text = 'using ghp_1234567890abcdefghijklmnop for auth';
    const output = redact(text);
    expect(output).not.toContain('1234567890abcdefghijklmnop');
  });

  it('redacts a Slack token', () => {
    expect(redact('xoxb-123456789012-abcdefghijkl')).not.toContain('123456789012');
  });

  it('redacts an api key assignment, keeping the variable name', () => {
    const output = redact('ANTHROPIC_API_KEY=sk-ant-supersecretvalue1234');
    expect(output).not.toContain('supersecretvalue1234');
    // The name survives, so the transcript still reads sensibly.
    expect(output).toContain('API_KEY');
  });

  it('redacts an Authorization header', () => {
    const output = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts a PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx7Vv8QzY',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const output = redact(`found ${pem}`);
    expect(output).not.toContain('MIIEowIBAAKCAQEAx7Vv8QzY');
    expect(output).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(output).toContain('redacted');
  });

  it('redacts a key inside a file the agent read', async () => {
    // The transcript is not distinguishable from ordinary text, which is
    // exactly why redaction runs over the serialised session.
    const { sessions, storage } = store();
    await sessions.save(
      state({
        messages: [
          {
            role: 'tool',
            content: 'OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012',
            name: 'read_file',
          },
        ],
      }),
    );

    const raw = (await storage.get('waypoint.session.s1')) ?? '';
    expect(raw).not.toContain('abc123def456ghi789jkl012');
    expect(raw).toContain('[redacted]');
  });

  it('redacts a key in a command the agent ran', async () => {
    const { sessions, storage } = store();
    await sessions.save(
      state({
        messages: [
          { role: 'user', content: 'deploy with SECRET_TOKEN=ghp_abcdefghijklmnopqrst' },
        ],
      }),
    );

    const raw = (await storage.get('waypoint.session.s1')) ?? '';
    expect(raw).not.toContain('abcdefghijklmnopqrst');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Read 12 lines from src/index.ts and fixed the typo in README.md';
    expect(redact(text)).toBe(text);
  });

  it('does not redact short strings that merely look assignment-shaped', () => {
    // A false positive costs a little readability; a false negative writes a
    // live credential to disk. The asymmetry is deliberate, but short values
    // are still not worth mangling.
    const text = 'const limit = 5;';
    expect(redact(text)).toBe(text);
  });

  it('redacts a password in a URL, keeping scheme and username', () => {
    // How a credential appears in command output and in fetched content.
    const output = redact('cloning https://deploy:hunter2secret@git.example.com/repo');
    expect(output).not.toContain('hunter2secret');
    expect(output).toContain('https://deploy:');
  });

  it('redacts a bare .env assignment with no obvious key name', () => {
    const output = redact('DATABASE_CREDENTIAL=Zq8Xk2mNp4Vr7Ts1');
    expect(output).not.toContain('Zq8Xk2mNp4Vr7Ts1');
  });

  it('leaves an ordinary URL with no credentials alone', () => {
    const text = 'see https://example.com/docs/guide for details';
    expect(redact(text)).toBe(text);
  });

  it('leaves a Windows path alone', () => {
    // A mangled path in a transcript is worse than useless for debugging.
    const text = 'C:\\Users\\dev\\project\\src\\index.ts';
    expect(redact(text)).toBe(text);
  });

  it('redacts nothing when there is nothing to redact', () => {
    const text = 'Read 12 lines from src/index.ts and fixed the typo in README.md';
    expect(redact(text)).toBe(text);
    expect(redact('')).toBe('');
  });

  it('can be turned off deliberately', async () => {
    const { sessions, storage } = store({ redact: false });
    await sessions.save(
      state({ messages: [{ role: 'user', content: 'sk-abcdefghijklmnopqrstuvwx' }] }),
    );

    const raw = (await storage.get('waypoint.session.s1')) ?? '';
    expect(raw).toContain('sk-abcdefghijklmnopqrstuvwx');
  });
});

describe('a resumed session is still valid', () => {
  it('preserves the tool-call pairing', async () => {
    const { sessions } = store();
    await sessions.save(
      state({
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { name: 'read_file', arguments: { path: 'a' } },
              { name: 'read_file', arguments: { path: 'b' } },
            ],
          },
          { role: 'tool', content: 'A', name: 'read_file', toolCallId: 'call_0' },
          { role: 'tool', content: 'B', name: 'read_file', toolCallId: 'call_1' },
        ],
      }),
    );

    const messages = (await sessions.load('s1')).state?.messages ?? [];
    expect(messages[1]?.toolCalls).toHaveLength(2);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('keeps the first user message so the run knows its task', async () => {
    const { sessions } = store();
    await sessions.save(state());

    const messages = (await sessions.load('s1')).state?.messages ?? [];
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('fix the typo in README.md');
  });

  it('keeps the system prompt', async () => {
    const { sessions } = store();
    await sessions.save(state({ system: 'you are careful' }));

    expect((await sessions.load('s1')).state?.system).toBe('you are careful');
  });

  it('is deterministic for the same input', async () => {
    // Redaction must not reorder or drop anything else, or resuming twice
    // would give two different conversations.
    const { sessions } = store();
    const input = state({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
    });

    await sessions.save(input);
    const first = await sessions.load('s1');
    await sessions.save(input);
    const second = await sessions.load('s1');

    expect(first.state?.messages).toEqual(second.state?.messages);
  });

  it('overwrites rather than appending on re-save', async () => {
    const { sessions } = store();
    await sessions.save(state());
    await sessions.save(
      state({ messages: [{ role: 'user', content: 'a different task' }] }),
    );

    const result = await sessions.load('s1');
    expect(result.state?.messages).toHaveLength(1);
    expect(result.state?.messages[0]?.content).toBe('a different task');
  });
});

describe('namespacing', () => {
  it('keeps sessions under one namespace', async () => {
    const storage = new MemorySessionStorage();
    const a = new SessionStore(storage, { namespace: 'app-a.' });
    const b = new SessionStore(storage, { namespace: 'app-b.' });

    await a.save(state({ id: 'shared' }));
    await b.save(state({ id: 'shared', task: 'different app' }));

    expect((await a.load('shared')).state?.task).toBe('fix the typo');
    expect((await b.load('shared')).state?.task).toBe('different app');
  });

  it('does not list another namespace', async () => {
    const storage = new MemorySessionStorage();
    const a = new SessionStore(storage, { namespace: 'app-a.' });
    const b = new SessionStore(storage, { namespace: 'app-b.' });

    await a.save(state({ id: 'one' }));
    await b.save(state({ id: 'two' }));

    expect((await a.list()).map((s) => s.id)).toEqual(['one']);
  });
});