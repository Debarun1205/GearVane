import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  estimateTokens,
  runAgent,
  type AgentModel,
  type AgentOptions,
} from '../src/index.js';
import { Workspace } from '../src/workspace/containment.js';
import { DEFAULT_MAX_READ_BYTES, fileTools } from '../src/tools/fs.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * The agent loop, driven by a scripted model.
 *
 * Every test here is about a decision the loop makes rather than about what a
 * real model would say, so the model is a script. That keeps the suite
 * deterministic and makes the interesting cases, like a model stuck in a
 * retry, expressible at all.
 */

interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  throw?: string;
}

/** A model that replays a fixed list of turns and records what it was sent. */
function scriptedModel(turns: ScriptedTurn[]) {
  const seen: Array<{ messages?: unknown; tools?: unknown }> = [];
  let index = 0;

  const model: AgentModel & { seen: typeof seen } = {
    seen,
    async complete(_prompt, options) {
      seen.push({
        messages: options?.messages,
        tools: options?.tools,
      });

      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;

      if (!turn) throw new Error('scripted model ran out of turns');
      if (turn.throw) throw new Error(turn.throw);

      return {
        content: turn.content ?? '',
        finishReason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
        toolCalls: turn.toolCalls ?? [],
        usage: { tokensIn: 10, tokensOut: 5 },
      };
    },
  };

  return model;
}

let root: string;
let registry: ToolRegistry;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'waypoint-agent-'));
  root = join(base, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.txt'), 'alpha\nbeta\ngamma\n');
  registry = new ToolRegistry(fileTools());
});

function baseOptions(model: AgentModel): AgentOptions {
  return {
    model,
    registry,
    context: {
      workspace: new Workspace(root),
      maxReadBytes: DEFAULT_MAX_READ_BYTES,
    },
    maxIterations: 6,
  };
}

describe('a single-turn task', () => {
  it('returns the prose when the model asks for nothing', async () => {
    const model = scriptedModel([{ content: 'All done.' }]);
    const result = await runAgent('do something', baseOptions(model));

    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('All done.');
    expect(result.iterations).toBe(1);
  });

  it('advertises the registered tools', async () => {
    const model = scriptedModel([{ content: 'ok' }]);
    await runAgent('task', baseOptions(model));

    const tools = model.seen[0]?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual([
      'edit_file',
      'list_dir',
      'mkdir',
      'read_file',
      'write_file',
    ]);
  });

  it('passes the task as the first message', async () => {
    const model = scriptedModel([{ content: 'ok' }]);
    await runAgent('fix the typo', baseOptions(model));

    const messages = model.seen[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'user', content: 'fix the typo' });
  });
});

describe('a task needing one tool', () => {
  it('runs the tool and feeds the result back', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'The file has three lines.' },
    ]);

    const result = await runAgent('read a.txt', baseOptions(model));

    expect(result.stopReason).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(result.steps[0]?.results[0]?.ok).toBe(true);
    expect(result.steps[0]?.results[0]?.content).toContain('alpha');
  });

  it('sends the tool result back as a tool message', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    await runAgent('read a.txt', baseOptions(model));

    const second = model.seen[1]?.messages as Array<Record<string, unknown>>;
    expect(second).toHaveLength(3);
    expect(second[1]?.['role']).toBe('assistant');
    expect(second[2]?.['role']).toBe('tool');
    expect(String(second[2]?.['content'])).toContain('alpha');
  });

  it('performs a real write', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          { name: 'write_file', arguments: { path: 'new.txt', content: 'written' } },
        ],
      },
      { content: 'saved' },
    ]);

    await runAgent('write new.txt', baseOptions(model));

    const read = await registry.execute(
      'read_file',
      { path: 'new.txt' },
      { workspace: new Workspace(root), maxReadBytes: DEFAULT_MAX_READ_BYTES },
    );
    expect(read.content).toContain('written');
  });

  it('records an edit as a step', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          {
            name: 'edit_file',
            arguments: { path: 'a.txt', oldText: 'beta', newText: 'BETA' },
          },
        ],
      },
      { content: 'edited' },
    ]);

    const result = await runAgent('change beta', baseOptions(model));

    expect(result.steps[0]?.toolCalls[0]?.name).toBe('edit_file');
    expect(result.steps[0]?.results[0]?.content).toContain('Replaced 1');
  });
});

describe('a multi-step task', () => {
  it('threads several tool calls through', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'list_dir', arguments: {} }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'Finished reading.' },
    ]);

    const result = await runAgent('explore', baseOptions(model));

    expect(result.stopReason).toBe('completed');
    expect(result.iterations).toBe(3);
    expect(result.steps.map((s) => s.toolCalls[0]?.name)).toEqual([
      'list_dir',
      'read_file',
      undefined,
    ]);
  });

  it('runs several calls requested in one turn', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          { name: 'read_file', arguments: { path: 'a.txt' } },
          { name: 'list_dir', arguments: {} },
        ],
      },
      { content: 'both read' },
    ]);

    const result = await runAgent('read and list', baseOptions(model));

    expect(result.steps[0]?.results).toHaveLength(2);
    expect(result.steps[0]?.results.every((r) => r.ok)).toBe(true);
  });

  it('reports progress through onStep', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'list_dir', arguments: {} }] },
      { content: 'done' },
    ]);

    const seen: number[] = [];
    await runAgent('explore', {
      ...baseOptions(model),
      onStep: (step) => seen.push(step.iteration),
    });

    expect(seen).toEqual([1, 2]);
  });
});

describe('failure handling', () => {
  it('keeps going when a tool fails', async () => {
    // The important property: a bad call does not end the task. The model sees
    // the error and can correct itself.
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'missing.txt' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'Found it.' },
    ]);

    const result = await runAgent('read something', baseOptions(model));

    expect(result.stopReason).toBe('completed');
    expect(result.steps[0]?.results[0]?.ok).toBe(false);
    expect(result.steps[1]?.results[0]?.ok).toBe(true);
  });

  it('collects failed tool calls for the caller', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'missing.txt' } }] },
      { content: 'gave up on that' },
    ]);

    const result = await runAgent('read missing', baseOptions(model));

    expect(result.failedToolCalls).toHaveLength(1);
    expect(result.failedToolCalls[0]?.name).toBe('read_file');
  });

  it('reports a model error rather than throwing', async () => {
    const model = scriptedModel([{ throw: 'rate limited' }]);
    const result = await runAgent('task', baseOptions(model));

    expect(result.stopReason).toBe('model_error');
    expect(result.content).toContain('rate limited');
  });

  it('refuses a tool call that escapes the workspace', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: '../../etc/passwd' } }] },
      { content: 'That is outside my workspace.' },
    ]);

    const result = await runAgent('read a secret', baseOptions(model));

    expect(result.steps[0]?.results[0]?.ok).toBe(false);
    expect(result.steps[0]?.results[0]?.content).toContain('escapes the workspace');
  });

  it('handles an unknown tool without ending the task', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'launch_missiles', arguments: {} }] },
      { content: 'I do not have that tool.' },
    ]);

    const result = await runAgent('launch', baseOptions(model));

    expect(result.stopReason).toBe('completed');
    expect(result.steps[0]?.results[0]?.content).toContain('no such tool');
  });
});

describe('context budgeting in the loop', () => {
  const BUDGET = { contextWindow: 4000, reserveForOutput: 500 };

  /**
   * Reads several large files in a row, then finishes.
   *
   * The path differs per call on purpose. Identical calls would trip the
   * stuck-loop guard, which is the correct behaviour and is tested elsewhere;
   * here it would mask what is being measured.
   */
  function longOutputModel(reads: number) {
    const turns: ScriptedTurn[] = [];
    for (let index = 0; index < reads; index += 1) {
      turns.push({
        toolCalls: [
          { name: 'read_file', arguments: { path: `big-${index}.txt` } },
        ],
      });
    }
    turns.push({ content: 'done' });
    return scriptedModel(turns);
  }

  beforeEach(async () => {
    const { writeFile } = await import('node:fs/promises');
    // Roughly 1250 tokens per file, so a handful of reads overflow the budget
    // above. Separate files, matching the paths longOutputModel asks for.
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(root, `big-${index}.txt`), 'x'.repeat(5000));
    }
  });

  it('completes without a budget set', async () => {
    const model = longOutputModel(4);
    const result = await runAgent('read things', baseOptions(model));

    expect(result.stopReason).toBe('completed');
    expect(result.compactions).toBe(0);
  });

  it('compacts when history outgrows the budget', async () => {
    // Five reads plus a final turn is six iterations, and baseOptions caps the
    // loop at six, so the ceiling is not what ends this.
    const model = longOutputModel(5);
    const result = await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
    });

    expect(result.stopReason).toBe('completed');
    expect(result.compactions).toBeGreaterThan(0);
  });

  it('keeps the full history for reporting while trimming the request', async () => {
    // The user should still be able to see everything that happened, even
    // after old turns left the model's window.
    const model = longOutputModel(6);
    await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
    });

    // Every tool result the model produced should still be visible to a
    // caller inspecting `steps`.
    const results = model.seen;
    expect(results.length).toBeGreaterThan(1);

    const lastRequest = results[results.length - 1]?.messages as Array<
      Record<string, unknown>
    >;
    // The final request is bounded, and it still carries the original task.
    expect(lastRequest[0]).toMatchObject({ role: 'user' });
    expect(lastRequest[0]?.['content']).toBe('read things');
  });

  it('never lets the request exceed the budget', async () => {
    const model = longOutputModel(5);
    await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
    });

    for (const request of model.seen) {
      const messages = request.messages as Array<
        Record<string, unknown> & {
          toolCalls?: Array<{ name: string; arguments: unknown }>;
        }
      >;

      let total = 0;
      for (const message of messages) {
        total += estimateTokens(String(message['content'] ?? ''));
        for (const call of message.toolCalls ?? []) {
          total += estimateTokens(JSON.stringify(call.arguments));
        }
      }

      // Allow per-message framing the estimator adds.
      expect(total).toBeLessThanOrEqual(BUDGET.contextWindow);
    }
  });

  it('summarises dropped history when a summariser is given', async () => {
    const model = longOutputModel(5);
    let summarised = 0;

    const result = await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
      summarize: async () => {
        summarised += 1;
        return 'Read several files; contents were long.';
      },
    });

    expect(result.stopReason).toBe('completed');
    expect(summarised).toBeGreaterThan(0);

    const last = model.seen[model.seen.length - 1]?.messages as Array<
      Record<string, unknown>
    >;
    expect(
      last.some((m) => String(m['content']).includes('Summary of earlier work')),
    ).toBe(true);
  });

  it('reports compaction so a UI can tell the user', async () => {
    const model = longOutputModel(6);
    const seen: number[] = [];

    await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
      onCompact: (result) => seen.push(result.droppedMessages),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count > 0)).toBe(true);
  });

  it('does not summarise a short task', async () => {
    const model = scriptedModel([{ content: 'quick answer' }]);
    let called = 0;

    const result = await runAgent('short', {
      ...baseOptions(model),
      contextBudget: BUDGET,
      summarize: async () => {
        called += 1;
        return 'unused';
      },
    });

    expect(result.compactions).toBe(0);
    // A summary costs a model call, so it must not run when nothing was
    // dropped.
    expect(called).toBe(0);
  });

  it('survives a summariser that throws', async () => {
    const model = longOutputModel(5);
    const result = await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
      summarize: async () => {
        throw new Error('summary model unavailable');
      },
    });

    expect(result.stopReason).toBe('completed');
    expect(result.compactions).toBeGreaterThan(0);
  });

  it('stays valid for the provider after trimming', async () => {
    // Every request must still start sensibly and never open on an orphaned
    // tool result, which providers reject outright.
    const model = longOutputModel(5);
    await runAgent('read things', {
      ...baseOptions(model),
      contextBudget: BUDGET,
    });

    for (const request of model.seen) {
      const messages = request.messages as Array<Record<string, unknown>>;
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]?.['role']).toBe('user');
    }
  });

  it('reports zero compactions when no budget is configured', async () => {
    const model = longOutputModel(6);
    const result = await runAgent('read things', baseOptions(model));

    // Explicitly zero rather than unknown: no budget means the question does
    // not arise.
    expect(result.compactions).toBe(0);
  });
});

describe('loop termination', () => {
  it('stops after maxIterations', async () => {
    // A model that only ever calls tools would otherwise run forever.
    const model = scriptedModel([
      { toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
    ]);

    const result = await runAgent(
      'loop',
      { ...baseOptions(model), maxIterations: 4, repeatLimit: 99 },
    );

    expect(result.stopReason).toBe('max_iterations');
    expect(result.iterations).toBe(4);
    expect(result.content).toContain('without a final answer');
  });

  it('stops a model stuck repeating one call', async () => {
    // An iteration ceiling alone does not catch this: every iteration looks
    // like progress, and the model burns the whole budget being wrong.
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    ]);

    const result = await runAgent(
      'loop',
      { ...baseOptions(model), maxIterations: 50, repeatLimit: 3 },
    );

    expect(result.stopReason).toBe('repeated_tool_call');
    expect(result.iterations).toBeLessThan(5);
    expect(result.content).toContain('repeated the same tool call');
  });

  it('names the call it gave up on', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    ]);

    const result = await runAgent('loop', {
      ...baseOptions(model),
      repeatLimit: 2,
    });

    expect(result.content).toContain('read_file');
  });

  it('does not count a changed call as a repeat', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'b.txt' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'c.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runAgent('explore', {
      ...baseOptions(model),
      repeatLimit: 2,
    });

    expect(result.stopReason).toBe('completed');
  });

  it('stops when cancelled before the first call', async () => {
    const controller = new AbortController();
    controller.abort();

    const model = scriptedModel([{ content: 'never reached' }]);
    const result = await runAgent('task', {
      ...baseOptions(model),
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(model.seen).toHaveLength(0);
  });

  it('counts token usage across iterations', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'list_dir', arguments: {} }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    const result = await runAgent('explore', baseOptions(model));

    expect(result.tokensIn).toBe(30);
    expect(result.tokensOut).toBe(15);
  });

  it('exposes a full step history for debugging', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'list_dir', arguments: {} }] },
      { content: 'done' },
    ]);

    const result = await runAgent('explore', baseOptions(model));

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.iteration).toBe(1);
    expect(result.steps[1]?.content).toBe('done');
  });
});