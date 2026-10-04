/**
 * Inline ghost-text completions from a small local model.
 *
 * Everything in here is either pure or takes its I/O as arguments, so it can
 * be unit tested in Node. The Monaco provider registration itself lives in
 * ide-view.ts and is guarded at the source level, because it needs a real
 * editor.
 *
 * ## Why local only
 *
 * A completion fires on nearly every keystroke. Against a hosted API that is
 * a request per keystroke billed to the user with network latency on each
 * one; against localhost it is free and fast. So this resolves only local-tier
 * servers (Ollama and friends) and stays off when none is configured, rather
 * than offering a hosted option that would be unpleasant to actually use.
 */

import type { GearVaneConfig } from '@gearvane/core';

/** A local server the editor can ask for completions. */
export interface InlineModel {
  baseUrl: string;
  model: string;
}

/**
 * Local server names, in preference order.
 *
 * Ollama first because its `/api/generate` endpoint speaks fill-in-the-middle
 * natively via `suffix`. The rest speak the same endpoint shape through
 * OpenAI-compatible servers... except they do not: only Ollama gets the
 * generate endpoint. The others are resolved for their base URL and model,
 * and the request below still targets Ollama's path.
 *
 * That last sentence is doing real work: pointing this at LM Studio would
 * 404, because LM Studio has no /api/generate. So only Ollama is actually
 * supported today, and the list below says exactly that instead of implying
 * breadth that is not there.
 */
const LOCAL_GENERATE_SERVERS = new Set(['ollama']);

/**
 * Pick a completion model from the app config.
 *
 * First model of the first local-tier provider served by a supported server.
 * Returns undefined when there is nothing to ask, and the caller disables
 * ghost text rather than failing per keystroke.
 */
export function resolveInlineModel(config: GearVaneConfig): InlineModel | undefined {
  const providers = config.tiers?.local?.providers ?? [];
  for (const provider of providers) {
    const name = provider.name.toLowerCase().trim();
    if (!LOCAL_GENERATE_SERVERS.has(name)) continue;
    const model = provider.models[0];
    if (!model) continue;
    const baseUrl = (provider.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    return { baseUrl, model };
  }
  return undefined;
}

/** Minimum non-whitespace characters on the current line before asking. */
export const MIN_LINE_CHARS = 2;

/**
 * Whether the cursor position deserves a request.
 *
 * Fires on almost every keystroke by design — local is free — but not on an
 * empty line and not in the middle of whitespace, where a ghost would only
 * cover up the user's own indentation.
 */
export function shouldComplete(lineText: string): boolean {
  const trimmed = lineText.trim();
  if (trimmed.length < MIN_LINE_CHARS) return false;
  // Trailing whitespace means the user just hit space or tab: completing now
  // would suggest over their own indentation.
  if (/\s$/.test(lineText)) return false;
  return true;
}

export interface FimRequest {
  url: string;
  body: Record<string, unknown>;
}

/** Maximum tokens per ghost. Longer ghosts go stale before they are read. */
export const GHOST_MAX_TOKENS = 64;

/**
 * Build an Ollama fill-in-the-middle request.
 *
 * Prefix and suffix are capped: the model needs local context, not the whole
 * file, and every extra token is latency on every keystroke.
 */
export function buildFimRequest(
  inline: InlineModel,
  prefix: string,
  suffix: string,
): FimRequest {
  return {
    url: `${inline.baseUrl}/api/generate`,
    body: {
      model: inline.model,
      prompt: prefix.slice(-4000),
      suffix: suffix.slice(0, 2000),
      stream: false,
      options: {
        num_predict: GHOST_MAX_TOKENS,
        temperature: 0.2,
        stop: ['\n\n'],
      },
    },
  };
}

/**
 * Extract the ghost from an Ollama response.
 *
 * Leading whitespace is preserved: it is usually indentation, and stripping
 * it would misalign the suggestion. Trailing whitespace is noise.
 */
export function parseFimResponse(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const text = (data as Record<string, unknown>)['response'];
  if (typeof text !== 'string') return undefined;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Fetch one completion, throwing a short error the caller can count.
 *
 * Non-2xx becomes an Error carrying the status, not the body: the body of a
 * failed local request is usually an HTML error page nobody will read.
 */
export async function fetchCompletion(
  request: FimRequest,
  signal: AbortSignal,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return undefined;
    throw new Error(`local model unreachable: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new Error(`local model answered ${response.status}`);
  }

  return parseFimResponse(await response.json().catch(() => undefined));
}

/** Consecutive failures after which the provider gives up until remount. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Bounded cache keyed by the exact (prefix tail, suffix head) pair.
 *
 * Cursor movement invalidates naturally: a different pair is a different key.
 * The bound stops a long session from growing the map without limit.
 */
export class CompletionCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxEntries = 50) {}

  get(prefix: string, suffix: string): string | undefined {
    return this.entries.get(CompletionCache.key(prefix, suffix));
  }

  set(prefix: string, suffix: string, completion: string): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(CompletionCache.key(prefix, suffix), completion);
  }

  static key(prefix: string, suffix: string): string {
    return `${prefix.slice(-200)}\n---\n${suffix.slice(0, 100)}`;
  }

  get size(): number {
    return this.entries.size;
  }
}
