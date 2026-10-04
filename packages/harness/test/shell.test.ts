import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SafetyManager, type ApprovalRequest, type SafetyConfig } from '@gearvane/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace/containment.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_LENGTH,
  createShellTool,
} from '../src/tools/shell.js';
import type { ToolContext } from '../src/tools/types.js';

/**
 * Command execution tests.
 *
 * These are platform-sensitive by nature, so each case that depends on shell
 * behaviour is written to pass on both Windows and POSIX. The assertions are
 * about the harness's decisions, not about any one shell's output format.
 */

const SAFETY: SafetyConfig = {
  requireApproval: ['git_push', 'deploy_production', 'destructive'],
  
  sandboxAllowed: ['git status', 'echo', 'node', 'pwd'],
  blockedCommands: ['rm -rf', 'sudo', 'format'],
};

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gearvane-shell-'));
  ctx = { workspace: new Workspace(root), maxReadBytes: 256 * 1024 };
});

function tool(
  overrides: Partial<Parameters<typeof createShellTool>[0]> = {},
): ReturnType<typeof createShellTool> {
  return createShellTool({ safety: new SafetyManager(SAFETY), ...overrides });
}

async function run(
  command: string,
  overrides: Partial<Parameters<typeof createShellTool>[0]> = {},
): Promise<{ ok: boolean; content: string }> {
  return tool(overrides).execute({ command }, ctx);
}

describe('running a command', () => {
  it('runs an allowlisted command', async () => {
    const result = await run('echo hello');
    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello');
  });

  it('reports the exit status and duration', async () => {
    const result = await run('echo hi');
    expect(result.content).toContain('exited 0');
    expect(result.content).toMatch(/in \d+ms/);
  });

  it('captures stderr separately', async () => {
    const result = await run('node -e "console.error(\'bad\')"');
    expect(result.content).toContain('[stderr]');
    expect(result.content).toContain('bad');
  });

  it('treats a non-zero exit as information, not a harness failure', async () => {
    // Failing the tool here would end the task on the first failed test run,
    // which is the single most common thing an agent does.
    const result = await run('node -e "process.exit(3)"');
    expect(result.content).toContain('exited 3');
    expect(result.ok).toBe(false);
  });

  it('handles a multi-stage pipeline', async () => {
    // Pipes are why the command runs through a shell at all. Written with
    // node rather than tr so the case behaves the same on cmd.exe and sh.
    const result = await run(
      'echo one two three | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>console.log(d.trim().split(/\\s+/).join(\'-\')))"',
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('one-two-three');
  });
});

describe('working directory confinement', () => {
  it('starts the process in the workspace', async () => {
    const result = await run('node -e "console.log(process.cwd())"');
    expect(result.ok).toBe(true);

    // Compared case-insensitively and ignoring separator direction: Windows
    // reports a drive letter and backslashes, and the temp directory contains
    // a space that has to be collapsed before substring matching.
    const reported = result.content.toLowerCase().replace(/\\/g, '/');
    const expected = root.toLowerCase().replace(/\\/g, '/');
    expect(reported).toContain(expected);
  });

  it('does not run in the process working directory', async () => {
    // The case that matters once the harness is embedded in an app: the app's
    // cwd is wherever the user launched it, which is not the project.
    const result = await run('node -e "console.log(process.cwd())"');
    const reported = result.content.toLowerCase().replace(/\\/g, '/');
    const here = process.cwd().toLowerCase().replace(/\\/g, '/');

    // The repository root is not the temp workspace the test created.
    expect(reported).not.toContain(here);
  });

  it('writes a relative file into the workspace', async () => {
    await run('node -e "require(\'fs\').writeFileSync(\'made.txt\',\'x\')"');
    expect(await readFile(join(root, 'made.txt'), 'utf8')).toBe('x');
  });
});

describe('blocked commands', () => {
  it('never runs a blocked command', async () => {
    const result = await run('rm -rf everything');
    expect(result.ok).toBe(false);
    expect(result.content).toContain('blocked by configuration');
  });

  it('says the block cannot be approved', async () => {
    // Otherwise a caller might retry with an approver and assume it helps.
    const result = await run('sudo ls', { approve: () => true });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('cannot be approved');
  });

  it('does not run the blocked command', async () => {
    const marker = join(root, 'still-here.txt');
    await writeFile(marker, 'intact');

    await run('rm -rf .');
    expect(await readFile(marker, 'utf8')).toBe('intact');
  });
});

describe('approval gating', () => {
  it('refuses a gated command with no approver configured', async () => {
    // The safe default: an unattended agent must not be able to talk itself
    // past a gate nobody is watching.
    const result = await run('git push origin main');
    expect(result.ok).toBe(false);
    expect(result.content).toContain('approval required');
    expect(result.content).toContain('no approver is configured');
  });

  it('names the operation so a UI can label the prompt', async () => {
    const result = await run('git push origin main');
    expect(result.content).toContain('git_push');
  });

  it('runs a gated command once approved', async () => {
    // npm publish is classified deploy_production and therefore pending. Using
    // it rather than git status, which is on the sandbox allowlist and so never
    // reaches the approver at all.
    const result = await run('npm publish --dry-run', { approve: () => true });
    expect(result.content).not.toContain('approval required');
    expect(result.content).not.toContain('declined');
  });

  it('reports a declined approval', async () => {
    const result = await run('git push origin main', { approve: () => false });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('declined');
  });

  it('supports an async approver', async () => {
    const result = await run('npm publish --dry-run', {
      approve: async () => {
        await Promise.resolve();
        return true;
      },
    });
    expect(result.content).not.toContain('approval required');
  });

  it('auto-approves an allowlisted command without consulting the approver', async () => {
    // If the allowlist stopped working, every command would prompt, which is
    // the kind of regression that only shows up as user annoyance.
    let consulted = false;
    const result = await run('echo hi', {
      approve: () => {
        consulted = true;
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(consulted).toBe(false);
  });

  it('passes the full decision to the approver', async () => {
    const seen: ApprovalRequest[] = [];
    await run('npm publish', {
      approve: (request) => {
        seen.push(request);
        return true;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.operation).toBe('deploy_production');
    expect(seen[0]?.command).toContain('npm publish');
    expect(seen[0]?.reason).toBeTruthy();
  });
});

describe('environment isolation', () => {
  it('does not leak provider keys to the child', async () => {
    // A build script that prints its environment would otherwise hand the
    // credentials to anything reading the output.
    const marker = 'GEARVANE_FAKE_SECRET_KEY';
    process.env[marker] = 'super-secret-value';
    try {
      const result = await run(`node -e "console.log(process.env.${marker})"`);
      expect(result.ok).toBe(true);
      expect(result.content).not.toContain('super-secret-value');
    } finally {
      delete process.env[marker];
    }
  });

  it('still passes PATH', async () => {
    // Without it almost nothing runs on either platform.
    const result = await run('node -e "console.log(Boolean(process.env.PATH))"');
    expect(result.content).toContain('true');
  });

  it('passes an explicitly allowed variable', async () => {
    const result = await run('node -e "console.log(process.env.MY_VAR)"', {
      extraEnv: { MY_VAR: 'allowed' },
    });
    expect(result.content).toContain('allowed');
  });

  it('opts into the full environment when asked', async () => {
    const marker = 'GEARVANE_INHERIT_TEST';
    process.env[marker] = 'inherited';
    try {
      const result = await run(`node -e "console.log(process.env.${marker})"`, {
        inheritEnv: true,
      });
      expect(result.content).toContain('inherited');
    } finally {
      delete process.env[marker];
    }
  });
});

describe('bounds', () => {
  it('kills a command that runs too long', async () => {
    const result = await run('node -e "setTimeout(()=>{},60000)"', {
      timeoutMs: 400,
    });
    expect(result.content).toContain('timed out');
    expect(result.ok).toBe(false);
  });

  it('settles promptly when a command is killed', async () => {
    // Regression. With shell: true the direct child is the shell, so killing
    // it left the real program running and still holding the inherited pipes.
    // 'close' never fired and the promise never settled, which hung the agent
    // instead of stopping the command. Verified against the running behaviour
    // before fixing: no close event within three seconds.
    const started = Date.now();
    const result = await run('node -e "setTimeout(()=>{},60000)"', {
      timeoutMs: 300,
    });

    expect(result.content).toContain('timed out');
    // Comfortably inside the 5s test timeout, and nowhere near the 60s the
    // command wanted to run for.
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('does not report a timeout as an ordinary non-zero exit', async () => {
    // The exit code of a process killed on purpose is noise. Reporting
    // "exited 1" would read as a command failure rather than a harness
    // decision, and the model would retry something that was never broken.
    const result = await run('node -e "setTimeout(()=>{},60000)"', {
      timeoutMs: 300,
    });

    expect(result.content).toContain('timed out');
    expect(result.content).not.toMatch(/exited \d/);
  });

  it('kills a command whose output already arrived', async () => {
    // The shape that exposed the hang: output flushed, then the process hung
    // on a timer while still holding the pipes open.
    const result = await run(
      'node -e "console.log(1);setInterval(()=>{},1000)"',
      { timeoutMs: 400 },
    );

    expect(result.content).toContain('1');
    expect(result.content).toContain('timed out');
  });

  it('truncates output past the cap', async () => {
    const result = await run(
      'node -e "for(let i=0;i<5000;i++)console.log(\'line \'+i+\' \'.repeat(40))"',
      { maxOutputBytes: 2048 },
    );
    expect(result.content).toContain('truncated');
  });

  it('refuses an over-long command', async () => {
    const result = await run('x'.repeat(MAX_COMMAND_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.content).toContain('over the');
  });

  it('refuses an empty command', async () => {
    expect((await run('   ')).ok).toBe(false);
  });

  it('reports a missing command', async () => {
    const result = await tool().execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('command is required');
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const promise = tool({ timeoutMs: 30_000 }).execute(
      { command: 'node -e "setTimeout(()=>{},30000)"' },
      { ...ctx, signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.ok).toBe(false);
  });
});

describe('what this module claims about itself', () => {
  it('says in its own source that it is not a sandbox', async () => {
    // The most important assertion in this file. Gating is not containment:
    // an approved command can still reach the whole filesystem, and real
    // containment needs an OS boundary. If the claim is ever deleted from the
    // module, the claim is lost with it.
    //
    // Matched against whitespace-collapsed source, because the sentences wrap
    // across comment lines and a naive regex sees "**not a\n * sandbox**" as
    // two separate fragments. That wrapping is exactly why an earlier version
    // of this test failed for the wrong reason.
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(
      new URL('../src/tools/shell.ts', import.meta.url),
      'utf8',
    );
    const source = raw.replace(/\s+/g, ' ');

    expect(source).toMatch(/not a sandbox/i);
    expect(source).toMatch(/needs an OS boundary/i);
  });

  it('has a bounded default timeout', () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});