import { describe, expect, it } from 'vitest';

import {
  AnthropicClient,
  OpenAICompatClient,
  toOpenAITool,
  type ConversationMessage,
  type ToolDefinition,
} from '../src/providers.js';

/**
 * Tool calling on the wire.
 *
 * The regression these cover is subtle and was invisible from the type layer:
 * `normaliseToolCalls` has always parsed `tool_calls` out of a response, and
 * `Completion.toolCalls` has always been a documented field, but no code path
 * ever sent a `tools` parameter. A model that is never told what it can do
 * cannot ask to do it, so every tool call would have been permanently empty.
 */

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(captured: Captured[], response: Record<string, unknown>) {
  return async (input: string, init?: { body?: string }): Promise<Response> => {
    captured.push({
      url: input,
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

const READ_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

describe('OpenAI-compatible tool advertising', () => {
  it('sends the tools array when tools are offered', async () => {
    const captured: Captured[] = [];
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async (
      _path: string,
      body: Record<string, unknown>,
    ) => {
      captured.push({ url: 'http://api.test/v1/chat', body });
      return {
        model: 'm',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {},
      };
    };

    await client.complete('read a.ts', { tools: [READ_TOOL] });

    const body = captured[0]?.body ?? {};
    expect(Array.isArray(body['tools'])).toBe(true);
    expect(body['tools']).toHaveLength(1);
    expect(body['tool_choice']).toBe('auto');
  });

  it('omits tools entirely when none are offered', async () => {
    // Sending `tools: []` is not the same as sending nothing; some providers
    // reject an empty array.
    const captured: Captured[] = [];
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async (
      _path: string,
      body: Record<string, unknown>,
    ) => {
      captured.push({ url: 'x', body });
      return {
        model: 'm',
        choices: [{ message: { content: 'hi' } }],
        usage: {},
      };
    };

    await client.complete('hello');

    expect(captured[0]?.body).not.toHaveProperty('tools');
    expect(captured[0]?.body).not.toHaveProperty('tool_choice');
  });

  it('parses tool calls out of the response', async () => {
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async () => ({
      model: 'm',
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'read_file',
                  arguments: '{"path":"src/a.ts"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {},
    });

    const result = await client.complete('read it', { tools: [READ_TOOL] });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('read_file');
    expect(result.toolCalls[0]?.arguments).toEqual({ path: 'src/a.ts' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('survives malformed tool call arguments', async () => {
    // A model that emits broken JSON must not crash the caller; an empty
    // argument object becomes a validation error the loop can report back.
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async () => ({
      model: 'm',
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: 'read_file', arguments: '{not json' } }],
          },
        },
      ],
      usage: {},
    });

    const result = await client.complete('x', { tools: [READ_TOOL] });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.arguments).toEqual({});
  });

  it('ignores a tool call with no name', async () => {
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async () => ({
      model: 'm',
      choices: [{ message: { tool_calls: [{ function: { arguments: '{}' } }] } }],
      usage: {},
    });

    const result = await client.complete('x', { tools: [READ_TOOL] });
    expect(result.toolCalls).toEqual([]);
  });
});

describe('conversation history', () => {
  it('degrades to a single user turn with no history', async () => {
    const captured: Captured[] = [];
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push({ url: 'x', body });
      return { model: 'm', choices: [{ message: { content: 'ok' } }], usage: {} };
    };

    await client.complete('do the thing', { system: 'be brief' });

    const messages = captured[0]?.body['messages'] as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'do the thing' },
    ]);
  });

  it('passes history through in order', async () => {
    const captured: Captured[] = [];
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push({ url: 'x', body });
      return { model: 'm', choices: [{ message: { content: 'ok' } }], usage: {} };
    };

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'read a.ts' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', content: 'export const a = 1;', name: 'read_file', toolCallId: 'call_0' },
      { role: 'user', content: 'now edit it' },
    ];

    await client.complete('ignored', { messages, tools: [READ_TOOL] });

    const sent = captured[0]?.body['messages'] as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual({ role: 'user', content: 'read a.ts' });

    // The assistant turn must carry the call, or the tool result is orphaned.
    expect(sent[1]?.['role']).toBe('assistant');
    expect(Array.isArray(sent[1]?.['tool_calls'])).toBe(true);

    expect(sent[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_0' });
    expect(sent[3]).toEqual({ role: 'user', content: 'now edit it' });
  });

  it('allows null content on a tool-only assistant turn', async () => {
    const captured: Captured[] = [];
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push({ url: 'x', body });
      return { model: 'm', choices: [{ message: { content: '' } }], usage: {} };
    };

    await client.complete('x', {
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'read_file', arguments: {} }],
        },
      ],
      tools: [READ_TOOL],
    });

    const sent = captured[0]?.body['messages'] as Array<Record<string, unknown>>;
    expect(sent[0]?.['content']).toBeNull();
  });

  it('prefers a supplied system prompt alongside history', async () => {
    const captured: Captured[] = [];
    const client = new OpenAICompatClient('http://api.test/v1', 'm', undefined, 5000);
    (client as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push({ url: 'x', body });
      return { model: 'm', choices: [{ message: { content: 'ok' } }], usage: {} };
    };

    await client.complete('x', {
      system: 'you are careful',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const sent = captured[0]?.body['messages'] as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({ role: 'system', content: 'you are careful' });
    expect(sent).toHaveLength(2);
  });
});

describe('Anthropic tool calling', () => {
  const client = () =>
    new AnthropicClient('http://api.test', 'claude', undefined, 5000);

  function stub(client: { post: unknown }, response: Record<string, unknown>) {
    (client as unknown as { post: unknown }).post = async () => response;
  }

  it('sends tools with an input_schema and no type wrapper', async () => {
    const captured: Record<string, unknown>[] = [];
    const c = client();
    (c as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push(body);
      return { model: 'claude', content: [], usage: {} };
    };

    await c.complete('go', { tools: [READ_TOOL] });

    const tools = captured[0]?.['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    // Anthropic takes a bare function object, not {type, function}.
    expect(tools[0]).not.toHaveProperty('type');
    expect(tools[0]?.['name']).toBe('read_file');
    expect(tools[0]?.['input_schema']).toBeDefined();
  });

  it('parses a tool_use block', async () => {
    const c = client();
    stub(c, {
      model: 'claude',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_file',
          input: { path: 'a.ts' },
        },
      ],
      usage: {},
      stop_reason: 'tool_use',
    });

    const result = await c.complete('go', { tools: [READ_TOOL] });

    expect(result.toolCalls).toEqual([
      { name: 'read_file', arguments: { path: 'a.ts' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('joins text blocks and tool calls together', async () => {
    const c = client();
    stub(c, {
      model: 'claude',
      content: [
        { type: 'text', text: 'Let me look. ' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
        { type: 'text', text: 'Done.' },
      ],
      usage: {},
    });

    const result = await c.complete('go', { tools: [READ_TOOL] });

    expect(result.content).toBe('Let me look. Done.');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('sends a tool result as a user turn with tool_result', async () => {
    const captured: Record<string, unknown>[] = [];
    const c = client();
    (c as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push(body);
      return { model: 'claude', content: [], usage: {} };
    };

    await c.complete('x', {
      messages: [
        { role: 'user', content: 'read a.ts' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }],
        },
        {
          role: 'tool',
          content: 'export const a = 1;',
          name: 'read_file',
          toolCallId: 'toolu_1',
        },
      ],
      tools: [READ_TOOL],
    });

    const messages = captured[0]?.['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);

    // A `tool` role is rejected by the API; it must be a user turn.
    expect(messages[2]?.['role']).toBe('user');
    const blocks = messages[2]?.['content'] as Array<Record<string, unknown>>;
    expect(blocks[0]?.['type']).toBe('tool_result');
    expect(blocks[0]?.['tool_use_id']).toBe('toolu_1');
  });

  it('lifts a system message out of the message array', async () => {
    const captured: Record<string, unknown>[] = [];
    const c = client();
    (c as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push(body);
      return { model: 'claude', content: [], usage: {} };
    };

    await c.complete('x', {
      messages: [
        { role: 'system', content: 'be careful' },
        { role: 'user', content: 'hi' },
      ],
    });

    const messages = captured[0]?.['messages'] as Array<Record<string, unknown>>;
    expect(messages.every((m) => m['role'] !== 'system')).toBe(true);
  });

  it('merges consecutive same-role turns', async () => {
    // Strict alternation is required. A real sequence is user, assistant with
    // two tool calls, then two tool results which are both user turns, so the
    // merge is what keeps that valid.
    const captured: Record<string, unknown>[] = [];
    const c = client();
    (c as unknown as { post: unknown }).post = async (
      _p: string,
      body: Record<string, unknown>,
    ) => {
      captured.push(body);
      return { model: 'claude', content: [], usage: {} };
    };

    await c.complete('x', {
      messages: [
        { role: 'user', content: 'read both' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'read_file', arguments: { path: 'a' } },
            { name: 'read_file', arguments: { path: 'b' } },
          ],
        },
        { role: 'tool', content: 'a', name: 'read_file', toolCallId: 't1' },
        { role: 'tool', content: 'b', name: 'read_file', toolCallId: 't2' },
      ],
    });

    const messages = captured[0]?.['messages'] as Array<Record<string, unknown>>;
    expect(messages.map((m) => m['role'])).toEqual(['user', 'assistant', 'user']);

    // Both results end up in one user turn, which is what the API accepts.
    const blocks = messages[2]?.['content'] as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b['tool_use_id'])).toEqual(['t1', 't2']);
  });
});

describe('toOpenAITool', () => {
  it('wraps a tool in the type/function envelope', () => {
    expect(toOpenAITool(READ_TOOL)).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file.',
        parameters: READ_TOOL.parameters,
      },
    });
  });
});

describe('stubFetch helper', () => {
  it('records what was sent', async () => {
    const captured: Captured[] = [];
    await stubFetch(captured, { ok: true })(  'http://x', { body: '{"a":1}' });
    expect(captured[0]?.body).toEqual({ a: 1 });
  });
});