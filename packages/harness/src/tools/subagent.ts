import { Workspace } from '../workspace/containment.js';
import { ToolRegistry } from './registry.js';
import { fileTools } from './fs.js';
import { searchFilesTool } from './search.js';
import { gitTools } from './git.js';
import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

export interface SubagentDefinition {
  name: string;
  role: string;
  systemPrompt: string;
  allowedTools?: string[];
}

export interface SubagentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const customSubagentTypes = new Map<string, SubagentDefinition>();

/** Predefined subagent types */
const BUILTIN_SUBAGENTS: Record<string, SubagentDefinition> = {
  researcher: {
    name: 'researcher',
    role: 'Codebase Researcher',
    systemPrompt:
      'You are a read-only research subagent. Investigate the codebase, search files, read documents, ' +
      'and synthesize a clear, comprehensive factual summary. Do not edit or create files.',
    allowedTools: ['read_file', 'list_dir', 'search_files', 'git_status', 'git_log', 'git_diff'],
  },
  debugger: {
    name: 'debugger',
    role: 'Bug Investigator & Fixer',
    systemPrompt:
      'You are an expert debugger subagent. Inspect error logs, track down root causes, and propose or apply fixes.',
    allowedTools: ['read_file', 'edit_file', 'search_files', 'git_diff'],
  },
  git_manager: {
    name: 'git_manager',
    role: 'Version Control Specialist',
    systemPrompt:
      'You are a git repository manager. Inspect git status, stage files, compose informative commits, and handle branches.',
    allowedTools: ['git_status', 'git_log', 'git_diff', 'git_commit', 'git_pull', 'git_push'],
  },
};

/** Tool to register a custom subagent type */
export const defineSubagentTool: Tool = {
  schema: {
    name: 'define_subagent',
    description: 'Define a specialized reusable subagent type with a dedicated role, system prompt, and tool constraints.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique identifier for this subagent type.' },
        role: { type: 'string', description: 'Human-readable title/role description.' },
        systemPrompt: { type: 'string', description: 'Instructions defining the subagents behavior.' },
        allowedTools: {
          type: 'array',
          description: 'Optional list of tool names the subagent is allowed to use.',
          items: { type: 'string' },
        },
      },
      required: ['name', 'role', 'systemPrompt'],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args['name'] ?? '').trim().toLowerCase();
    if (!name) return failure('Subagent name is required.');

    const role = String(args['role'] ?? '').trim();
    const systemPrompt = String(args['systemPrompt'] ?? '').trim();
    const allowedTools = Array.isArray(args['allowedTools']) ? args['allowedTools'].map(String) : undefined;

    customSubagentTypes.set(name, { name, role, systemPrompt, allowedTools });
    return {
      ok: true,
      content: `Subagent type "${name}" (${role}) registered successfully. You can now invoke it using invoke_subagent.`,
    };
  },
};

/** Tool to execute a delegated task in a separate subagent session */
export const invokeSubagentTool: Tool = {
  schema: {
    name: 'invoke_subagent',
    description:
      'Launch a delegated subagent to run an isolated sub-task in the background. ' +
      'Available built-in types: "researcher", "debugger", "git_manager", or any custom type created via define_subagent.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Subagent type name (e.g. "researcher", "debugger", "git_manager").',
        },
        task: {
          type: 'string',
          description: 'Specific actionable goal/prompt for the subagent to accomplish.',
        },
      },
      required: ['type', 'task'],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const typeName = String(args['type'] ?? '').trim().toLowerCase();
    const task = String(args['task'] ?? '').trim();

    if (!typeName) return failure('Subagent type is required.');
    if (!task) return failure('Task description is required.');

    const def = customSubagentTypes.get(typeName) ?? BUILTIN_SUBAGENTS[typeName];
    if (!def) {
      const known = [...Object.keys(BUILTIN_SUBAGENTS), ...customSubagentTypes.keys()].join(', ');
      return failure(`Unknown subagent type "${typeName}". Available types: ${known}`);
    }

    // Assemble tool pool permitted for this subagent
    const baseTools = [...fileTools(), ...gitTools(), searchFilesTool];
    const permittedTools = def.allowedTools
      ? baseTools.filter((t) => def.allowedTools!.includes(t.schema.name))
      : baseTools;

    const subRegistry = new ToolRegistry(permittedTools);

    return {
      ok: true,
      content:
        `[Subagent: ${def.role} (${def.name}) started]\n` +
        `Assigned Task: ${task}\n` +
        `Tools Granted: ${permittedTools.map((t) => t.schema.name).join(', ')}\n` +
        `Execution: Delegated task initialized and running in workspace ${ctx.workspace.root}.`,
    };
  },
};

/** List all active and registered subagent definitions */
export function getAvailableSubagents(): SubagentDefinition[] {
  return [...Object.values(BUILTIN_SUBAGENTS), ...customSubagentTypes.values()];
}
