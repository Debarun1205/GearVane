/**
 * @waypoint/harness
 *
 * The agent layer that sits on top of @waypoint/core's routing engine.
 *
 * Status: partial. Workspace containment and the file tool layer are built.
 * The agent loop, command containment, context management, and sessions are
 * not, and docs/harness-architecture.md is the source of truth for that.
 */

export {
  ContainmentError,
  InvalidPathError,
  Workspace,
  isInside,
  type RealpathLike,
  type WorkspaceOptions,
} from './workspace/containment.js';

export {
  ToolArgumentError,
  failure,
  validateArgs,
  type JsonSchema,
  type JsonSchemaProperty,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from './tools/types.js';

export { ToolRegistry } from './tools/registry.js';

export {
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
  type CompactionOptions,
  type CompactionResult,
  type ContextBudget,
  type FitResult,
} from './context/budget.js';

import type {
  CompleteOptions,
  ConversationMessage,
  ToolDefinition,
} from '@waypoint/core';
import {
  compact,
  type CompactionResult,
  type ContextBudget,
} from './context/budget.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';

/**
 * What the agent loop needs from a model.
 *
 * Narrower than `ProviderClient` on purpose: the loop should be testable
 * without a network, and a stub that answers a fixed script is easier to
 * assert on than a mocked HTTP layer.
 */
export interface AgentModel {
  complete(
    prompt: string,
    options?: CompleteOptions,
  ): Promise<{
    content: string;
    finishReason: string;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    usage: { tokensIn: number; tokensOut: number };
  }>;
}

export interface AgentStep {
  /** 1-based iteration number. */
  iteration: number;
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  results: Array<{ name: string; ok: boolean; content: string }>;
  tokensIn: number;
  tokensOut: number;
}

export type StopReason =
  | 'completed'
  | 'max_iterations'
  | 'repeated_tool_call'
  | 'cancelled'
  | 'model_error';

export interface AgentResult {
  /** The model's final prose, when it stopped on its own. */
  content: string;
  stopReason: StopReason;
  iterations: number;
  steps: AgentStep[];
  tokensIn: number;
  tokensOut: number;
  /** Tools the model asked for that failed. Non-fatal, but worth surfacing. */
  failedToolCalls: Array<{ name: string; error: string }>;
  /**
   * Times history had to be compacted. Zero when a budget was supplied and
   * nothing overflowed, and when no budget was supplied at all.
   */
  compactions: number;
}

export interface AgentOptions {
  model: AgentModel;
  registry: ToolRegistry;

  /** Workspace and limits the tools run under. */
  context: ToolContext;

  /**
   * Token budget for the conversation.
   *
   * When set, history is trimmed before each request so it fits, and a
   * summariser can preserve the gist of what was dropped. Without it the loop
   * sends the full history every turn, which is fine for a short task and
   * fails with a context-length error on a long one.
   */
  contextBudget?: ContextBudget;

  /** Ceiling on loop iterations. The real stops are below. */
  maxIterations?: number;
  /**
   * How many identical tool calls in a row count as a stuck loop.
   *
   * A model retrying the same failing call forever is the common failure mode
   * and is not caught by an iteration ceiling alone, because each iteration
   * looks like progress.
   */
  repeatLimit?: number;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;

  /**
   * Summarise history that had to be dropped.
   *
   * Costs a model call, so it runs only when something was actually pushed
   * out of the window. The summary is carried as a user turn: fabricating an
   * assistant turn would misrepresent what happened, and inserting a tool
   * result without its call produces a request the provider rejects.
   */
  summarize?: (dropped: ConversationMessage[]) => Promise<string>;

  /** Called after every iteration, for progress display. */
  onStep?: (step: AgentStep) => void;

  /** Called when history is trimmed, so a UI can tell the user. */
  onCompact?: (result: CompactionResult) => void;
}

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_REPEAT_LIMIT = 3;

/** A stable key for detecting a repeated call. */
function callKey(call: { name: string; arguments: Record<string, unknown> }): string {
  let args: string;
  try {
    args = JSON.stringify(call.arguments, Object.keys(call.arguments).sort());
  } catch {
    args = String(call.arguments);
  }
  return `${call.name}:${args}`;
}

export async function runAgent(
  task: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const repeatLimit = options.repeatLimit ?? DEFAULT_REPEAT_LIMIT;

  const tools: ToolDefinition[] = options.registry.schemas().map((schema) => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters as unknown as Record<string, unknown>,
  }));

  const messages: ConversationMessage[] = [{ role: 'user', content: task }];
  const steps: AgentStep[] = [];
  const failedToolCalls: Array<{ name: string; error: string }> = [];

  let tokensIn = 0;
  let tokensOut = 0;
  let repeats = 0;
  let previousKey = '';
  let compactions = 0;

  /**
   * Fit the history to the budget before a request.
   *
   * The full history stays in `messages` for reporting; only the copy handed to
   * the model is trimmed, so a caller can still show everything that happened
   * after old turns have left the window.
   */
  const fit = async (): Promise<ConversationMessage[]> => {
    if (!options.contextBudget) return messages;

    const result = await compact(messages, {
      ...options.contextBudget,
      ...(options.summarize ? { summarize: options.summarize } : {}),
    });

    if (result.droppedMessages > 0) {
      compactions += 1;
      options.onCompact?.(result);
    }

    return result.messages;
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      return {
        content: '',
        stopReason: 'cancelled',
        iterations: steps.length,
        steps,
        tokensIn,
        tokensOut,
        failedToolCalls,
        compactions,
      };
    }

    let completion;
    try {
      completion = await options.model.complete(task, {
        system: options.system,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        signal: options.signal,
        tools,
        messages: await fit(),
      });
    } catch (error) {
      // The reason is put in `content` as well as the stop reason, because a
      // caller that only logs the final message should still learn that the
      // model failed rather than that the task finished with nothing to say.
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `The model call failed: ${message}`,
        stopReason: 'model_error',
        iterations: steps.length,
        steps,
        tokensIn,
        tokensOut,
        failedToolCalls,
        compactions,
      };
    }

    tokensIn += completion.usage.tokensIn;
    tokensOut += completion.usage.tokensOut;

    // The model answered without asking for anything: the task is done.
    if (completion.toolCalls.length === 0) {
      const step: AgentStep = {
        iteration,
        content: completion.content,
        toolCalls: [],
        results: [],
        tokensIn: completion.usage.tokensIn,
        tokensOut: completion.usage.tokensOut,
      };
      steps.push(step);
      options.onStep?.(step);

      return {
        content: completion.content,
        stopReason: 'completed',
        iterations: steps.length,
        steps,
        tokensIn,
        tokensOut,
        failedToolCalls,
        compactions,
      };
    }

    // Record the assistant turn, including the calls, so the next request
    // carries the pairing the API expects.
    messages.push({
      role: 'assistant',
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    const key = callKey(completion.toolCalls[0] ?? { name: '', arguments: {} });
    repeats = key === previousKey ? repeats + 1 : 0;
    previousKey = key;

    if (repeats >= repeatLimit) {
      const step: AgentStep = {
        iteration,
        content: completion.content,
        toolCalls: completion.toolCalls,
        results: [],
        tokensIn: completion.usage.tokensIn,
        tokensOut: completion.usage.tokensOut,
      };
      steps.push(step);
      options.onStep?.(step);

      return {
        content:
          `Stopped: the model repeated the same tool call ${repeats + 1} times ` +
          `without changing its approach. Last call: ${key}.`,
        stopReason: 'repeated_tool_call',
        iterations: steps.length,
        steps,
        tokensIn,
        tokensOut,
        failedToolCalls,
        compactions,
      };
    }

    const results = await options.registry.executeAll(
      completion.toolCalls,
      options.context,
    );

    completion.toolCalls.forEach((call, index) => {
      const result = results[index];
      if (result && !result.ok) {
        failedToolCalls.push({
          name: call.name,
          error: result.error ?? result.content,
        });
      }
      messages.push({
        role: 'tool',
        content: result?.content ?? 'no result',
        name: call.name,
        toolCallId: `call_${index}`,
      });
    });

    const step: AgentStep = {
      iteration,
      content: completion.content,
      toolCalls: completion.toolCalls,
      results: completion.toolCalls.map((call, index) => ({
        name: call.name,
        ok: results[index]?.ok ?? false,
        content: results[index]?.content ?? '',
      })),
      tokensIn: completion.usage.tokensIn,
      tokensOut: completion.usage.tokensOut,
    };
    steps.push(step);
    options.onStep?.(step);
  }

  return {
    content:
      `Stopped after ${maxIterations} iterations without a final answer. ` +
      'The last thing the model did was call a tool.',
    stopReason: 'max_iterations',
    iterations: steps.length,
    steps,
    tokensIn,
    tokensOut,
    failedToolCalls,
    compactions,
  };
}

export {
  DEFAULT_MAX_READ_BYTES,
  editFileTool,
  fileTools,
  listDirTool,
  mkdirTool,
  readFileTool,
  writeFileTool,
} from './tools/fs.js';

export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  KILL_GRACE_MS,
  MAX_COMMAND_LENGTH,
  createShellTool,
  shellTool,
  type ShellToolOptions,
} from './tools/shell.js';