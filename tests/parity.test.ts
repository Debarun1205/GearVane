/**
 * Parity between the Python and TypeScript implementations.
 *
 * The project ships two engines: Python, which cannot be bundled into an
 * Android app, and TypeScript, which is what the CLI, app, and extension
 * use. They claim identical behaviour, so that claim is tested rather than
 * asserted in a README.
 *
 * These tests invoke both CLIs as subprocesses. A shared unit test would not
 * catch a divergence in config discovery or argument handling, which is
 * exactly where the two had already drifted.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');
const TS_CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const EXAMPLE_CONFIG = join(REPO, 'config.example.yaml');

/**
 * Locate the Python interpreter that has waypoint installed.
 *
 * Prefers the project virtualenv, because a bare "python" on PATH is often a
 * different install without the package, which makes the parity test fail for
 * a reason that has nothing to do with parity.
 */
function findPython(): string | null {
  const candidates = [
    join(REPO, 'venv', 'Scripts', 'python.exe'),
    join(REPO, 'venv', 'bin', 'python'),
    'python',
    'python3',
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'import waypoint'], {
        cwd: REPO,
        stdio: 'ignore',
        timeout: 30_000,
      });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

const PYTHON = findPython();

const tsAvailable = existsSync(TS_CLI);

const PROMPTS: Array<{ task: string; files: string[] }> = [
  { task: 'Fix a typo in the readme', files: ['README.md'] },
  { task: 'Rename this variable across the file', files: ['src/app.py'] },
  {
    task: 'Refactor the auth architecture for concurrency',
    files: ['a.py', 'b.py', 'c.py'],
  },
  {
    task: 'Investigate a memory leak under load in the cache writer',
    files: ['src/cache.ts', 'src/writer.ts'],
  },
  {
    task: 'Add a paginated endpoint for user activity',
    files: ['src/routes.py'],
  },
  { task: 'Update the changelog', files: [] },
];

function routeWithPython(task: string, files: string[]): { tier: string; model: string } {
  const args = ['-m', 'waypoint', 'route', '--task', task, '--json'];
  if (files.length > 0) args.push('--files', ...files);

  const stdout = execFileSync(PYTHON as string, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    // The router logs to stderr; stdout must stay pure JSON.
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  return JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
    tier: string;
    model: string;
  };
}

function routeWithTypescript(
  task: string,
  files: string[],
): { tier: string; model: string } {
  const args = [TS_CLI, 'route', '--task', task, '--json'];
  // Repeated flags, because the TS parser collects one value per flag.
  for (const file of files) args.push('--files', file);

  const stdout = execFileSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  return JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
    tier: string;
    model: string;
  };
}

describe('both engines find the same config', () => {
  it('the example config exists for both to find', () => {
    expect(existsSync(EXAMPLE_CONFIG)).toBe(true);
  });

  it.skipIf(!PYTHON || !tsAvailable)(
    'routes the same prompt to the same tier and model',
    () => {
      for (const { task, files } of PROMPTS) {
        const python = routeWithPython(task, files);
        const typescript = routeWithTypescript(task, files);

        // A divergence here means one engine read a different config, or
        // parsed different files. Both are user-visible.
        expect(
          { tier: typescript.tier, model: typescript.model },
          `mismatch for: ${task}`,
        ).toEqual({ tier: python.tier, model: python.model });
      }
    },
  );

  it.skipIf(!PYTHON || !tsAvailable)('agree on --version', () => {
    const pythonVersion = execFileSync(PYTHON as string, ['-m', 'waypoint', '--version'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();

    const tsVersion = execFileSync(process.execPath, [TS_CLI, '--version'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();

    // The Python package reported 0.1.0 while the TS packages said 0.2.0, so
    // a user comparing the two CLIs saw different versions.
    const number = (text: string): string => text.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '';
    expect(number(tsVersion)).toBe(number(pythonVersion));
  });
});