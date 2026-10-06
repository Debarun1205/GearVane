/**
 * Switching a session to a different model without losing context.
 *
 * The transcript is owned by the harness and stored provider-agnostically
 * (ConversationMessage), so a switch never loses it: the same history is
 * re-trimmed to the new model's context window and, when the new model
 * cannot tool-call, flattened into plain text it can read.
 *
 * Tool-call dialect translation is not needed here: the stored history is
 * already dialect-neutral, and each provider client renders it into its own
 * dialect per request (OpenAI-style tool_calls, Anthropic tool_use blocks).
 */

import type { ConversationMessage } from '@gearvane/core';

import { estimateConversationTokens, trimToFit, type ContextBudget } from './budget.js';

/** How a model handles tool calls. Mirrors the catalog's toolCalling field. */
export type ToolCalling = 'native' | 'prompted' | 'none';

export interface ModelContextSpec {
  /** The new model's advertised context window. */
  contextWindow: number;
  toolCalling: ToolCalling;
  /** Tokens reserved for the completion. Defaults to 2048. */
  reserveForOutput?: number;
}

export interface SwitchResult {
  /** The history as the new model should see it. */
  messages: ConversationMessage[];
  /** Estimated tokens of the returned history, for the UI notice. */
  estimatedTokens: number;
  /** True when tool calls and results were flattened to plain text. */
  flattened: boolean;
  /** History messages dropped by the re-trim. */
  droppedMessages: number;
}

/**
 * Flatten tool calls and results into plain text.
 *
 * An assistant turn keeps its prose and gains a text rendering of the calls
 * it made; a tool result becomes a user turn carrying the output. A model
 * that cannot tool-call can still read what happened, and the request stays
 * valid — no orphaned tool results, which providers reject outright.
 */
export function flattenToolHistory(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls
        .map((call) => {
          let args: string;
          try {
            args = JSON.stringify(call.arguments);
          } catch {
            args = String(call.arguments);
          }
          return `Called ${call.name} with ${args}`;
        })
        .join('\n');
      out.push({
        ...message,
        content: message.content ? `${message.content}\n${calls}` : calls,
        toolCalls: undefined,
        toolCallId: undefined,
      });
      continue;
    }

    if (message.role === 'tool') {
      out.push({
        ...message,
        role: 'user',
        content: `Result of ${message.name ?? 'tool'}: ${message.content}`,
        toolCallId: undefined,
        name: undefined,
      });
      continue;
    }

    out.push(message);
  }

  return out;
}

/**
 * Re-trim a stored transcript for a new model.
 *
 * Pure: the input is not mutated. Flattening happens before trimming so a
 * tool-calling history squashed into prose still fits the new window.
 */
export function switchModelContext(
  messages: readonly ConversationMessage[],
  spec: ModelContextSpec,
): SwitchResult {
  const flattened = spec.toolCalling === 'none';
  const prepared = flattened ? flattenToolHistory(messages) : [...messages];

  const budget: ContextBudget = {
    contextWindow: spec.contextWindow,
    reserveForOutput: spec.reserveForOutput ?? 2048,
  };

  const trimmed = trimToFit(prepared, budget);

  return {
    messages: trimmed,
    estimatedTokens: estimateConversationTokens(trimmed),
    flattened,
    droppedMessages: prepared.length - trimmed.length,
  };
}
