/**
 * Tool definitions, results, and the registry that dispatches them.
 *
 * A tool is described to a model with a JSON Schema, exactly as the OpenAI and
 * Ollama tool-calling APIs expect. The same schema is used to validate the
 * arguments on the way back in, because a model that was told the wrong shape
 * will occasionally produce the wrong shape and an unvalidated argument is how
 * a harness ends up writing to an unintended path.
 */

/**
 * The subset of JSON Schema that tool parameters need.
 *
 * Deliberately small. A full validator is a large dependency, and the only
 * properties a tool author actually uses are these.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** How a tool is advertised to a model. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** Everything a tool is allowed to know about its caller. */
export interface ToolContext {
  /**
   * The confined tree. A tool must resolve every path through this and must
   * not consult the process working directory, or containment is decorative.
   */
  workspace: import('../workspace/containment.js').Workspace;

  /** Aborts long operations when the user cancels. */
  signal?: AbortSignal;

  /**
   * Hard cap on bytes a single read may return.
   *
   * Without it a model can ask for a 4 GB log and fill the context window,
   * which costs real money and breaks every later turn.
   */
  maxReadBytes: number;
}

export interface ToolResult {
  ok: boolean;
  /**
   * Text handed back to the model. Errors are returned rather than thrown so
   * that one bad tool call does not end the loop: the model can read the
   * message and correct itself, which is usually what it needs to do.
   */
  content: string;
  /** Present when ok is false. */
  error?: string;
}

export interface Tool {
  schema: ToolSchema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

/** Argument validation failure, surfaced to the caller rather than thrown. */
export class ToolArgumentError extends Error {
  constructor(readonly tool: string, message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate and coerce arguments against a tool schema.
 *
 * Coercion is limited to defaults and to a string that is unambiguously a
 * number or boolean, because models emit `"3"` for an integer more often than
 * one would like and rejecting it wastes a whole turn. A JSON number that is
 * whole satisfies an integer schema directly: JSON has no integer type, so
 * requiring one would reject every real number a caller can produce.
 *
 * @throws {ToolArgumentError} on a missing required argument or a bad type
 */
export function validateArgs(
  tool: ToolSchema,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, property] of Object.entries(tool.parameters.properties)) {
    const provided = raw[key];

    if (provided === undefined) {
      if (property.default !== undefined) {
        result[key] = property.default;
        continue;
      }
      if (tool.parameters.required?.includes(key)) {
        throw new ToolArgumentError(tool.name, `missing required argument: ${key}`);
      }
      continue;
    }

    const actual = typeOf(provided);

    // JSON has no integer type, so a whole number satisfies an integer schema.
    // Without this, every integer parameter rejects every number any caller
    // can actually pass, and only numeric strings get through.
    const typeMatches =
      actual === property.type ||
      (property.type === 'integer' &&
        typeof provided === 'number' &&
        Number.isInteger(provided));

    if (!typeMatches) {
      const coerced = coerce(tool.name, key, property.type, provided);
      if (coerced === undefined) {
        throw new ToolArgumentError(
          tool.name,
          `argument ${key} should be ${property.type} but was ${actual}`,
        );
      }
      result[key] = coerced;
      continue;
    }

    if (property.enum && !property.enum.includes(provided as string)) {
      throw new ToolArgumentError(
        tool.name,
        `argument ${key} must be one of: ${property.enum.join(', ')}`,
      );
    }

    if (typeof provided === 'number') {
      if (property.minimum !== undefined && provided < property.minimum) {
        throw new ToolArgumentError(
          tool.name,
          `argument ${key} must be at least ${property.minimum}`,
        );
      }
      if (property.maximum !== undefined && provided > property.maximum) {
        throw new ToolArgumentError(
          tool.name,
          `argument ${key} must be at most ${property.maximum}`,
        );
      }
    }

    if (typeof provided === 'string') {
      if (property.minLength !== undefined && provided.length < property.minLength) {
        throw new ToolArgumentError(
          tool.name,
          `argument ${key} must be at least ${property.minLength} characters`,
        );
      }
      if (property.maxLength !== undefined && provided.length > property.maxLength) {
        throw new ToolArgumentError(
          tool.name,
          `argument ${key} must be at most ${property.maxLength} characters`,
        );
      }
    }

    result[key] = provided;
  }

  if (tool.parameters.additionalProperties === false) {
    for (const key of Object.keys(raw)) {
      if (!(key in tool.parameters.properties)) {
        throw new ToolArgumentError(tool.name, `unexpected argument: ${key}`);
      }
    }
  }

  return result;
}

function coerce(
  tool: string,
  key: string,
  expected: JsonSchemaProperty['type'],
  value: unknown,
): unknown {
  if (expected === 'number' || expected === 'integer') {
    const parsed = typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(parsed)) {
      return expected === 'integer' ? Math.trunc(parsed) : parsed;
    }
  }

  if (expected === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return undefined;
}

/** Turns a failure into a result the model can act on. */
export function failure(message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, error: message };
}