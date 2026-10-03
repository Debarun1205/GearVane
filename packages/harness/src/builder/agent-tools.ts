/**
 * Scaffold tools for the agent loop.
 *
 * These are what make prompt-driven building ("vibe-coding") work: instead of
 * filling in a template form, the user describes the site and the model
 * decides which template fits, which values to use, and then refines the
 * result with the file tools.
 *
 * Two tools, split on purpose. `list_templates` is read-only and cheap, so the
 * model can inspect what exists before committing. `scaffold_project` writes
 * through the same `materialise` path as every other caller, so containment
 * and the overwrite rules are identical no matter which surface invoked them.
 *
 * Values arrive as a plain object because template fields differ per template
 * and a fixed schema would have to change with every new one. Numbers are
 * coerced to strings (models emit `port: 3000` far more often than `"3000"`);
 * anything else that is not a string or boolean is rejected rather than
 * stringified, because silently converting an object would produce garbage in
 * the generated files.
 */

import { getTemplate, materialise, plan, TEMPLATES } from './scaffold.js';
import { failure, type Tool, type ToolContext, type ToolResult } from '../tools/types.js';

export const listTemplatesTool: Tool = {
  schema: {
    name: 'list_templates',
    description:
      'List the project templates available for scaffolding a new site or ' +
      'service. Call this first when the user asks for a new project, so the ' +
      'template choice is based on what exists rather than guessed.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  async execute(): Promise<ToolResult> {
    const summaries = TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      fields: template.params.map((param) => ({
        key: param.key,
        label: param.label,
        type: param.type,
        required: param.required ?? false,
        ...(param.default !== undefined ? { default: param.default } : {}),
      })),
    }));

    return { ok: true, content: JSON.stringify(summaries, null, 2) };
  },
};

export const scaffoldProjectTool: Tool = {
  schema: {
    name: 'scaffold_project',
    description:
      'Scaffold a new project from a template into the workspace. Writes real, ' +
      'complete, runnable files. Refuses paths that escape the workspace. ' +
      'After scaffolding, refine the result with read_file, edit_file, and ' +
      'write_file rather than scaffolding twice.',
    parameters: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: 'Template id from list_templates.',
        },
        values: {
          type: 'object',
          description:
            'Field values keyed by field name, e.g. {"projectName": "Acme"}. ' +
            'Use the field list from list_templates.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Replace files that already exist. Defaults to false, in which ' +
            'case existing files are reported as refused rather than touched.',
          default: false,
        },
      },
      required: ['template', 'values'],
      additionalProperties: false,
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const templateId = args['template'];
    if (typeof templateId !== 'string' || templateId.trim() === '') {
      return failure('template must be a non-empty string');
    }

    const template = getTemplate(templateId);
    if (!template) {
      const known = TEMPLATES.map((entry) => entry.id).join(', ');
      return failure(
        `unknown template "${templateId}". Available: ${known}. ` +
          'Call list_templates if unsure.',
      );
    }

    const rawValues = args['values'];
    if (rawValues === null || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
      return failure('values must be an object keyed by field name');
    }

    const values: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(rawValues as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'boolean') {
        values[key] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        values[key] = String(value);
      } else {
        return failure(
          `value for "${key}" must be a string, boolean, or number, ` +
            `not ${Array.isArray(value) ? 'an array' : typeof value}`,
        );
      }
    }

    let planned;
    try {
      planned = plan({ templateId, values });
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    let result;
    try {
      result = await materialise(planned, ctx.workspace, {
        overwrite: args['overwrite'] === true,
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    const lines = [
      `Scaffolded ${result.written.length} file(s) from "${templateId}":`,
      ...result.written.map((path) => `  wrote ${path}`),
      ...result.refused.map((refusal) => `  refused ${refusal.path}: ${refusal.reason}`),
    ];

    return {
      ok: result.refused.length === 0,
      content: lines.join('\n'),
      ...(result.refused.length > 0
        ? { error: `${result.refused.length} file(s) refused` }
        : {}),
    };
  },
};

/** Both tools, ready to register alongside the file tools. */
export function builderTools(): Tool[] {
  return [listTemplatesTool, scaffoldProjectTool];
}
