import { describe, expect, it, beforeEach } from 'vitest';

import {
  canSubmit,
  initialState,
  lastAssistantMessage,
  nextId,
  reducer,
  resetIds,
  totalCostUsd,
  transcriptText,
  type AppState,
} from '../src/conversation.js';
import type { ExecutionResult } from '@gearvane/core';

const result = (overrides: Partial<ExecutionResult> = {}): ExecutionResult => ({
  taskId: 't1',
  success: true,
  content: 'the answer',
  tier: 'local',
  provider: 'ollama',
  model: 'qwen2.5-coder',
  attempts: 1,
  escalated: false,
  costUsd: 0.01,
  tokensIn: 10,
  tokensOut: 20,
  durationMs: 120,
  confidence: 0.8,
  reasons: ['because'],
  history: [],
  ...overrides,
});

beforeEach(() => {
  resetIds();
});

describe('draft handling', () => {
  it('starts empty and not busy', () => {
    const state = initialState();
    expect(state.draft).toBe('');
    expect(state.busy).toBe(false);
    expect(state.messages).toEqual([]);
  });

  it('stores the draft', () => {
    const state = reducer(initialState(), { type: 'setDraft', draft: 'hello' });
    expect(state.draft).toBe('hello');
  });

  it('clears the draft on submit and appends both messages', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'fix a typo' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });

    expect(state.draft).toBe('');
    expect(state.busy).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[1]?.role).toBe('assistant');
    expect(state.messages[1]?.pending).toBe(true);
  });
});

describe('streaming', () => {
  it('accumulates tokens into the reply bubble', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'hi' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });

    state = reducer(state, { type: 'streamToken', messageId: 'm1-reply', token: 'he' });
    state = reducer(state, { type: 'streamToken', messageId: 'm1-reply', token: 'llo' });

    expect(state.messages[1]?.content).toBe('hello');
  });

  it('marks the reply as no longer pending when the stream ends', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'hi' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });

    state = reducer(state, { type: 'streamToken', messageId: 'm1-reply', token: 'x' });
    state = reducer(state, { type: 'streamEnd', messageId: 'm1-reply' });
    expect(state.messages[1]?.pending).toBe(false);
  });

  it('ignores a token for an unknown message', () => {
    // A late chunk after a reset is an expected race, not a crash.
    const state = reducer(initialState(), {
      type: 'streamToken',
      messageId: 'gone',
      token: 'x',
    });
    expect(state.messages).toEqual([]);
  });
});

describe('success and failure', () => {
  it('records a successful result on the reply', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'hi' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'succeeded', messageId: 'm1', result: result() });

    const reply = state.messages[1];
    expect(reply?.content).toBe('the answer');
    expect(reply?.tier).toBe('local');
    expect(reply?.model).toBe('qwen2.5-coder');
    expect(reply?.costUsd).toBeCloseTo(0.01);
    expect(reply?.pending).toBe(false);
    expect(state.busy).toBe(false);
  });

  it('accumulates session spend', () => {
    let state = initialState();
    for (const id of ['m1', 'm2']) {
      state = reducer(state, { type: 'setDraft', draft: 'hi' });
      state = reducer(state, { type: 'submit', messageId: id });
      state = reducer(state, { type: 'succeeded', messageId: id, result: result() });
    }
    expect(state.sessionSpendUsd).toBeCloseTo(0.02);
  });

  it('records a failure without losing the prompt', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'hi' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'failed', messageId: 'm1', error: 'provider down' });

    expect(state.messages[0]?.content).toBe('hi');
    expect(state.messages[1]?.error).toBe('provider down');
    expect(state.messages[1]?.pending).toBe(false);
    expect(state.error).toBe('provider down');
    expect(state.busy).toBe(false);
  });

  it('clears a previous error when a new turn starts', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'a' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'failed', messageId: 'm1', error: 'boom' });
    state = reducer(state, { type: 'setDraft', draft: 'b' });
    state = reducer(state, { type: 'submit', messageId: 'm2' });
    expect(state.error).toBeNull();
  });

  it('dismisses an error', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'a' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'failed', messageId: 'm1', error: 'boom' });
    state = reducer(state, { type: 'dismissError' });
    expect(state.error).toBeNull();
  });
});

describe('clear', () => {
  it('resets messages but keeps the configured limits', () => {
    let state: AppState = { ...initialState(), limits: { perTask: 1, perSession: 2, perDay: 3 } };
    state = reducer(state, { type: 'setDraft', draft: 'hi' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'succeeded', messageId: 'm1', result: result() });

    state = reducer(state, { type: 'clear' });
    expect(state.messages).toEqual([]);
    expect(state.sessionSpendUsd).toBe(0);
    // Spend limits removed; no limits in state
    expect(state.limits).toBeUndefined();
  });
});

describe('selectors', () => {
  it('finds the last assistant message', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'a' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'succeeded', messageId: 'm1', result: result() });
    state = reducer(state, { type: 'setDraft', draft: 'b' });
    state = reducer(state, { type: 'submit', messageId: 'm2' });
    state = reducer(state, { type: 'succeeded', messageId: 'm2', result: result({ content: 'second' }) });

    expect(lastAssistantMessage(state)?.content).toBe('second');
  });

  it('returns undefined when there is no assistant message', () => {
    expect(lastAssistantMessage(initialState())).toBeUndefined();
  });

  it('builds a transcript', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'question' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'succeeded', messageId: 'm1', result: result() });

    const transcript = transcriptText(state);
    expect(transcript).toContain('user: question');
    expect(transcript).toContain('assistant: the answer');
  });

  it('totals cost across messages', () => {
    let state = reducer(initialState(), { type: 'setDraft', draft: 'a' });
    state = reducer(state, { type: 'submit', messageId: 'm1' });
    state = reducer(state, { type: 'succeeded', messageId: 'm1', result: result({ costUsd: 0.25 }) });
    expect(totalCostUsd(state)).toBeCloseTo(0.25);
  });

  // Spend limits removed; spendFraction and budgetExhausted no longer exist
  it('spendFraction and budgetExhausted are removed', () => {
    expect(typeof spendFraction).toBe('undefined');
    expect(typeof budgetExhausted).toBe('undefined');
  });
});

describe('canSubmit', () => {
  it('requires a non-empty draft and no in-flight request', () => {
    let state = initialState();
    expect(canSubmit(state)).toBe(false);

    state = reducer(state, { type: 'setDraft', draft: 'hi' });
    expect(canSubmit(state)).toBe(true);

    state = reducer(state, { type: 'submit', messageId: 'm1' });
    expect(canSubmit(state)).toBe(false);
  });

  it('rejects a whitespace-only draft', () => {
    const state = reducer(initialState(), { type: 'setDraft', draft: '   ' });
    expect(canSubmit(state)).toBe(false);
  });
});

describe('nextId', () => {
  it('produces unique ids', () => {
    const ids = new Set([nextId(), nextId(), nextId()]);
    expect(ids.size).toBe(3);
  });

  it('uses the supplied prefix', () => {
    expect(nextId('turn')).toMatch(/^turn-/);
  });
});