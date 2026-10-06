import { describe, expect, it } from 'vitest';

import type { ConversationMessage } from '@gearvane/core';

import { flattenToolHistory, switchModelContext } from '../src/context/switch.js';

/**
 * Switching models mid-session keeps context by design: the transcript is
 * provider-agnostic, so it is re-trimmed to the new model's window and
 * flattened when the new model cannot tool-call. These tests pin that
 * contract once, as the plan asks.
 */

function history(): ConversationMessage[] {
  return [
    { role: 'user', content: 'fix the login bug' },
    {
      role: 'assistant',
      content: 'I will read the file first.',
      toolCalls: [{ name: 'read_file', arguments: { path: 'src/auth.ts' } }],
      toolCallId: 'call_0',
    },
    {
      role: 'tool',
      content: 'export function login() { return true; }',
      toolCallId: 'call_0',
      name: 'read_file',
    },
    { role: 'assistant', content: 'Fixed.', toolCalls: [], toolCallId: 'call_1' },
  ];
}

describe('flattenToolHistory', () => {
  it('flattens tool calls into the assistant prose and results into user turns', () => {
    const flat = flattenToolHistory(history());
    expect(flat).toHaveLength(4);

    const assistant = flat[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.toolCalls).toBeUndefined();
    expect(assistant?.content).toContain('I will read the file first.');
    expect(assistant?.content).toContain('Called read_file');
    expect(assistant?.content).toContain('src/auth.ts');

    const result = flat[2];
    expect(result?.role).toBe('user');
    expect(result?.toolCallId).toBeUndefined();
    expect(result?.content).toContain('Result of read_file');
    expect(result?.content).toContain('export function login()');
  });

  it('leaves a history without tool calls untouched', () => {
    const plain: ConversationMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(flattenToolHistory(plain)).toEqual(plain);
  });
});

describe('switchModelContext', () => {
  it('keeps the whole history when it fits the new window', () => {
    const result = switchModelContext(history(), { contextWindow: 4096, toolCalling: 'native' });
    expect(result.messages).toHaveLength(4);
    expect(result.droppedMessages).toBe(0);
    expect(result.flattened).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('re-trims to the smaller window of the new model', () => {
    // A tiny window forces a drop; the protected head (system + first user)
    // always survives.
    const result = switchModelContext(history(), {
      contextWindow: 64,
      toolCalling: 'native',
      reserveForOutput: 16,
    });
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages[0]?.content).toBe('fix the login bug');
  });

  it('flattens tool history for a model that cannot tool-call', () => {
    const result = switchModelContext(history(), { contextWindow: 4096, toolCalling: 'none' });
    expect(result.flattened).toBe(true);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false);
    expect(result.messages.some((m) => m.toolCalls?.length)).toBe(false);
  });

  it('does not flatten for a tool-calling model', () => {
    const result = switchModelContext(history(), { contextWindow: 4096, toolCalling: 'prompted' });
    expect(result.flattened).toBe(false);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('does not mutate the input history', () => {
    const input = history();
    const before = JSON.stringify(input);
    switchModelContext(input, { contextWindow: 32, toolCalling: 'none' });
    expect(JSON.stringify(input)).toBe(before);
  });
});
