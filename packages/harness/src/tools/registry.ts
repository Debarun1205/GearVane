import {
  ToolArgumentError,
  validateArgs,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from './types.js';

/**
 * The set of tools an agent may call.
 *
 * Dispatch is deliberately total: an unknown tool, a bad argument, or a tool
 * that throws all come back as a failed result rather than an exception. The
 * reason is that these values are fed to a model, and a model can correct
 * itself when it is told what went wrong. An exception unwinds the agent loop
 * instead, so one malformed call out of a hundred ends the task.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.schema.name)) {
      throw new Error(`Tool already registered: ${tool.schema.name}`);
    }
    this.tools.set(tool.schema.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Schemas to send to a model. Sorted so the prompt is deterministic. */
  schemas(): ToolSchema[] {
    return [...this.tools.values()]
      .map((tool) => tool.schema)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      const known = this.names();
      return {
        ok: false,
        content:
          `Error: no such tool "${name}". ` +
          (known.length > 0
            ? `Available tools: ${known.join(', ')}.`
            : 'No tools are registered.'),
        error: `unknown tool: ${name}`,
      };
    }

    let args: Record<string, unknown>;
    try {
      if (rawArgs !== null && typeof rawArgs !== 'object') {
        throw new ToolArgumentError(name, 'arguments must be an object');
      }
      args = validateArgs(tool.schema, (rawArgs ?? {}) as Record<string, unknown>);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        content: `Error: invalid arguments for ${name}: ${message}`,
        error: message,
      };
    }

    try {
      if (ctx.signal?.aborted) {
        return {
          ok: false,
          content: 'Error: cancelled before the tool ran',
          error: 'aborted',
        };
      }

      const result = await tool.execute(args, ctx);

      if (typeof result?.content !== 'string') {
        return {
          ok: false,
          content: `Error: ${name} returned no content`,
          error: 'malformed tool result',
        };
      }

      return result;
    } catch (error) {
      // A tool that throws is a bug in the tool, but the loop still needs a
      // result to continue with.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        content: `Error: ${name} failed: ${message}`,
        error: message,
      };
    }
  }

  /** Run several calls and return results in the same order. */
  async executeAll(
    calls: ReadonlyArray<{ name: string; arguments: unknown }>,
    ctx: ToolContext,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      results.push(await this.execute(call.name, call.arguments, ctx));
    }
    return results;
  }
}