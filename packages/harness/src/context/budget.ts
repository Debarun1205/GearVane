/**
 * Token estimation and context budgeting.
 *
 * ## Why this is an estimate
 *
 * Counting tokens properly means running a tokenizer, which means either a
 * dependency or shipping model vocabulary. Core has neither by design, so this
 * uses the widely used heuristic of roughly four characters per token.
 *
 * That heuristic is wrong in both directions. Code is denser than prose and
 * tokenizes worse; JSON and file paths tokenize badly. A model name costs far
 * more tokens than its length suggests.
 *
 * So the estimate is treated as an estimate everywhere: budgets carry a safety
 * margin, the caller is told when a count is a guess, and nothing here decides
 * that a request definitely fits. It decides that a request *probably* fits,
 * with room to be wrong. An undercount that overflows a context window costs a
 * failed request and a retry; an exact-but-slow tokenizer on every turn would
 * cost throughput on every request.
 */

import type { ConversationMessage } from '@waypoint/core';

/** Characters per token. The commonly cited rule of thumb for English text. */
export const CHARS_PER_TOKEN = 4;

/**
 * Safety margin applied to every budget.
 *
 * The estimate runs low more often than high, so a budget equal to the
 * advertised window would overflow on real traffic. Twelve percent back is
 * enough to absorb the normal error without meaningfully reducing what fits.
 */
export const SAFETY_MARGIN = 0.88;

/**
 * Floor on the estimate for a non-empty string.
 *
 * Anything costs something. Returning zero for a short string would let an
 * unbounded number of tiny messages accumulate.
 */
const MIN_TOKENS = 1;

/** Per-message overhead for role and framing tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Rough cost of a tool schema once rendered into the request. */
export const TOOL_SCHEMA_TOKENS = 80;

export function estimateTokens(text: string): number {
  if (text === '') return 0;
  return Math.max(MIN_TOKENS, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Estimate one message, including its framing. */
export function estimateMessageTokens(message: ConversationMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);

  if (message.role === 'assistant' && message.toolCalls?.length) {
    // Tool call arguments are the expensive part of an assistant turn, and they
    // are frequently file paths and JSON.
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }

  if (message.name) total += estimateTokens(message.name);

  return total;
}

export function estimateConversationTokens(
  messages: readonly ConversationMessage[],
): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/** What the loop is allowed to spend on one request. */
export interface ContextBudget {
  /** The provider's advertised context window. */
  contextWindow: number;

  /** Tokens reserved for the completion itself. */
  reserveForOutput: number;

  /** System prompt and tool schemas, counted outside the history. */
  overheadTokens?: number;
}

/** Tokens available for conversation history. */
export function availableForHistory(budget: ContextBudget): number {
  const usable = budget.contextWindow * SAFETY_MARGIN;
  const overhead = budget.overheadTokens ?? 0;
  return Math.max(0, Math.floor(usable - budget.reserveForOutput - overhead));
}

export interface FitResult {
  fits: boolean;
  estimatedTokens: number;
  available: number;
  /** Messages that must be dropped for the history to fit. */
  overflowMessages: number;
}

export function checkFit(
  messages: readonly ConversationMessage[],
  budget: ContextBudget,
): FitResult {
  const available = availableForHistory(budget);
  const estimatedTokens = estimateConversationTokens(messages);

  if (estimatedTokens <= available) {
    return {
      fits: true,
      estimatedTokens,
      available,
      overflowMessages: 0,
    };
  }

  // How many messages trimming would actually have to discard. This is the
  // droppable region, not everything outside the protected head: a system
  // prompt and the original task sit outside it and are never dropped, so
  // counting them as "overflow" would report a number no trimmer could reach.
  const droppable = messages.length - oldestRemovableIndex(messages);

  return {
    fits: false,
    estimatedTokens,
    available,
    overflowMessages: droppable,
  };
}

/**
 * The earliest index that may be dropped.
 *
 * A tool result is only meaningful when the assistant turn that requested it is
 * still present. Dropping one and keeping the other produces a request the
 * provider rejects outright, which is a worse outcome than sending a long one:
 * the whole turn fails instead of losing some history.
 *
 * So the window always starts on an assistant turn, and extends past any
 * results belonging to it.
 */
/**
 * The prefix that is never dropped: leading system messages plus the first
 * user message, which is the instruction the run is answering.
 */
export function protectedHead(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  const head: ConversationMessage[] = [];
  let sawUser = false;

  for (const message of messages) {
    if (!sawUser && message.role === 'system') {
      head.push(message);
      continue;
    }
    if (!sawUser && message.role === 'user') {
      head.push(message);
      sawUser = true;
      continue;
    }
    break;
  }

  return head;
}

/**
 * The first index that may be dropped.
 *
 * Always at or after the end of the protected head, and never in the middle of
 * an assistant turn and the tool results belonging to it: a result without
 * the call that produced it makes the whole request invalid, which is worse
 * than sending too much.
 */
export function oldestRemovableIndex(
  messages: readonly ConversationMessage[],
): number {
  const headEnd = protectedHead(messages).length;

  // Never start on a tool result.
  let index = headEnd;
  while (index < messages.length && messages[index]?.role === 'tool') {
    index += 1;
  }

  // If that lands on an assistant turn, keep it with its results.
  if (messages[index]?.role === 'assistant') {
    index += 1;
    while (index < messages.length && messages[index]?.role === 'tool') {
      index += 1;
    }
  }

  return index;
}

/**
 * Trim history to fit, dropping the oldest complete exchanges.
 *
 * Returns a new array. The caller's history is not mutated, because the loop
 * keeps the full history for reporting even after the request has been
 * trimmed.
 */
export function trimToFit(
  messages: readonly ConversationMessage[],
  budget: ContextBudget,
): ConversationMessage[] {
  if (checkFit(messages, budget).fits) return [...messages];

  const head = protectedHead(messages);
  let body = messages.slice(head.length);

  // Drop one exchange at a time from the front of the body. Batched removal
  // would be faster but would discard more than necessary, and recent history
  // is the most valuable thing in the window.
  while (body.length > 0) {
    body = body.slice(1);

    // If the new head is a tool result, its assistant turn went with the drop.
    // Drop the results too rather than sending an orphaned pair.
    while (body[0]?.role === 'tool') {
      body = body.slice(1);
    }

    const candidate = [...head, ...body];
    if (checkFit(candidate, budget).fits) return candidate;
  }

  // Nothing in the body could be dropped and it still does not fit. The head
  // is the floor: it is the instruction and cannot go.
  return head;
}

/** What a compaction pass did, for logging and for the caller. */
export interface CompactionResult {
  messages: ConversationMessage[];
  droppedMessages: number;
  /** True when history was dropped and nothing replaced it. */
  lossy: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export interface CompactionOptions extends ContextBudget {
  /**
   * Summarise dropped history instead of discarding it.
   *
   * Optional because summarising costs a model call, and during a long agent
   * run that call is itself context. The summary is plain text in a user turn,
   * never a fabricated assistant or tool turn.
   */
  summarize?: (dropped: ConversationMessage[]) => Promise<string>;
}

/**
 * Make room for more work.
 *
 * Prefers summarising, falls back to dropping, and always reports which it
 * did. A caller that is not told whether history was summarised or discarded
 * cannot reason about what the model can still see.
 */
export async function compact(
  messages: readonly ConversationMessage[],
  options: CompactionOptions,
): Promise<CompactionResult> {
  const before = estimateConversationTokens(messages);

  if (checkFit(messages, options).fits) {
    return {
      messages: [...messages],
      droppedMessages: 0,
      lossy: false,
      estimatedTokensBefore: before,
      estimatedTokensAfter: before,
    };
  }

  const trimmed = trimToFit(messages, options);

  if (trimmed.length === messages.length) {
    // Nothing could be dropped and it still does not fit. Only a summary can
    // help, and it cannot if none is available.
    if (!options.summarize) {
      return {
        messages: [...trimmed],
        droppedMessages: 0,
        lossy: false,
        estimatedTokensBefore: before,
        estimatedTokensAfter: estimateConversationTokens(trimmed),
      };
    }
  }

  if (!options.summarize) {
    return {
      messages: trimmed,
      droppedMessages: messages.length - trimmed.length,
      lossy: trimmed.length < messages.length,
      estimatedTokensBefore: before,
      estimatedTokensAfter: estimateConversationTokens(trimmed),
    };
  }

  // Split the trimmed history into the part worth keeping verbatim and the
  // part worth summarising.
  //
  // A summary only earns its cost if it replaces something substantial, and it
  // must not crowd out the recent history the model actually needs to
  // continue. So the tail is filled first, up to the budget, and whatever was
  // pushed out of the window is what gets summarised.
  const trimmedHead = protectedHead(messages);
  const trimmedBody = trimmed.slice(trimmedHead.length);
  const bodyStart = oldestRemovableIndex(messages);

  let keep = trimmedBody.length;
  while (keep > 0 && !checkFit([...trimmedHead, ...trimmedBody.slice(0, keep)], options).fits) {
    keep -= 1;
  }

  const tail = trimmedBody.slice(trimmedBody.length - keep);
  const dropped = messages.slice(bodyStart, messages.length - tail.length);

  if (dropped.length === 0) {
    // Nothing was pushed out of the window, so there is nothing to summarise.
    // Reporting zero rather than inventing a summary keeps the caller honest
    // about whether it paid for a model call.
    return {
      messages: trimmed,
      droppedMessages: 0,
      lossy: false,
      estimatedTokensBefore: before,
      estimatedTokensAfter: estimateConversationTokens(trimmed),
    };
  }

  let summary: string;
  try {
    summary = await options.summarize(dropped);
  } catch {
    // A failed summary must not lose the history silently. Returning the
    // trimmed history is worse for context but better than an exception
    // escaping into the loop.
    return {
      messages: trimmed,
      droppedMessages: messages.length - trimmed.length,
      lossy: true,
      estimatedTokensBefore: before,
      estimatedTokensAfter: estimateConversationTokens(trimmed),
    };
  }

  // The summary is a user turn. Inventing an assistant turn to carry it would
  // misrepresent what happened, and inserting a tool result without its call
  // would produce a request the provider rejects.
  const summaryMessage: ConversationMessage = {
    role: 'user',
    content: `Summary of earlier work that no longer fits in context:\n\n${summary}`,
  };

  const result = [...trimmedHead, summaryMessage, ...tail];

  return {
    messages: result,
    droppedMessages: dropped.length,
    lossy: true,
    estimatedTokensBefore: before,
    estimatedTokensAfter: estimateConversationTokens(result),
  };
}