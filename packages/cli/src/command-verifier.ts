/**
 * Verification by running the project's own command.
 *
 * The CLI is where this is real rather than theoretical: it runs in a checkout,
 * so the project's tests, typecheck, or lint are one subprocess away. Core
 * cannot own that, because "correct" is a property of the project and running
 * anything needs a shell the engine has no business opening.
 *
 * ## Why the gate still applies
 *
 * This verifier executes a command, so it goes through the same SafetyManager
 * check as any other gated operation rather than running whatever string it is
 * handed. A verifier whose command is not allowlisted comes back `unknown` -
 * not a failure. The distinction matters: "the check was refused" is not "the
 * answer is wrong", and escalating on the first would burn a frontier model
 * every time someone configures a command needing approval.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SafetyManager } from '@gearvane/core';
import type { VerificationResult } from '@gearvane/core';

/** A project command to check an answer with. */
export interface CommandVerifierOptions {
  /** The project command, e.g. `npm test`. */
  command: string;
  safety: SafetyManager;
  /** Working directory. Defaults to the process cwd. */
  cwd?: string;
  /** Give up on the command after this long. */
  timeoutMs?: number;
  /** Cap on captured output, keeping the tail. */
  maxOutput?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * How a shell reports a command it could not find.
 *
 * Best-effort and locale-dependent: it is a text match because the exit code is
 * not portable (127 on POSIX, 1 through cmd.exe). Being wrong here fails towards
 * 'unknown', which stops an escalation rather than starting one.
 */
const NOT_FOUND =
  /not recognized as an internal or external command|command not found|No such file or directory|not found:/i;
const DEFAULT_MAX_OUTPUT = 8000;

/** Default cap on what is kept from a long run. */
export { DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS };

/**
 * Run a command and turn its exit status into a verdict.
 *
 * Exit 0 is a pass. Non-zero is a fail, with the output as the detail the next
 * attempt is prompted with. A refusal, a timeout, or a spawn failure is
 * unknown - the check did not conclude, and saying otherwise would escalate on
 * our own infrastructure rather than on the answer.
 */
export function commandVerifier(options: CommandVerifierOptions): (
  content: string,
  context: { signal?: AbortSignal },
) => Promise<VerificationResult> {
  const { command, safety, cwd = process.cwd() } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;

  return async (_content, context) => {
    const request = safety.check(command);
    if (request.status === 'denied') {
      return {
        outcome: 'unknown',
        detail: `Verification command is blocked: ${request.reason}`,
      };
    }
    if (request.status === 'pending') {
      return {
        outcome: 'unknown',
        detail:
          `Verification command needs approval (${request.operation}). ` +
          'Run `gearvane approve`, or allowlist it, to enable verification.',
      };
    }

    return runCommand(command, cwd, timeoutMs, maxOutput, context.signal);
  };
}

/** Spawn the command and interpret its result. */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutput: number,
  signal: AbortSignal | undefined,
): Promise<VerificationResult> {
  return new Promise<VerificationResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });

    let output = '';
    let settled = false;

    const finish = (result: VerificationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        outcome: 'unknown',
        detail: `Verification command timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill();
      finish({ outcome: 'unknown', detail: 'Verification cancelled' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (chunk: Buffer): void => {
      // Keep the tail: a test runner's failure is at the end, and the head is
      // progress noise that would crowd out the signal.
      output = (output + chunk.toString()).slice(-maxOutput);
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (error) => {
      finish({
        outcome: 'unknown',
        detail: `Verification command could not run: ${error.message}`,
      });
    });

    child.on('close', (code, killedBySignal) => {
      if (killedBySignal) {
        finish({ outcome: 'unknown', detail: 'Verification cancelled' });
        return;
      }
      if (code === 0) {
        finish({ outcome: 'pass' });
        return;
      }

      // A command that does not exist exits non-zero through the shell instead
      // of failing to spawn, so without this it reads as a failed check. That is
      // a trap rather than a safety net: a typo in the verify command would fail
      // every task, escalate it twice, and spend a frontier model each time - all
      // because of a misspelling.
      if (code === 127 || NOT_FOUND.test(output)) {
        finish({
          outcome: 'unknown',
          detail:
            `Verification command could not run: \`${command}\` was not found. ` +
            'Check the command and try again.',
        });
        return;
      }

      finish({
        outcome: 'fail',
        detail: `\`${command}\` exited ${code}\n${output}`.trim(),
      });
    });
  });
}

/**
 * Guess the project command to verify with, or undefined if it is ambiguous.
 *
 * Only unambiguous cases are inferred. A project with a test script picks
 * `npm test`; a Python project with pytest picks `pytest`. A project with
 * neither, or with several equally plausible commands, returns undefined so the
 * caller reports that it found nothing - because a wrong guess fails a check
 * that was never the right one, and escalates on that basis.
 */
export function inferVerifyCommand(cwd: string): string | undefined {
  const has = (...parts: string[]): boolean =>
    parts.every((part) => existsSync(join(cwd, part)));

  // A package manager's own test invocation, chosen by lockfile so the inferred
  // command matches the project. npm needs no lockfile, and is the fallback.
  if (has('package.json')) {
    if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm test';
    if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn test';
    return 'npm test';
  }

  // Python: a tests directory is the marker.
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'tests'))) {
    return 'pytest -q';
  }

  return undefined;
}
