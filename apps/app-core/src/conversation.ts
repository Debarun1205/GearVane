/**
 * Conversation state for the app.
 *
 * Deliberately free of Electron and DOM types so the same reducer drives
 * the desktop renderer, the Android webview, and the tests. The UI layer
 * subscribes and re-renders; it does not own the state.
 */

import type { ExecutionResult, Tier } from '@waypoint/core';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  at: number;
  /** Tier the router chose for this turn, when it was a model turn. */
  tier?: Tier;
  model?: string;
  confidence?: number;
  costUsd?: number;
  durationMs?: number;
  /** Set when the turn failed, so the UI can offer a retry. */
  error?: string;
  /** True while tokens are still arriving. */
  pending?: boolean;
}

export interface AppState {
  messages: Message[];
  /** Draft text in the composer. */
  draft: string;
  /** True while a request is in flight. */
  busy: boolean;
  sessionSpendUsd: number;
  limits: {
    perTask: number;
    perSession: number;
    perDay: number;
  };
  error: string | null;
}

export function initialState(): AppState {
  return {
    messages: [],
    draft: '',
    busy: false,
    sessionSpendUsd: 0,
    limits: { perTask: 5, perSession: 10, perDay: 50 },
    error: null,
  };
}

export type Action =
  | { type: 'setDraft'; draft: string }
  | { type: 'submit'; messageId: string }
  | { type: 'streamStart'; messageId: string }
  | { type: 'streamToken'; messageId: string; token: string }
  | { type: 'streamEnd'; messageId: string }
  | { type: 'succeeded'; messageId: string; result: ExecutionResult }
  | { type: 'failed'; messageId: string; error: string }
  | { type: 'setSpend'; spendUsd: number }
  | { type: 'dismissError' }
  | { type: 'clear' };

let counter = 0;

/** Monotonic id generator, so ids are unique without a uuid dependency. */
export function nextId(prefix = 'm'): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}

/** Test seam: reset the counter so ids are predictable. */
export function resetIds(): void {
  counter = 0;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'setDraft':
      return { ...state, draft: action.draft };

    case 'submit':
      // A new turn appends the user message and an empty assistant bubble
      // that streaming will fill in.
      return {
        ...state,
        busy: true,
        error: null,
        draft: '',
        messages: [
          ...state.messages,
          {
            id: action.messageId,
            role: 'user',
            content: state.draft,
            at: Date.now(),
          },
          {
            id: `${action.messageId}-reply`,
            role: 'assistant',
            content: '',
            at: Date.now(),
            pending: true,
          },
        ],
      };

    case 'streamStart':
      return patchMessage(state, action.messageId, { pending: true });

    case 'streamToken':
      return appendToMessage(state, action.messageId, action.token);

    case 'streamEnd':
      return patchMessage(state, action.messageId, { pending: false });

    case 'succeeded':
      return {
        ...patchMessage(state, `${action.messageId}-reply`, {
          content: action.result.content,
          pending: false,
          error: undefined,
          ...(action.result.tier ? { tier: action.result.tier } : {}),
          ...(action.result.model ? { model: action.result.model } : {}),
          confidence: action.result.confidence,
          costUsd: action.result.costUsd,
          durationMs: action.result.durationMs,
        }),
        busy: false,
        sessionSpendUsd: round(state.sessionSpendUsd + action.result.costUsd),
      };

    case 'failed':
      return {
        ...patchMessage(state, `${action.messageId}-reply`, {
          pending: false,
          error: action.error,
        }),
        busy: false,
        error: action.error,
      };

    case 'setSpend':
      return { ...state, sessionSpendUsd: action.spendUsd };

    case 'dismissError':
      return { ...state, error: null };

    case 'clear':
      return { ...initialState(), limits: state.limits };

    default:
      return state;
  }
}

function patchMessage(
  state: AppState,
  id: string,
  patch: Partial<Message>,
): AppState {
  let found = false;
  const messages = state.messages.map((message) => {
    if (message.id !== id) return message;
    found = true;
    return { ...message, ...patch };
  });

  // Silently ignoring an unknown id would hide a caller bug, so leave the
  // state untouched but do not throw: a late stream chunk after a reset is
  // an expected race.
  if (!found) return state;

  return { ...state, messages };
}

function appendToMessage(state: AppState, id: string, token: string): AppState {
  let found = false;
  const messages = state.messages.map((message) => {
    if (message.id !== id) return message;
    found = true;
    return { ...message, content: message.content + token };
  });

  if (!found) return state;
  return { ...state, messages };
}

// --- selectors --------------------------------------------------------------

export function lastAssistantMessage(state: AppState): Message | undefined {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

export function transcriptText(state: AppState): string {
  return state.messages
    .filter((message) => !message.pending || message.content.length > 0)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n');
}

export function totalCostUsd(state: AppState): number {
  return round(
    state.messages.reduce((sum, message) => sum + (message.costUsd ?? 0), 0),
  );
}

export function spendFraction(state: AppState): number {
  if (state.limits.perSession <= 0) return 1;
  return Math.min(state.sessionSpendUsd / state.limits.perSession, 1);
}

/** True when the session budget is exhausted and further requests will fail. */
export function budgetExhausted(state: AppState): boolean {
  return state.sessionSpendUsd >= state.limits.perSession;
}

export function canSubmit(state: AppState): boolean {
  return !state.busy && state.draft.trim().length > 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}