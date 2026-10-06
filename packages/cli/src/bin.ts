#!/usr/bin/env node
import {
  ConfigError,
  HealthChecker,
  LOCAL_PROVIDER_NAMES,
  Orchestrator,
  SafetyManager,
  VERSION,
  type ClassificationResult,
  type ExecutionResult,
  type HealthResult,
  type GearVaneConfig,
} from '@gearvane/core';

import {
  flagBool,
  flagList,
  flagNumber,
  flagString,
  parseArgs,
  type ParsedArgs,
} from './args.js';
import { loadConfig } from './config-loader.js';
import { cmdFeedback, cmdTrain, loadLearnedModel, recordRunFeedback } from './feedback-commands.js';
import {
  AGENT_HELP,
  BUILD_HELP,
  cmdAgent,
  cmdBuild,
} from './harness-commands.js';

const HELP = `gearvane ${VERSION} - route each task to the cheapest model tier that can do the job

gearvane --version

Usage:
  gearvane route --task "<description>" [--files a b] [--json]
  gearvane run   --task "<description>" [--files a b] [--stream] [--json]
  gearvane feedback [--json]
  gearvane train [--epochs N] [--learning-rate F] [--l2 F] [--json]
  gearvane health [--offline] [--json]
  gearvane models [--json]
  gearvane cost [--json]
  gearvane stats
  gearvane safety <spend|pending|check> [--command "<cmd>"] [--json]
  gearvane approve [--command "<cmd>" | --all]
  gearvane deploy <github|docker> <action> [options] [--dry-run]
  gearvane agent --task "<what you want done>" [options]
  gearvane build --template <id> --name "<project>" [--out <dir>]
  gearvane --version

Routing and health:
  gearvane agent --help
  gearvane build --help

Options:
  --config <path>   Config file to use
  --json            Machine-readable output
  --no-color        Disable ANSI colour
  --epochs N        Number of training epochs (default: 50)
  --learning-rate F Learning rate for training (default: 0.5)
  --l2 F            L2 regularization strength (default: 0.001)

Local models are free. Hosted models need an API key in the environment,
never in the config file.`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const useColor = !flagBool(args, 'no-color') && process.stdout.isTTY === true;

  // Handled before the subcommand check, because --version is not a
  // subcommand and must not fall through to the help path.
  if (flagBool(args, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // An explicit --help or help subcommand is a successful request. Only a
  // bare invocation with no arguments at all is an error.
  const wantsHelp = flagBool(args, 'help') || args.command === 'help';

  // Per-command help, printed before the config is loaded: `agent --help`
  // should not fail because the config happens to be malformed.
  if (wantsHelp && args.command) {
    if (args.command === 'agent') {
      process.stdout.write(`${AGENT_HELP}\n`);
      return 0;
    }
    if (args.command === 'build') {
      process.stdout.write(`${BUILD_HELP}\n`);
      return 0;
    }
  }

  if (!args.command || wantsHelp) {
    process.stdout.write(`${HELP}\n`);
    return wantsHelp ? 0 : 1;
  }

  const { config, path: configPath, note } = loadConfig(flagString(args, 'config'));
  if (note && !flagBool(args, 'quiet')) {
    process.stderr.write(`${note}\n`);
  }
  void configPath;

  const json = flagBool(args, 'json');

  switch (args.command) {
    case 'route':
      return cmdRoute(args, config, json, useColor);
    case 'run':
      return await cmdRun(args, config, json);
    case 'feedback':
      return cmdFeedback(config, json);
    case 'train':
      return cmdTrain(args, config, json);
    case 'health':
      return await cmdHealth(args, config, json);
    case 'models':
      return cmdModels(config, json);
    case 'cost':
      return cmdCost(args, config, json);
    case 'safety':
      return cmdSafety(args, config, json);
    case 'approve':
      return cmdApprove(args, config);
    case 'deploy':
      return cmdDeploy(args, config, json);
    case 'agent':
      return await cmdAgent(args, json, useColor);
    case 'build':
      return await cmdBuild(args, json);
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}\n`);
      return 1;
  }
}

// --- commands ---------------------------------------------------------------

function cmdRoute(
  args: ParsedArgs,
  config: GearVaneConfig,
  json: boolean,
  useColor: boolean,
): number {
  const task = flagString(args, 'task');
  if (!task) {
    process.stderr.write('route requires --task\n');
    return 1;
  }

  // A trained model file from `gearvane train` engages the hybrid
  // classifier; without one (or with it disabled) the router stays on
  // heuristics, exactly like the Python router's fallback.
  const orchestrator = new Orchestrator(config, {
    env: process.env as Record<string, string | undefined>,
    learnedModel: loadLearnedModel(config),
  });

  const decision = orchestrator.router.route('cli', {
    description: task,
    filesTouched: flagList(args, 'files'),
    errorLoops: flagNumber(args, 'error-loops') ?? 0,
    testFailures: flagNumber(args, 'test-failures') ?? 0,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return 0;
  }

  const bold = useColor ? '[1m' : '';
  const reset = useColor ? '[0m' : '';

  const lines = [
    `${bold}${decision.tier}${reset}  ${decision.provider.name}/${decision.model}`,
    `confidence  ${Math.round(decision.confidence * 100)}%`,
  ];

  for (const reason of decision.reasons) lines.push(`  - ${reason}`);
  if (decision.escalated) lines.push('escalated: previous attempts failed');

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function cmdRun(
  args: ParsedArgs,
  config: GearVaneConfig,
  json: boolean,
): Promise<number> {
  const task = flagString(args, 'task');
  if (!task) {
    process.stderr.write('run requires --task\n');
    return 1;
  }

  const orchestrator = new Orchestrator(config, {
    env: process.env as Record<string, string | undefined>,
  });

  const options = {
    filesTouched: flagList(args, 'files'),
    errorLoops: flagNumber(args, 'error-loops') ?? 0,
    testFailures: flagNumber(args, 'test-failures') ?? 0,
    system: flagString(args, 'system'),
    temperature: flagNumber(args, 'temperature') ?? 0,
    maxTokens: flagNumber(args, 'max-tokens') ?? 2048,
  };

  const taskId = `cli-${Date.now().toString(36)}`;

  if (flagBool(args, 'stream')) {
    // Streaming is not budget-gated because usage is unknown until the end.
    let wrote = false;
    try {
      for await (const token of orchestrator.executeStream(taskId, task, options)) {
        process.stdout.write(token);
        wrote = true;
      }
    } catch (error) {
      process.stderr.write(`\nstream failed: ${(error as Error).message}\n`);
      return 1;
    }
    if (wrote) process.stdout.write('\n');
    return 0;
  }

  const result = await orchestrator.execute(taskId, task, options);

  // Close the feedback loop: the prediction was the router's first pick,
  // the outcome is the tier that served the request.
  recordRunFeedback(config, taskId, task, result);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : 1;
  }

  printExecution(result);
  return result.success ? 0 : 1;
}

function printExecution(result: ExecutionResult): void {
  const status = result.success ? 'ok' : 'FAILED';
  process.stdout.write(`${status}  ${result.taskId}\n`);

  if (result.tier) {
    process.stdout.write(`tier      ${result.tier} (${result.provider}/${result.model})\n`);
  }
  process.stdout.write(
    `attempts  ${result.attempts}${result.escalated ? ' (escalated)' : ''}\n`,
  );
  process.stdout.write(`tokens    ${result.tokensIn} in / ${result.tokensOut} out\n`);
  process.stdout.write(`cost      $${result.costUsd.toFixed(4)}\n`);
  process.stdout.write(`duration  ${result.durationMs}ms\n`);

  if (result.error) process.stderr.write(`error     ${result.error}\n`);
  if (result.success) {
    process.stdout.write(`\n${result.content}\n`);
  }
}

async function cmdHealth(
  args: ParsedArgs,
  config: GearVaneConfig,
  json: boolean,
): Promise<number> {
  const offline = flagBool(args, 'offline');
  const localOnly = [...LOCAL_PROVIDER_NAMES];

  const scoped: GearVaneConfig = offline
    ? {
        ...config,
        tiers: {
          ...config.tiers,
          local: config.tiers.local,
          mid: { ...config.tiers.mid, providers: [] },
          frontier: { ...config.tiers.frontier, providers: [] },
        },
      }
    : config;

  if (offline) {
    // Keep only local providers even if a local tier lists a hosted one.
    for (const tier of ['local'] as const) {
      scoped.tiers[tier] = {
        ...scoped.tiers[tier],
        providers: scoped.tiers[tier].providers.filter((provider) =>
          localOnly.includes(provider.name.toLowerCase()),
        ),
      };
    }
  }

  const checker = new HealthChecker(scoped, undefined, { timeoutMs: 5000 });
  const results = await checker.checkAll();

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  const markers: Record<string, string> = {
    healthy: 'ok',
    degraded: 'degraded',
    unhealthy: 'unhealthy',
    unknown: 'unknown',
  };

  for (const result of results) {
    process.stdout.write(
      `${markers[result.status] ?? '?'}  ${result.provider}/${result.model}  ` +
        `${Math.round(result.latencyMs)}ms  ${result.message}\n`,
    );
  }

  const counts = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0 };
  for (const result of results) {
    if (result.status in counts) {
      counts[result.status] += 1;
    }
  }

  process.stdout.write(
    `\n${counts.healthy} healthy, ${counts.degraded} degraded, ` +
      `${counts.unhealthy} unhealthy, ${counts.unknown} unknown\n`,
  );

  return counts.unhealthy > 0 ? 1 : 0;
}

async function cmdModels(config: GearVaneConfig, json: boolean): Promise<number> {
  const checker = new HealthChecker(config, undefined, { timeoutMs: 3000 });
  const results = await checker.checkAll();

  const local = results.filter((result) =>
    (LOCAL_PROVIDER_NAMES as readonly string[]).includes(result.provider.toLowerCase()),
  );

  if (json) {
    process.stdout.write(`${JSON.stringify(local, null, 2)}\n`);
    return 0;
  }

  const reachable = local.filter((result) => result.status === 'healthy');
  process.stdout.write(`local providers: ${local.length - reachable.length === 0 ? 'all reachable' : 'some down'}\n`);

  if (local.length === 0) {
    process.stdout.write(
      'No local models configured. Install Ollama, then: ollama pull qwen2.5-coder\n',
    );
    return 0;
  }

  for (const result of local) {
    process.stdout.write(`  ${result.provider}/${result.model}  ${result.status}\n`);
  }
  return 0;
}

function cmdCost(args: ParsedArgs, config: GearVaneConfig, json: boolean): number {
  const orchestrator = new Orchestrator(config, {
    env: process.env as Record<string, string | undefined>,
  });

  const status = orchestrator.spend.getStatus();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ spend: status, cost: orchestrator.cost.getStats() }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `session  $${status.sessionSpend.toFixed(2)}\n` +
      `day      $${status.daySpend.toFixed(2)}\n` +
      `task     $${status.taskSpend.toFixed(2)}\n`,
  );

  const stats = orchestrator.cost.getStats();
  if (stats.totalCalls > 0) {
    process.stdout.write(
      `\ncalls ${stats.totalCalls}, cost $${stats.totalCostUsd.toFixed(4)}\n`,
    );
  }

  process.stdout.write(
    '\nCosts are per-session; run a task to see them accumulate.\n',
  );
  return 0;
}

/**
 * What `safety spend` reports.
 *
 * The tracker records usage but enforces nothing, because a dollar ceiling on
 * a local model is a ceiling on $0. What a user actually wants to know is
 * which tiers can bill them and what the ceilings are for those, so that is
 * what this prints. An earlier version returned 0 with no output at all,
 * which passed an exit-code check while telling the user nothing.
 */
function reportSpend(config: GearVaneConfig, json: boolean): number {
  const tiers = (['local', 'mid', 'frontier'] as const).map((tier) => {
    const tierConfig = config.tiers[tier];
    const metered = tierConfig.costPerToken > 0;
    const providers = tierConfig.providers
      .map((provider) => provider.name)
      .filter((name, index, all) => all.indexOf(name) === index);
    return {
      tier,
      // A zero rate means the run cannot cost money, whatever the token count.
      free: !metered,
      costPerToken: tierConfig.costPerToken,
      meteredProviders: metered ? providers : [],
      localProviders: metered ? [] : providers,
    };
  });

  const hosted = tiers.filter((tier) => !tier.free);
  const payload = {
    spend: { sessionUsd: 0, dayUsd: 0, taskUsd: 0 },
    enforced: false,
    tiers,
    note:
      'Local models cost nothing per token, so no ceiling is enforced on them. ' +
      'Usage is tracked and reported by `gearvane cost`.',
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const lines: string[] = [];
  for (const tier of tiers) {
    if (tier.free) {
      lines.push(
        `${tier.tier.padEnd(9)} unlimited, $0.00  (${tier.localProviders.join(', ')})`,
      );
      continue;
    }
    const names = tier.meteredProviders.length > 0
      ? tier.meteredProviders.join(', ')
      : 'no hosted provider configured';
    lines.push(`${tier.tier.padEnd(9)} metered, $${tier.costPerToken}/token  (${names})`);
  }

  if (hosted.length === 0) {
    lines.push('');
    lines.push('Cloud: not configured. Every configured tier is local and free.');
  }

  lines.push('');
  lines.push(payload.note);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function cmdSafety(args: ParsedArgs, config: GearVaneConfig, json: boolean): number {
  const manager = new SafetyManager(config.safety);
  const action = args.positionals[0];

  switch (action) {
    case 'check': {
      const command = flagString(args, 'command');
      if (!command) {
        process.stderr.write('safety check requires --command\n');
        return 1;
      }
      const request = manager.check(command);
      const payload = { ...request, command };
      if (json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stdout.write(`${request.status}  ${request.operation}\n  ${request.reason}\n`);
      }
      return request.status === 'denied' ? 1 : 0;
    }

    case 'pending': {
      const pending = manager.getPendingApprovals();
      if (json) {
        process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
        return 0;
      }
      if (pending.length === 0) {
        process.stdout.write('No pending approvals\n');
        return 0;
      }
      for (const request of pending) {
        process.stdout.write(`${request.operation}  ${request.command}\n`);
      }
      return 0;
    }

    case 'spend':
    case undefined: {
      return reportSpend(config, json);
    }

    default:
      process.stderr.write(`Unknown safety action: ${action}\n`);
      return 1;
  }
}

function cmdApprove(args: ParsedArgs, config: GearVaneConfig): number {
  const manager = new SafetyManager(config.safety);
  const command = flagString(args, 'command');

  if (command) {
    const ok = manager.approveCommand(command);
    process.stdout.write(ok ? `approved: ${command}\n` : `no pending approval for: ${command}\n`);
    return ok ? 0 : 1;
  }

  const pending = manager.getPendingApprovals();
  if (pending.length === 0) {
    process.stdout.write('No pending approvals\n');
    return 0;
  }
  for (const request of pending) {
    manager.approve(request);
    process.stdout.write(`approved: ${request.command}\n`);
  }
  return 0;
}

function cmdDeploy(args: ParsedArgs, config: GearVaneConfig, json: boolean): number {
  const manager = new SafetyManager(config.safety);
  const tool = args.positionals[0];
  const action = args.positionals[1];
  const dryRun = flagBool(args, 'dry-run');

  const commands: Record<string, string> = {
    'github push': `git push origin ${flagString(args, 'branch') ?? 'main'}`,
    'github status': 'git status',
    'github log': `git log --oneline -n ${flagNumber(args, 'n') ?? 10}`,
    'docker build': `docker build -t ${flagString(args, 'tag') ?? 'gearvane:local'} .`,
    'docker push': `docker push ${flagString(args, 'tag') ?? 'gearvane:local'}`,
  };

  const key = `${tool} ${action ?? ''}`;
  const command = commands[key];

  if (!command) {
    process.stderr.write(
      `Unknown deployment: ${key}\nSupported: ${Object.keys(commands).join(', ')}\n`,
    );
    return 1;
  }

  // The string that is checked must be the string that would run.
  const request = manager.check(command);

  if (request.status === 'denied') {
    process.stderr.write(`denied: ${request.reason}\n`);
    return 1;
  }

  if (request.status === 'pending') {
    process.stderr.write(
      `approval required: ${request.reason}\n` +
        `Approve with: gearvane approve --command "${command}"\n`,
    );
    return 1;
  }

  if (dryRun) {
    const payload = { command, status: 'dry-run', output: `[dry run] ${command}` };
    if (json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`[dry run] ${command}\n`);
    }
    return 0;
  }

  process.stderr.write(
    'Deployment execution is not performed by this CLI.\n' +
      'Run the command yourself once approved, or use the Python CLI which shells out.\n',
  );
  return 0;
}

// --- entry ------------------------------------------------------------------

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`config error: ${error.message}\n`);
    } else {
      process.stderr.write(
        `error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  });

export type { ClassificationResult, HealthResult };