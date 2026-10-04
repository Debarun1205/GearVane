import type { ConversationMessage } from '@gearvane/core';
import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN,
  SAFETY_MARGIN,
  availableForHistory,
  checkFit,
  compact,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  oldestRemovableIndex,
  protectedHead,
  trimToFit,
  type ContextBudget,
} from '../src/context/budget.js';

/**
 * Context budgeting tests.
 *
 * The property that matters most is not arithmetic, it is structural: a
 * trimmed history must never contain a tool result whose assistant turn has
 * been dropped, because providers reject the whole request rather than
 * ignoring the orphan. Several tests below exist purely to pin that.
 */

const BUDGET: ContextBudget = {
  contextWindow: 8000,
  reserveForOutput: 1000,
};

function user(content: string): ConversationMessage {
  return { role: 'user', content };
}

function assistant(content: string): ConversationMessage {
  return { role: 'assistant', content };
}

function assistantToolCall(name: string, args: Record<string, unknown>): ConversationMessage {
  return { role: 'assistant', content: '', toolCalls: [{ name, arguments: args }] };
}

function toolResult(content: string, name = 'read_file'): ConversationMessage {
  return { role: 'tool', content, name, toolCallId: 'call_0' };
}

describe('token estimation', () => {
  it('returns zero for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('never returns zero for a non-empty string', () => {
    // Otherwise an unbounded number of tiny messages would accumulate for free.
    expect(estimateTokens('x')).toBeGreaterThan(0);
  });

  it('scales with length', () => {
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(
      estimateTokens('a'.repeat(40)),
    );
  });

  it('uses the documented characters-per-token ratio', () => {
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN * 3))).toBe(3);
  });

  it('counts tool call arguments, which are the expensive part', () => {
    const withCall = estimateMessageTokens(
      assistantToolCall('write_file', { path: 'a'.repeat(200), content: 'b'.repeat(400) }),
    );
    const without = estimateMessageTokens(assistant(''));

    expect(withCall).toBeGreaterThan(without + 50);
  });

  it('adds per-message overhead', () => {
    expect(estimateMessageTokens(assistant(''))).toBeGreaterThan(0);
  });

  it('sums across a conversation', () => {
    const messages = [user('one'), assistant('two'), user('three')];
    const total = estimateConversationTokens(messages);

    expect(total).toBeGreaterThan(
      estimateMessageTokens(messages[0] as ConversationMessage),
    );
  });

  it('handles an empty conversation', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });
});

/**
 * Exchanges of roughly 250 tokens each.
 *
 * Starts with an explicit task message, because the first user turn is
 * structurally protected: trimming never drops it, so a fixture whose first
 * user message is also labelled `old-0` would never see it removed and the
 * "oldest is dropped" assertion would be meaningless.
 */
function exchanges(count: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [user('THE ORIGINAL TASK')];
  for (let index = 0; index < count; index += 1) {
    messages.push(user(`step-${index} ${'x'.repeat(500)}`));
    messages.push(assistant(`reply-${index} ${'y'.repeat(500)}`));
  }
  return messages;
}

/** Comfortably inside BUDGET. */
function fittingConversation(): ConversationMessage[] {
  return exchanges(20);
}

/** Comfortably past BUDGET. */
function oversizedConversation(): ConversationMessage[] {
  return exchanges(40);
}

describe('available budget', () => {
  it('applies the safety margin', () => {
    const raw = availableForHistory({ contextWindow: 10000, reserveForOutput: 0 });
    expect(raw).toBe(Math.floor(10000 * SAFETY_MARGIN));
  });

  it('reserves room for the completion', () => {
    const withReserve = availableForHistory({
      contextWindow: 8000,
      reserveForOutput: 2000,
    });
    const without = availableForHistory({
      contextWindow: 8000,
      reserveForOutput: 0,
    });

    expect(without - withReserve).toBe(2000);
  });

  it('subtracts overhead', () => {
    const base = availableForHistory({
      contextWindow: 8000,
      reserveForOutput: 0,
    });
    const withOverhead = availableForHistory({
      contextWindow: 8000,
      reserveForOutput: 0,
      overheadTokens: 500,
    });

    expect(base - withOverhead).toBe(500);
  });

  it('never goes negative', () => {
    const impossible = availableForHistory({
      contextWindow: 100,
      reserveForOutput: 10_000,
    });
    expect(impossible).toBe(0);
  });
});

describe('checking whether history fits', () => {
  it('accepts a short conversation', () => {
    const result = checkFit([user('hello')], BUDGET);
    expect(result.fits).toBe(true);
    expect(result.overflowMessages).toBe(0);
  });

  it('rejects an oversized conversation', () => {
    const huge = [user('x'.repeat(200_000))];
    const result = checkFit(huge, BUDGET);

    expect(result.fits).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(result.available);
  });

  it('reports how much can actually be dropped', () => {
    // A single oversized user turn is the protected head, so there is nothing
    // a trimmer could remove. Reporting it as droppable would promise a
    // reduction that cannot happen.
    const onlyHead = [user('x'.repeat(200_000))];
    expect(checkFit(onlyHead, BUDGET).fits).toBe(false);
    expect(checkFit(onlyHead, BUDGET).overflowMessages).toBe(0);
  });

  it('counts droppable history when there is some', () => {
    const result = checkFit(oversizedConversation(), BUDGET);
    expect(result.fits).toBe(false);
    expect(result.overflowMessages).toBeGreaterThan(0);
  });

  it('reports no overflow for an empty conversation', () => {
    expect(checkFit([], BUDGET).fits).toBe(true);
  });
});

describe('protecting the head of the conversation', () => {
  it('protects the system prompt and the original task', () => {
    const head = protectedHead([
      { role: 'system', content: 'you are helpful' },
      user('do the task'),
      assistant('starting'),
    ]);

    expect(head.map((m) => m.role)).toEqual(['system', 'user']);
    expect(head[1]?.content).toBe('do the task');
  });

  it('protects only one user turn', () => {
    // Everything after the first user message is history, however much of it
    // sits before the first assistant reply.
    const head = protectedHead([
      user('the task'),
      user('and also this'),
      assistant('ok'),
    ]);
    expect(head).toHaveLength(1);
  });

  it('starts removal after the protected head', () => {
    const messages = [
      { role: 'system', content: 'you are helpful' },
      user('do the task'),
      assistant('starting'),
    ];
    expect(oldestRemovableIndex(messages)).toBe(messages.length);
  });

  it('never starts removal on a tool result', () => {
    // Starting there would drop the assistant turn and orphan the result.
    const messages = [
      user('task'),
      assistantToolCall('read_file', { path: 'a' }),
      toolResult('contents'),
      assistant('done'),
    ];
    expect(oldestRemovableIndex(messages)).toBe(3);
  });

  it('returns the full length when there is nothing droppable', () => {
    const messages = [{ role: 'system', content: 'x' }, user('y')];
    expect(oldestRemovableIndex(messages)).toBe(messages.length);
  });

  it('keeps the system prompt', () => {
    const messages: ConversationMessage[] = [
      { role: 'system', content: 'you are helpful' },
      user('a'.repeat(100_000)),
      assistant('b'.repeat(100_000)),
    ];

    const trimmed = trimToFit(messages, BUDGET);
    expect(trimmed[0]?.role).toBe('system');
  });

  it('keeps the original task', () => {
    const messages: ConversationMessage[] = [
      user('the original task'),
      assistant('x'.repeat(200_000)),
    ];

    const trimmed = trimToFit(messages, BUDGET);
    expect(trimmed.some((m) => m.content === 'the original task')).toBe(true);
  });
});

describe('trimming to fit', () => {
  it('returns a new array even when nothing is trimmed', () => {
    const messages = [user('hello'), assistant('hi')];
    const trimmed = trimToFit(messages, BUDGET);

    expect(trimmed).toEqual(messages);
    // A copy, so a caller mutating the result cannot corrupt the loop's
    // history for reporting.
    expect(trimmed).not.toBe(messages);
  });

  it('does not mutate the input', () => {
    const messages = [user('a'.repeat(200_000)), assistant('b'.repeat(200_000))];
    const snapshot = messages.map((m) => ({ ...m }));

    trimToFit(messages, BUDGET);
    expect(messages).toEqual(snapshot);
  });

  it('drops enough to fit', () => {
    const trimmed = trimToFit(oversizedConversation(), BUDGET);

    expect(trimmed.length).toBeLessThan(80);
    expect(checkFit(trimmed, BUDGET).fits).toBe(true);
  });
});

describe('trimming oversized conversations', () => {
  it('drops the oldest exchanges first', () => {
    const messages = oversizedConversation();

    // Asserted up front because an earlier version of this test built a
    // conversation that fit, so nothing was dropped and it asserted on
    // content that had never been removed.
    expect(checkFit(messages, BUDGET).fits).toBe(false);

    const trimmed = trimToFit(messages, BUDGET);

    expect(trimmed.length).toBeLessThan(messages.length);
    expect(checkFit(trimmed, BUDGET).fits).toBe(true);

    const kept = trimmed.map((m) => m.content).join(' ');
    expect(kept).toContain('reply-39');
    expect(kept).not.toContain('step-0 ');
    expect(kept).not.toContain('reply-0 ');
  });

  it('never drops the original task', () => {
    // The first user turn is the instruction the whole run is answering.
    const trimmed = trimToFit(oversizedConversation(), BUDGET);
    expect(trimmed.map((m) => m.content)).toContain('THE ORIGINAL TASK');
  });

  it('leaves a fitting conversation untouched', () => {
    const messages = fittingConversation();

    expect(checkFit(messages, BUDGET).fits).toBe(true);
    expect(trimToFit(messages, BUDGET)).toEqual(messages);
  });

  /**
   * The structural property. A tool result whose assistant turn was dropped
   * makes the whole request fail, not just lose a little history.
   */
  it('never leaves a tool result without its assistant turn', () => {
    const messages: ConversationMessage[] = [user('the task')];
    for (let index = 0; index < 12; index += 1) {
      messages.push(assistantToolCall('read_file', { path: `f${index}.txt` }));
      messages.push(
        toolResult(`contents of f${index}.txt ${'z'.repeat(400)}`),
      );
    }
    messages.push(assistant('done'));

    const trimmed = trimToFit(messages, BUDGET);

    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index]?.role !== 'tool') continue;

      // The nearest preceding non-tool message must be the assistant turn
      // that requested it.
      let previous = index - 1;
      while (previous >= 0 && trimmed[previous]?.role === 'tool') previous -= 1;

      expect(
        trimmed[previous]?.role,
        `orphaned tool result at index ${index}`,
      ).toBe('assistant');
    }
  });

  it('keeps the pairing when trimming mid-conversation', () => {
    const messages: ConversationMessage[] = [user('task')];
    for (let index = 0; index < 15; index += 1) {
      messages.push(assistantToolCall('read_file', { path: `f${index}` }));
      messages.push(toolResult(`content ${index} ${'q'.repeat(600)}`));
    }

    const trimmed = trimToFit(messages, BUDGET);
    const assistantTurns = trimmed.filter(
      (m) => m.role === 'assistant' && m.toolCalls?.length,
    ).length;
    const results = trimmed.filter((m) => m.role === 'tool').length;

    // Whatever survives must be balanced.
    expect(results).toBe(assistantTurns);
  });

  it('still fits after trimming a tool-heavy conversation', () => {
    const messages: ConversationMessage[] = [user('task')];
    for (let index = 0; index < 20; index += 1) {
      messages.push(assistantToolCall('read_file', { path: `f${index}` }));
      messages.push(toolResult(`content ${index} ${'q'.repeat(900)}`));
    }

    const trimmed = trimToFit(messages, BUDGET);
    expect(checkFit(trimmed, BUDGET).fits).toBe(true);
  });
});

describe('compaction', () => {
  function longConversation(): ConversationMessage[] {
    const messages: ConversationMessage[] = [user('the task')];
    for (let index = 0; index < 30; index += 1) {
      messages.push(user(`step ${index} ${'x'.repeat(600)}`));
      messages.push(assistant(`reply ${index} ${'y'.repeat(600)}`));
    }
    return messages;
  }

  it('leaves a fitting conversation alone', async () => {
    const messages = [user('hello')];
    const result = await compact(messages, BUDGET);

    expect(result.messages).toEqual(messages);
    expect(result.droppedMessages).toBe(0);
    expect(result.lossy).toBe(false);
  });

  it('drops rather than summarising when no summariser is given', async () => {
    const messages = longConversation();
    const result = await compact(messages, BUDGET);

    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.lossy).toBe(true);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
  });

  it('does not mutate the input', async () => {
    const messages = longConversation();
    const snapshot = messages.map((m) => ({ ...m }));

    await compact(messages, BUDGET);
    expect(messages).toEqual(snapshot);
  });

  it('summarises when a summariser is available', async () => {
    const messages = longConversation();
    let summarised: ConversationMessage[] = [];

    const result = await compact(messages, {
      ...BUDGET,
      summarize: async (dropped) => {
        summarised = dropped;
        return 'Earlier steps edited three files and fixed a lint error.';
      },
    });

    expect(summarised.length).toBeGreaterThan(0);
    expect(result.lossy).toBe(true);
    expect(result.messages.some((m) => m.content.includes('Summary of earlier work'))).toBe(true);
  });

  it('carries the summary in a user turn, never a fabricated turn', async () => {
    // Inventing an assistant turn would misrepresent what happened; inserting
    // a tool result without its call makes the request invalid.
    const result = await compact(longConversation(), {
      ...BUDGET,
      summarize: async () => 'a summary',
    });

    const summaryIndex = result.messages.findIndex((m) =>
      m.content.includes('Summary of earlier work'),
    );
    const summary = result.messages[summaryIndex];

    expect(summary?.role).toBe('user');
    expect(summary?.toolCalls).toBeUndefined();
    expect(summary?.toolCallId).toBeUndefined();
  });

  it('keeps recent history after summarising', async () => {
    const result = await compact(longConversation(), {
      ...BUDGET,
      summarize: async () => 'summary',
    });

    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toContain('reply 29');
  });

  it('fits after compacting', async () => {
    const result = await compact(longConversation(), {
      ...BUDGET,
      summarize: async () => 'a reasonably short summary of the earlier work',
    });

    expect(checkFit(result.messages, BUDGET).fits).toBe(true);
  });

  it('falls back to trimming when summarising fails', async () => {
    // A thrown summary must not lose history silently, and must not escape
    // into the loop as an exception.
    const messages = longConversation();
    const result = await compact(messages, {
      ...BUDGET,
      summarize: async () => {
        throw new Error('model unavailable');
      },
    });

    expect(result.lossy).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(checkFit(result.messages, BUDGET).fits).toBe(true);
  });

  it('handles an empty conversation', async () => {
    const result = await compact([], BUDGET);
    expect(result.messages).toEqual([]);
    expect(result.droppedMessages).toBe(0);
  });

  it('preserves tool pairing after compacting', async () => {
    const messages: ConversationMessage[] = [user('task')];
    for (let index = 0; index < 20; index += 1) {
      messages.push(assistantToolCall('read_file', { path: `f${index}` }));
      messages.push(toolResult(`content ${index} ${'q'.repeat(900)}`));
    }

    const result = await compact(messages, {
      ...BUDGET,
      summarize: async () => 'summary',
    });

    for (let index = 0; index < result.messages.length; index += 1) {
      if (result.messages[index]?.role !== 'tool') continue;
      let previous = index - 1;
      while (previous >= 0 && result.messages[previous]?.role === 'tool') previous -= 1;
      expect(result.messages[previous]?.role).toBe('assistant');
    }
  });
});

describe('what this module claims about itself', () => {
  it('says the count is an estimate', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(
      new URL('../src/context/budget.ts', import.meta.url),
      'utf8',
    );
    const source = raw.replace(/\s+/g, ' ');

    // An exact-looking token count would be a lie, and the loop would size a
    // budget against a number that is wrong in both directions.
    expect(source).toMatch(/this is an estimate/i);
    expect(source).toMatch(/four characters per token/i);
  });
});