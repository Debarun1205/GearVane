import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SafetyManager, defaultConfig } from '@gearvane/core';

import { commandVerifier, inferVerifyCommand } from '../src/command-verifier.js';

/**
 * The verifier executes a subprocess, so every test here is about the three ways
 * that can go wrong:
 *
 * 1. Running something the safety gate would not allow. It must come back
 *    unknown rather than running, and unknown rather than failing - a refused
 *    check is not a wrong answer.
 * 2. Reporting infrastructure failure as answer failure, which would escalate
 *    on every task and spend a frontier model for nothing.
 * 3. Capturing the wrong part of the output. The failure is at the end.
 */

/** A gate with a known allowlist, so outcomes are deterministic. */
function gate(allowed: string[]): SafetyManager {
  const base = defaultConfig();
  return new SafetyManager({
    ...base.safety,
    sandboxAllowed: allowed,
    requireApproval: [],
  });
}

function scratch(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-verify-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const ctx = {} as { signal?: AbortSignal };

describe('commandVerifier', () => {
  it('passes when the command exits zero', async () => {
    const dir = scratch();
    const verify = commandVerifier({
      command: 'node -e "process.exit(0)"',
      safety: gate([]),
      cwd: dir,
    });
    expect((await verify('', ctx)).outcome).toBe('pass');
  });

  it('fails when the command exits non-zero, with the output as detail', async () => {
    const dir = scratch();
    const verify = commandVerifier({
      command: 'node -e "console.error(\'3 tests failed\'); process.exit(1)"',
      safety: gate([]),
      cwd: dir,
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('fail');
    // The next attempt is prompted with this, so it has to be in here.
    expect(result.detail).toContain('3 tests failed');
    expect(result.detail).toContain('exited 1');
  });

  it('returns unknown, not fail, when the command cannot run', async () => {
    // A check that could not run has confirmed nothing. Reporting fail would
    // escalate every task on this machine.
    const verify = commandVerifier({
      command: 'definitely-not-a-real-command-xyz',
      safety: gate([]),
      cwd: scratch(),
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toMatch(/could not run|not found/i);
  });

  it('returns unknown, not fail, when the gate denies the command', async () => {
    // The refused-check case. Escalating here would charge a frontier model for
    // a safety decision.
    const base = defaultConfig();
    const verify = commandVerifier({
      command: 'rm -rf /',
      safety: new SafetyManager({
        ...base.safety,
        requireApproval: [],
        blockedCommands: ['rm -rf'],
      }),
      cwd: scratch(),
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toMatch(/blocked/i);
  });

  it('returns unknown, and says approval is needed, when the gate pends', async () => {
    // The actionable case: the user needs to know what to do, not just that
    // something went wrong.
    //
    // `git push` because it is what classifyOperation actually recognises as
    // needing approval. `npm run deploy` would fall through to 'shell' and be
    // auto-approved, which is correct behaviour and a different test.
    const base = defaultConfig();
    const verify = commandVerifier({
      command: 'git push origin main',
      safety: new SafetyManager({
        ...base.safety,
        requireApproval: ['git_push'],
        sandboxAllowed: [],
      }),
      cwd: scratch(),
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toMatch(/approve/);
  });

  it('does not run a gated command, only reports it', async () => {
    // The pend path must not fall through to execution. A verifier that runs
    // what the gate just refused would make the gate decorative.
    const base = defaultConfig();
    const marker = join(scratch(), 'should-not-exist.txt');
    const verify = commandVerifier({
      command: `node -e "require('fs').writeFileSync('${marker}', 'x')" && git push`,
      safety: new SafetyManager({
        ...base.safety,
        requireApproval: ['git_push'],
        sandboxAllowed: [],
      }),
      cwd: scratch(),
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('unknown');
    expect(existsSync(marker)).toBe(false);
  });

  it('runs an allowlisted command', async () => {
    // Proves the gate is consulted rather than every command being refused:
    // if this passes, the refusal above is the gate working, not a stub.
    const verify = commandVerifier({
      command: 'node -e "process.exit(0)"',
      safety: gate(['node -e "process.exit(0)"']),
      cwd: scratch(),
    });
    expect((await verify('', ctx)).outcome).toBe('pass');
  });

  it('keeps the tail of a long failure', async () => {
    // A test runner's signal is at the end. Keeping the head would feed the next
    // model megabytes of progress noise.
    const dir = scratch();
    const script =
      'console.log("START" + "x".repeat(50000)); console.log("THE REAL FAILURE"); process.exit(1)';
    const verify = commandVerifier({
      command: `node -e '${script}'`,
      safety: gate([]),
      cwd: dir,
      maxOutput: 2000,
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('fail');
    expect(result.detail).toContain('THE REAL FAILURE');
    expect(result.detail).not.toContain('STARTxxxx');
  });

  it('returns unknown when the command times out', async () => {
    const verify = commandVerifier({
      command: 'node -e "setTimeout(() => {}, 60000)"',
      safety: gate([]),
      cwd: scratch(),
      timeoutMs: 300,
    });
    const result = await verify('', ctx);
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toMatch(/timed out/);
  });

  it('returns unknown when the caller aborts', async () => {
    const controller = new AbortController();
    const verify = commandVerifier({
      command: 'node -e "setTimeout(() => {}, 60000)"',
      safety: gate([]),
      cwd: scratch(),
    });
    const pending = verify('', { signal: controller.signal });
    controller.abort();
    expect((await pending).outcome).toBe('unknown');
  });
});

describe('inferVerifyCommand', () => {
  it('picks npm test for a Node project', () => {
    expect(inferVerifyCommand(scratch({ 'package.json': '{}' }))).toBe('npm test');
  });

  it('respects a pnpm lockfile', () => {
    expect(
      inferVerifyCommand(
        scratch({ 'package.json': '{}', 'pnpm-lock.yaml': '' }),
      ),
    ).toBe('pnpm test');
  });

  it('picks pytest for a Python project', () => {
    expect(inferVerifyCommand(scratch({ 'pytest.ini': '' }))).toBe('pytest -q');
  });

  it('returns undefined rather than guessing in an empty directory', () => {
    // A wrong guess fails a check that was never the right one, and escalates
    // on that basis. Saying nothing is better.
    expect(inferVerifyCommand(scratch())).toBeUndefined();
  });
});