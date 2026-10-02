import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The CLI, run as a real subprocess.
 *
 * Invoked rather than imported, because the interesting failures are process
 * level: exit codes, what lands on stdout versus stderr, and whether the
 * binary resolves its workspace dependencies at all.
 */

const exec = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const NODE = process.execPath;

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'waypoint-cli-'));
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(...args: string[]): Promise<Run> {
  try {
    const result = await exec(NODE, [BIN, ...args], {
      cwd: workspace,
      timeout: 60_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('help', () => {
  it('lists the new commands', async () => {
    const result = await run('--help');
    expect(result.stdout).toContain('waypoint agent');
    expect(result.stdout).toContain('waypoint build');
  });

  it('has per-command help for agent', async () => {
    const result = await run('agent', '--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--cwd');
    expect(result.stdout).toContain('--allow-shell');
  });

  it('has per-command help for build', async () => {
    const result = await run('build', '--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--template');
  });

  it('documents that the shell tool is gated rather than sandboxed', async () => {
    // The most important sentences in the help text. An approved command can
    // still reach any file the user can, and there is no sandbox.
    const result = await run('agent', '--help');
    expect(result.stdout).toMatch(/gating, not containment/i);
    expect(result.stdout).toMatch(/can still read any file you can/i);
    expect(result.stdout).toMatch(/there is no sandbox/i);
  });

  it('exits non-zero with no arguments', async () => {
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits zero for help', async () => {
    expect((await run('help')).code).toBe(0);
  });
});

describe('build', () => {
  it('lists templates', async () => {
    const result = await run('build', '--list');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('landing');
    expect(result.stdout).toContain('docs');
    expect(result.stdout).toContain('api');
  });

  it('advertises the flag the command actually accepts', async () => {
    // Regression: --list showed --projectName while build accepted --name, so
    // following the help produced nothing.
    const result = await run('build', '--list');
    expect(result.stdout).toContain('--name (required)');
    expect(result.stdout).not.toContain('--projectName');
  });

  it('scaffolds a landing page', async () => {
    const result = await run(
      'build',
      '--template', 'landing',
      '--name', 'CLI Test',
      '--tagline', 'From the command line',
      '--features', 'One;Two',
      '--out', workspace,
    );

    expect(result.code).toBe(0);
    const html = await readFile(join(workspace, 'index.html'), 'utf8');
    expect(html).toContain('CLI Test');
    expect(html).toContain('One');
  });

  it('writes every file a template produces', async () => {
    await run(
      'build',
      '--template', 'landing',
      '--name', 'X',
      '--tagline', 'Y',
      '--features', 'Z',
      '--out', workspace,
    );

    for (const file of ['index.html', 'styles.css', 'README.md', '.gitignore']) {
      await expect(readFile(join(workspace, file), 'utf8')).resolves.toBeTruthy();
    }
  });

  it('splits semicolons into separate features', async () => {
    await run(
      'build',
      '--template', 'landing',
      '--name', 'X',
      '--tagline', 'Y',
      '--features', 'Alpha;Beta;Gamma',
      '--out', workspace,
    );

    const html = await readFile(join(workspace, 'index.html'), 'utf8');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('Gamma');
  });

  it('scaffolds an api service', async () => {
    const result = await run(
      'build',
      '--template', 'api',
      '--name', 'Widget API',
      '--resource', 'widget',
      '--out', workspace,
    );

    expect(result.code).toBe(0);
    const server = await readFile(join(workspace, 'server.js'), 'utf8');
    expect(server).toContain("node:http");
  });

  it('refuses an unknown template', async () => {
    const result = await run('build', '--template', 'nope', '--name', 'X');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown template');
  });

  it('requires a name', async () => {
    const result = await run('build', '--template', 'landing');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('requires --name');
  });

  it('requires a template', async () => {
    const result = await run('build', '--name', 'X');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('requires --template');
  });

  it('reports a missing required field from the template', async () => {
    // The api template needs a project name; the landing one needs a tagline,
    // which the CLI does not default.
    const result = await run(
      'build', '--template', 'landing', '--name', 'X', '--out', workspace,
    );
    expect(result.code).toBe(1);
  });

  it('refuses to overwrite unless told to', async () => {
    await writeFile(join(workspace, 'index.html'), 'ORIGINAL', 'utf8');

    const blocked = await run(
      'build',
      '--template', 'landing',
      '--name', 'X', '--tagline', 'Y', '--features', 'Z',
      '--out', workspace,
    );

    expect(blocked.code).toBe(1);
    expect(await readFile(join(workspace, 'index.html'), 'utf8')).toBe('ORIGINAL');
  });

  it('overwrites with --force', async () => {
    await writeFile(join(workspace, 'index.html'), 'ORIGINAL', 'utf8');

    const forced = await run(
      'build',
      '--template', 'landing',
      '--name', 'X', '--tagline', 'Y', '--features', 'Z',
      '--out', workspace, '--force',
    );

    expect(forced.code).toBe(0);
    expect(await readFile(join(workspace, 'index.html'), 'utf8')).not.toBe('ORIGINAL');
  });

  it('emits json when asked', async () => {
    const result = await run(
      'build',
      '--template', 'landing',
      '--name', 'X', '--tagline', 'Y', '--features', 'Z',
      '--out', workspace, '--json',
    );

    const parsed = JSON.parse(result.stdout) as { written: string[] };
    expect(parsed.written).toContain('index.html');
  });

  it('writes nothing outside --out', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'waypoint-elsewhere-'));
    await writeFile(join(elsewhere, 'index.html'), 'UNTOUCHED', 'utf8');

    await run(
      'build',
      '--template', 'landing',
      '--name', 'X', '--tagline', 'Y', '--features', 'Z',
      '--out', workspace,
    );

    expect(await readFile(join(elsewhere, 'index.html'), 'utf8')).toBe('UNTOUCHED');
  });

  it('produces the same output every run', async () => {
    // Determinism is what makes the builder testable at all.
    const args = [
      'build', '--template', 'landing',
      '--name', 'Deterministic', '--tagline', 'Same every time',
      '--features', 'A;B',
    ];

    await run(...args, '--out', workspace);
    const first = await readFile(join(workspace, 'index.html'), 'utf8');

    await run(...args, '--out', workspace, '--force');
    const second = await readFile(join(workspace, 'index.html'), 'utf8');

    expect(second).toBe(first);
  });
});

describe('agent dry run', () => {
  it('reports the workspace and the tools', async () => {
    const result = await run('agent', '--task', 'do something', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('read_file');
    expect(result.stdout).toContain('write_file');
    expect(result.stdout).toContain('edit_file');
  });

  it('does not offer the shell by default', async () => {
    // Command execution is opt-in. It is gated, not contained, so it should
    // never appear without being asked for.
    const result = await run('agent', '--task', 'x', '--dry-run');
    expect(result.stdout).toContain('not offered');
  });

  it('offers the shell when asked', async () => {
    const result = await run('agent', '--task', 'x', '--dry-run', '--allow-shell');
    expect(result.stdout).toContain('run_command');
    expect(result.stdout).toContain('gated');
  });

  it('confines itself to the given directory', async () => {
    const inside = await mkdtemp(join(tmpdir(), 'waypoint-inside-'));
    const result = await run(
      'agent', '--task', 'x', '--dry-run', '--cwd', inside,
    );
    expect(result.stdout.replace(/\\/g, '/')).toContain(
      inside.replace(/\\/g, '/'),
    );
  });

  it('emits json when asked', async () => {
    const result = await run('agent', '--task', 'x', '--dry-run', '--json');
    const parsed = JSON.parse(result.stdout) as {
      tools: string[];
      shell: boolean;
    };
    expect(parsed.tools).toContain('read_file');
    expect(parsed.shell).toBe(false);
  });

  it('requires a task', async () => {
    const result = await run('agent', '--dry-run');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('requires --task');
  });

  it('does not contact a model on a dry run', async () => {
    // A dry run must not be able to spend money or start a run by accident.
    const started = Date.now();
    const result = await run('agent', '--task', 'x', '--dry-run');
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe('existing commands still work', () => {
  it('routes a task', async () => {
    const result = await run('route', '--task', 'Fix a typo in README', '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tier: string };
    expect(parsed.tier).toBeTruthy();
  });

  it('reports its version', async () => {
    const result = await run('--version');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects an unknown command', async () => {
    const result = await run('definitely-not-a-command');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });
});