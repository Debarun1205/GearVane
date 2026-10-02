/**
 * Harness commands for the CLI.
 *
 * A separate module so `bin.ts` stays readable and so these can be tested
 * without parsing the whole argument surface.
 *
 * Two commands matter most:
 *
 * - `agent` runs the loop with file tools and a gated shell
 * - `build` scaffolds a project from a template
 *
 * Both are honest about their limits. `agent` warns when the chosen provider
 * cannot call tools rather than silently returning prose after one turn.
 * `build` writes through the same `Workspace` containment as the file tools, so
 * a template path cannot escape the target directory.
 */

import { createInterface } from 'node:readline/promises';

import {
  HealthChecker,
  ProviderFactory,
  SafetyManager,
  VERSION,
  type ApprovalRequest,
  type Completion,
  type CompleteOptions,
  type ToolDefinition,
  type WaypointConfig,
} from '@waypoint/core';
import {
  TEMPLATES,
  ToolRegistry,
  Workspace,
  createShellTool,
  fileTools,
  getTemplate,
  installNodeFileSystem,
  materialise,
  plan,
  runAgent,
  type AgentModel,
  type AgentResult,
  type AgentStep,
  type Tool,
} from '@waypoint/harness';

import { flagBool, flagNumber, flagString, type ParsedArgs } from './args.js';
import { loadConfig } from './config-loader.js';

/**
 * Providers that can be asked to call tools.
 *
 * A provider outside this set will return prose whatever the loop asks for, so
 * the run ends after one turn looking like it succeeded. Warning about that is
 * the difference between a confusing failure and an obvious one.
 */
const TOOL_CAPABLE = new Set(['openai-compatible', 'anthropic', 'openrouter', 'groq']);

/* ------------------------------------------------------------------ */
/* agent                                                                */
/* ------------------------------------------------------------------ */

export const AGENT_HELP = `waypoint agent - run the agent loop over your project

Usage:
  waypoint agent --task "<what you want done>" [options]

Options:
  --cwd <dir>            Project directory to work in (default: current)
  --allow-shell          Offer the gated run_command tool
  --yes                  Approve every gated command without asking
  --max-iterations <n>   Loop ceiling (default 25)
  --budget <tokens>      Context window, for trimming long histories
  --json                 Machine-readable output
  --dry-run              Print the tools that would be offered, then stop

The agent reads and edits files inside --cwd and cannot leave it, including
through symbolic links.

With --allow-shell it can also run commands. Blocked ones are refused and
consequential ones need approval. That is gating, not containment: an approved
command can still read any file you can. There is no sandbox.`;

export async function cmdAgent(args: ParsedArgs, json: boolean, useColor: boolean): Promise<number> {
  const task = flagString(args, 'task');
  if (!task) {
    process.stderr.write('agent requires --task\n');
    return 1;
  }

  const cwd = flagString(args, 'cwd') ?? process.cwd();
  const workspace = new Workspace(cwd);
  const allowShell = flagBool(args, 'allow-shell');
  const autoApprove = flagBool(args, 'yes');
  const maxIterations = flagNumber(args, 'max-iterations') ?? 25;
  const budget = flagNumber(args, 'budget');

  const { config } = loadConfig(flagString(args, 'config'));
  const tools = buildToolkit(config, allowShell, autoApprove);

  if (flagBool(args, 'dry-run')) {
    const payload = {
      workspace: workspace.root,
      tools: tools.map((tool) => tool.schema.name),
      shell: allowShell,
    };

    if (json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`workspace  ${payload.workspace}\n`);
      process.stdout.write(`tools      ${payload.tools.join(', ')}\n`);
      process.stdout.write(`shell      ${allowShell ? 'offered (gated)' : 'not offered'}\n`);
    }
    return 0;
  }

  const model = resolveModel(config);
  if (!model.client) {
    process.stderr.write(`Cannot reach a model: ${model.reason}\n`);
    return 1;
  }

  if (model.supportsTools === false && !json) {
    process.stderr.write(
      `Note: ${model.provider} does not advertise tool calling. The agent will ` +
        'probably return a single answer instead of editing files.\n\n',
    );
  }

  const registry = new ToolRegistry(tools);

  const result = await runAgent(task, {
    model: model.client,
    registry,
    context: { workspace, maxReadBytes: 256 * 1024 },
    maxIterations,
    ...(budget ? { contextBudget: { contextWindow: budget, reserveForOutput: 2048 } } : {}),
    onStep: json ? undefined : (step) => writeStep(step, useColor),
  });

  return reportAgent(result, json, useColor);
}

function buildToolkit(
  config: WaypointConfig,
  allowShell: boolean,
  autoApprove: boolean,
): Tool[] {
  const tools: Tool[] = [...fileTools()];

  if (allowShell) {
    tools.push(
      createShellTool({
        safety: new SafetyManager(config.safety),
        approve: autoApprove
          ? () => true
          : (request) => askApproval(request),
      }),
    );
  }

  return tools;
}

/**
 * Ask before a consequential command.
 *
 * Declines when stdin is not a terminal: an unattended run must not be able to
 * approve itself, and defaulting to yes in a pipeline is the worst possible
 * failure mode for a gate.
 */
async function askApproval(request: ApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `approval required for ${request.operation}, but stdin is not a terminal. ` +
        'Re-run with --yes to approve automatically.\n',
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `\nRun this ${request.operation}?\n  ${request.command}\n  ${request.reason}\n[y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

interface ModelChoice {
  client?: AgentModel;
  provider?: string;
  supportsTools?: boolean;
  reason?: string;
}

/**
 * Pick a provider that actually responds.
 *
 * The routing engine is not consulted here. An agent run is already the
 * expensive path, and picking a tier here would either silently override the
 * user's configuration or duplicate logic that belongs in core.
 */
function resolveModel(config: WaypointConfig): ModelChoice {
  const factory = new ProviderFactory({
    env: process.env as Record<string, string | undefined>,
    timeoutMs: config.providers.timeoutSeconds * 1000,
  });

  for (const tier of Object.values(config.tiers)) {
    for (const provider of tier.providers) {
      let client;
      try {
        client = factory.create(provider);
      } catch {
        // No base URL configured for this provider. Try the next one.
        continue;
      }

      const name = provider.name.toLowerCase();

      return {
        provider: provider.name,
        supportsTools: TOOL_CAPABLE.has(name) || Boolean(provider.baseUrl?.includes('/v1')),
        client: {
          complete: async (prompt: string, options?: CompleteOptions): Promise<Completion> =>
            client.complete(prompt, options),
        },
      };
    }
  }

  return { reason: 'no usable provider is configured' };
}

function writeStep(step: AgentStep, useColor: boolean): void {
  const dim = useColor ? '\u001b[2m' : '';
  const reset = useColor ? '\u001b[0m' : '';
  const bold = useColor ? '\u001b[1m' : '';

  for (const call of step.toolCalls) {
    const result = step.results.find((entry) => entry.name === call.name);
    process.stderr.write(
      `${dim}[${step.iteration}]${reset} ${bold}${call.name}${reset} ${dim}(${result?.ok ? 'ok' : 'failed'})${reset}\n`,
    );
  }

  for (const line of step.content.trim().split('\n')) {
    if (line.trim()) process.stderr.write(`${dim}    ${line}${reset}\n`);
  }
}

function reportAgent(result: AgentResult, json: boolean, useColor: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.stopReason === 'completed' ? 0 : 1;
  }

  const bold = useColor ? '\u001b[1m' : '';
  const reset = useColor ? '\u001b[0m' : '';

  process.stdout.write(`\n${bold}${result.content}${reset}\n\n`);
  process.stdout.write(
    `${result.iterations} iteration(s), ${result.tokensIn} in / ${result.tokensOut} out tokens` +
      `${result.compactions > 0 ? `, ${result.compactions} compaction(s)` : ''}\n`,
  );
  process.stdout.write(`stopped: ${result.stopReason}\n`);

  if (result.failedToolCalls.length > 0) {
    process.stdout.write(`\n${result.failedToolCalls.length} tool call(s) failed:\n`);
    for (const failure of result.failedToolCalls) {
      process.stdout.write(`  ${failure.name}: ${failure.error}\n`);
    }
  }

  return result.stopReason === 'completed' ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* build                                                                */
/* ------------------------------------------------------------------ */

export const BUILD_HELP = `waypoint build - scaffold a project from a template

Usage:
  waypoint build --list
  waypoint build --template <id> --name "<project name>" [options]

Options:
  --template <id>   Template to use
  --name <name>     Project name
  --tagline <text>  Short description
  --features <text> Features, separated by ";" for multiple lines
  --resource <text> Primary resource name, for the api template
  --pages <text>    Documentation pages as "Title:summary;Title:summary"
  --out <dir>       Directory to write into (default: current)
  --force           Overwrite existing files
  --list            Show the available templates
  --json            Machine-readable output

Writing is confined to --out: a template path cannot escape it, including
through a symbolic link.

Templates are deterministic. The same answers always produce the same files.
This is a template engine, not a code generator, so it will not invent
anything you did not ask for.

Separators: use ";" between features or pages, since a single flag cannot
carry a literal newline through most shells.`;

export async function cmdBuild(args: ParsedArgs, json: boolean): Promise<number> {
  if (flagBool(args, 'list')) {
    return listTemplates(json);
  }

  const templateId = flagString(args, 'template');
  if (!templateId) {
    process.stderr.write('build requires --template, or --list to see them\n');
    return 1;
  }

  const template = getTemplate(templateId);
  if (!template) {
    process.stderr.write(`Unknown template: ${templateId}\n`);
    process.stderr.write(`Available: ${TEMPLATES.map((entry) => entry.id).join(', ')}\n`);
    return 1;
  }

  const name = flagString(args, 'name');
  if (!name) {
    process.stderr.write('build requires --name\n');
    return 1;
  }

  // Semicolons stand in for newlines: a single CLI flag cannot carry a literal
  // newline through most shells without quoting gymnastics.
  const values: Record<string, string | boolean> = { projectName: name };

  // Read every declared parameter rather than a hand-listed set, so adding a
  // template field does not require editing the command.
  for (const param of template.params) {
    if (param.key === 'projectName') continue;
    const value = readParam(args, param.key);
    if (value !== undefined) values[param.key] = value.replace(/;/g, '\n');
  }

  const out = flagString(args, 'out') ?? process.cwd();
  const workspace = new Workspace(out);

  let planned;
  try {
    planned = plan({ templateId, values });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const result = await materialise(planned, workspace, {
    fs: installNodeFileSystem(),
    overwrite: flagBool(args, 'force'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.refused.length === 0 ? 0 : 1;
  }

  for (const path of result.written) {
    process.stdout.write(`wrote  ${path}\n`);
  }
  for (const refusal of result.refused) {
    process.stderr.write(`skipped ${refusal.path}: ${refusal.reason}\n`);
  }

  process.stdout.write(`\n${result.written.length} file(s) in ${workspace.root}\n`);
  return result.refused.length === 0 ? 0 : 1;
}

/**
 * Flag names, which differ from parameter keys where the CLI has a shorter
 * form. A template advertises `--projectName` while the command accepts
 * `--name`, and `--list` has to show the one that works.
 */
const FLAG_NAMES: Record<string, string> = {
  projectName: 'name',
};

/** Accepts both the parameter key and its shortened flag name. */
function readParam(args: ParsedArgs, key: string): string | undefined {
  const flag = FLAG_NAMES[key] ?? key;
  return flagString(args, flag) ?? (flag === key ? undefined : flagString(args, key));
}

function listTemplates(json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(TEMPLATES, null, 2)}\n`);
    return 0;
  }

  for (const template of TEMPLATES) {
    process.stdout.write(`${template.id}\n  ${template.name}\n  ${template.description}\n`);
    for (const param of template.params) {
      const flag = FLAG_NAMES[param.key] ?? param.key;
      const required = param.required ? ' (required)' : '';
      const fallback = param.default !== undefined ? ` [${String(param.default)}]` : '';
      process.stdout.write(`  --${flag}${required}${fallback}  ${param.label}\n`);
    }
    process.stdout.write('\n');
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* session                                                              */
/* ------------------------------------------------------------------ */

export const SESSION_HELP = `waypoint session - list, show, and clear agent sessions

Usage:
  waypoint session list [--json]
  waypoint session show <id> [--json]
  waypoint session delete <id>
  waypoint session clear

Sessions live in .waypoint/ under the workspace. Credential-shaped text is
stripped before anything is written. That is a useful default and not a
guarantee: a key in an unusual format will not be caught.`;

export { VERSION };

/** Tool schemas as a model would receive them. */
export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.schema.name,
    description: tool.schema.description,
    parameters: tool.schema.parameters as unknown as Record<string, unknown>,
  }));
}

export { HealthChecker };