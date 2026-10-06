/**
 * Command execution.
 *
 * ## What this is and is not
 *
 * This tool gates commands and pins the working directory.
 *
 * It is **not a sandbox**, and nothing here can make it one.
 *
 * A user who approves `curl https://example.com` has allowed a process that can
 * read every file the user can read. Pinning `cwd` does not change that, and
 * neither does the allowlist. Real containment needs an OS boundary: a
 * container, a job object, seccomp, or a VM.
 *
 * What this layer does provide:
 *
 * - commands on the blocklist never run
 * - commands classified as consequential require an explicit decision
 * - simple commands run with no shell at all, so the checked string and
 *   the executed argv are the same by construction
 * - compound commands (pipes, `;`, `$(...)`) run through a shell with the
 *   exact string that was checked
 * - the process starts in the workspace, so relative paths land there
 * - the child does not inherit the provider API keys
 * - output and runtime are bounded
 *
 * That is meaningfully safer than running whatever a model prints. It is not
 * containment, and the tests assert this module keeps saying so.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { parseCommand, rejoinArgv, type ApprovalRequest, type SafetyManager } from '@gearvane/core';

import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

/** Default wall-clock ceiling for one command. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Default cap on captured output, across stdout and stderr combined. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Longest command string accepted. */
export const MAX_COMMAND_LENGTH = 4000;

/**
 * How long to wait for a killed process tree to close before settling anyway.
 *
 * Long enough for an orderly exit, short enough that a stuck pipe does not
 * become a hung agent.
 */
export const KILL_GRACE_MS = 500;

/**
 * Environment variables passed to the child.
 *
 * The child does not inherit the full environment. Provider API keys are held
 * in the parent process, and a build script or test runner that prints its
 * environment would otherwise hand them to anything that reads the output, or
 * to a log.
 *
 * Windows needs SystemRoot or a large amount of Windows tooling fails in
 * confusing ways, so it is included.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'COMSPEC',
  'PATHEXT',
  'JAVA_HOME',
  'NODE_ENV',
  'GOPATH',
  'GOROOT',
  'VIRTUAL_ENV',
  'PYTHONPATH',
] as const;

export interface ShellToolOptions {
  safety: SafetyManager;

  /**
   * Called for commands that require approval.
   *
   * Absent means nothing can be approved, so a gated command fails. That is
   * the safe default for a headless caller: an unattended agent must not be
   * able to talk itself past a gate nobody is watching.
   */
  approve?: (request: ApprovalRequest) => Promise<boolean> | boolean;

  timeoutMs?: number;
  maxOutputBytes?: number;

  /** Extra variables to pass through, on top of the allowlist. */
  extraEnv?: Record<string, string>;

  /**
   * Keep the whole parent environment.
   *
   * Off by default because it hands provider credentials to every child
   * process. Turn it on only when a command genuinely needs it.
   */
  inheritEnv?: boolean;
}

/** Collect the variables the child is allowed to see. */
function buildEnv(options: ShellToolOptions): NodeJS.ProcessEnv {
  if (options.inheritEnv) {
    return { ...process.env };
  }

  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(options.extraEnv ?? {})) {
    env[name] = value;
  }

  return env;
}

interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` alone is not enough, and the failure is nasty rather than
 * obvious. With `shell: true` the direct child is the shell, not the command:
 * killing it on Windows leaves the actual program running, still holding the
 * inherited stdout and stderr pipes. `close` therefore never fires and the
 * promise never settles, so a timed-out command hangs the agent instead of
 * stopping it. Verified rather than assumed.
 *
 * Windows has `taskkill /T` for exactly this. Elsewhere a negative pid kills
 * the process group, which requires spawning detached so the child becomes a
 * group leader.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {
        // The tree may already be gone; fall back to the direct child.
        child.kill('SIGKILL');
      });
      return;
    } catch {
      child.kill('SIGKILL');
      return;
    }
  }

  try {
    // Negative pid signals the whole process group.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Shared observation body: collect output, bound the runtime, kill the tree
 * on timeout or abort, and settle.
 *
 * `onSpawnError`, when given, replaces the default error settle: the caller
 * takes over (the execFile fallback re-runs the command through a shell), so
 * this promise must not also settle with a bogus outcome.
 */
function observe(
  child: ChildProcess,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  onSpawnError?: (error: Error) => void,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    // A spawn that failed also emits 'close' on Windows, with a meaningless
    // negative code. Once the error path has taken over, no later event may
    // settle this promise.
    let failed = false;

    const collect = (chunk: Buffer, into: 'out' | 'err') => {
      if (truncated) return;

      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        truncated = true;
        return;
      }

      const text = chunk.toString('utf8');
      if (into === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    // Settle on a timer after a kill rather than waiting on 'close'.
    //
    // A killed tree may keep a pipe open, in which case 'close' is unreliable
    // and a promise that waits on it hangs forever. The caller is told the
    // command timed out either way, so settling early is strictly better than
    // never settling.
    const settleAfterKill = (graceMs: number): void => {
      setTimeout(() => finish(null, 'SIGKILL'), graceMs);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      settleAfterKill(KILL_GRACE_MS);
    }, timeoutMs);

    const onAbort = (): void => {
      killTree(child);
      settleAfterKill(KILL_GRACE_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    function finish(code: number | null, sig: NodeJS.Signals | null): void {
      if (settled || failed) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        code,
        signal: sig,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    }

    child.on('error', (error) => {
      if (onSpawnError) {
        // The caller re-runs the command another way; stop the clock here.
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        failed = true;
        onSpawnError(error);
        return;
      }
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      finish(null, null);
    });

    child.on('close', finish);
  });
}

/**
 * Run a command string through a shell.
 *
 * Only for compound commands — pipes, redirections, `$(...)`, `;` — that an
 * agent legitimately needs. The gate checked this exact string, and the same
 * string is what runs, so nothing can be injected between check and exec.
 */
function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  return observe(
    spawn(command, {
      // The command string is handed to a shell, because an agent legitimately
      // needs pipes and redirection. That is also why the gating above is
      // load-bearing rather than advisory.
      shell: true,
      cwd,
      env,
      windowsHide: true,
      // Makes the child a process group leader on POSIX so the whole tree can
      // be signalled at once. Harmless on Windows.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    timeoutMs,
    maxOutputBytes,
    signal,
  );
}

/**
 * Run a simple command with no shell at all.
 *
 * The parsed argv is exactly what executes, so no metacharacter can inject
 * a second command — the checked string and the executed argv are the same
 * by construction. Windows cannot exec `.cmd`/`.bat` shims directly (`npm`,
 * `pytest`); the fallback re-runs the exact string through a shell, which is
 * safe precisely because the string carries no shell syntax.
 */
function runExec(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      shell: false,
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const finish = (outcome: RunOutcome): void => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
    child.once('error', () => {
      void runCommand(rejoinArgv(argv), cwd, env, timeoutMs, maxOutputBytes, signal).then(finish);
    });
    void observe(child, timeoutMs, maxOutputBytes, signal, () => {}).then(finish);
  });
}

export function createShellTool(options: ShellToolOptions): Tool {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    schema: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace directory. The command runs ' +
        'with the workspace as its working directory, so relative paths ' +
        'resolve there. Some commands require explicit approval and will ' +
        'fail until approved. Output is truncated past the limit.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command line to run.',
            maxLength: MAX_COMMAND_LENGTH,
          },
          timeout_ms: {
            type: 'integer',
            description: 'Wall-clock limit for this command.',
            default: defaultTimeout,
            minimum: 100,
            maximum: 600_000,
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },

    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const command = args['command'];
      if (typeof command !== 'string' || command.trim() === '') {
        return failure('command is required');
      }

      if (command.length > MAX_COMMAND_LENGTH) {
        return failure(
          `command is ${command.length} characters, over the ${MAX_COMMAND_LENGTH} limit`,
        );
      }

      const requested = args['timeout_ms'];
      const timeoutMs =
        typeof requested === 'number' ? requested : defaultTimeout;

      const decision = options.safety.check(command);

      if (decision.status === 'denied') {
        return failure(
          `refused: ${decision.reason}. This is blocked by configuration and ` +
            'cannot be approved.',
        );
      }

      if (decision.status === 'pending') {
        if (!options.approve) {
          // Headless callers cannot approve, so the gate holds.
          return failure(
            `approval required: ${decision.reason}. Operation ` +
              `'${decision.operation}' is classified as consequential and no ` +
              'approver is configured.',
          );
        }

        const granted = await options.approve(decision);
        if (!granted) {
          return failure(
            `declined: the approval for '${decision.operation}' was refused.`,
          );
        }
        options.safety.approve(decision);
      }

      // A simple command runs with no shell: the parsed argv is exactly what
      // executes. A compound command runs through a shell with the exact
      // string that was checked above.
      const argv = parseCommand(command);
      const outcome =
        argv && argv.length > 0
          ? await runExec(argv, ctx.workspace.root, buildEnv(options), timeoutMs, maxOutput, ctx.signal)
          : await runCommand(command, ctx.workspace.root, buildEnv(options), timeoutMs, maxOutput, ctx.signal);

      const parts: string[] = [];
      if (outcome.stdout.trim()) parts.push(outcome.stdout.trimEnd());
      if (outcome.stderr.trim()) parts.push(`[stderr]\n${outcome.stderr.trimEnd()}`);
      if (outcome.truncated) {
        parts.push(
          `[output truncated at ${maxOutput} bytes; the command may have produced more]`,
        );
      }
      // A timeout is reported instead of the exit status, because the status is
      // meaningless here: it belongs to a process killed on purpose, and
      // "exited 1" alone reads as a command failure rather than a harness
      // decision.
      const description = outcome.timedOut
        ? `timed out after ${timeoutMs}ms and was killed`
        : outcome.code === 0
          ? 'exited 0'
          : outcome.signal
            ? `killed by ${outcome.signal}`
            : `exited ${outcome.code}`;

      parts.push(`[${description} in ${outcome.durationMs}ms]`);

      const body = parts.join('\n');

      // A non-zero exit is information for the model, not a harness failure.
      // Treating it as an error would end the task on the first failed test.
      const succeeded = outcome.code === 0 && !outcome.timedOut;

      return {
        ok: succeeded,
        content: body,
        ...(succeeded ? {} : { error: description }),
      };
    },
  };
}

/** The shell tool wired to the default configuration. */
export function shellTool(options: ShellToolOptions): Tool {
  return createShellTool(options);
}
