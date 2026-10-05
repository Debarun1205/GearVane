import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'packages', 'cli', 'src', 'bin.ts');

const built = existsSync(join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js'));

/**
 * Run the CLI through tsx so tests do not depend on a prior build.
 * Falls back to the built output when dist exists.
 */
function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const command = built
    ? ['node', join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js'), ...args]
    : ['npx', 'tsx', ENTRY, ...args];

  try {
    const stdout = execFileSync(command[0] as string, command.slice(1), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: err.status ?? 1,
    };
  }
}

describe('CLI end to end', () => {
  it('prints help with no arguments and exits non-zero', () => {
    const result = run([]);
    expect(result.stdout).toMatch(/route/);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.code).toBe(1);
  });

  it('prints help for the help command and exits zero', () => {
    const result = run(['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
  });

  it('prints the version', () => {
    const result = run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('routes a task', () => {
    const result = run(['route', '--task', 'Fix a typo in the readme']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/local|mid|frontier/);
    expect(result.stdout).toMatch(/confidence/);
  });

  it('routes a task as JSON', () => {
    const result = run(['route', '--task', 'Refactor the auth architecture', '--json']);
    expect(result.code).toBe(0);
    const decision = JSON.parse(result.stdout) as { tier: string; model: string };
    expect(decision.tier).toMatch(/local|mid|frontier/);
    expect(decision.model.length).toBeGreaterThan(0);
  });

  it('requires --task for route', () => {
    const result = run(['route']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/requires --task/);
  });

  it('rejects an unknown command with usage', () => {
    const result = run(['nonsense']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown command/);
  });

  it('reports safety status', () => {
    const result = run(['safety', 'spend']);
    expect(result.code).toBe(0);
    // Spend limits removed; command should succeed with empty output
    expect(result.stdout).toBe('');
  });

  it('checks a command against the gates', () => {
    const result = run(['safety', 'check', '--command', 'git push origin main', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { status: string; operation: string };
    expect(payload.operation).toBe('git_push');
    expect(payload.status).toBe('pending');
  });

  it('classifies a push as pending rather than approved', () => {
    // Regression: a bare "push" subcommand classified as shell and
    // auto-approved. The CLI must pass the full command line.
    const result = run(['safety', 'check', '--command', 'git push origin main', '--json']);
    const payload = JSON.parse(result.stdout) as { status: string };
    expect(payload.status).toBe('pending');
  });

  it('denies a blocked command', () => {
    const result = run(['safety', 'check', '--command', 'rm -rf /', '--json']);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as { status: string };
    expect(payload.status).toBe('denied');
  });

  it('auto-approves an allowlisted command', () => {
    const result = run(['safety', 'check', '--command', 'git status', '--json']);
    const payload = JSON.parse(result.stdout) as { status: string };
    expect(payload.status).toBe('auto_approved');
  });

  it('reports no pending approvals on a fresh run', () => {
    const result = run(['safety', 'pending']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No pending approvals/);
  });

  it('refuses a gated deploy even in dry run', () => {
    // Dry run previews a command; it must not make a gated command look safe.
    const result = run(['deploy', 'github', 'push', '--dry-run']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/approval required/);
    expect(result.stdout).not.toMatch(/dry run/);
  });

  it('allows an ungated deploy in dry run', () => {
    const result = run(['deploy', 'github', 'status', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/dry run/);
    expect(result.stdout).toMatch(/git status/);
  });

  it('rejects an unknown deployment action', () => {
    const result = run(['deploy', 'heroku', 'deploy']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown deployment/);
  });

  it('reports health without crashing when nothing is running', () => {
    const result = run(['health', '--offline']);
    // No local servers are running, so models are degraded, but the command
    // must still produce a summary rather than a traceback.
    expect(result.stdout).not.toMatch(/Traceback/);
    expect(result.stdout).toMatch(/healthy/);
  });

  it('lists local models without crashing', () => {
    const result = run(['models']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/Traceback/);
  });

  it('reports cost state', () => {
    const result = run(['cost']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/session/);
  });
});