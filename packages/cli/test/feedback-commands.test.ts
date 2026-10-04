import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'packages', 'cli', 'src', 'bin.ts');
const DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

/**
 * Run the CLI with an explicit working directory.
 *
 * Mirrors cli.test.ts: the built output when dist exists, tsx from source
 * otherwise. Set WAYPOINT_CLI_FROM_SOURCE=1 to force the source path.
 *
 * Each test gets a fresh temp dir so feedback and model files never touch
 * the repo root, where a stray feedback.jsonl would pollute every later
 * `feedback` run.
 */
function runIn(
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; code: number } {
  const command =
    existsSync(DIST) && !process.env.WAYPOINT_CLI_FROM_SOURCE
      ? ['node', DIST, ...args]
      : ['npx', 'tsx', ENTRY, ...args];

  try {
    const stdout = execFileSync(command[0] as string, command.slice(1), {
      cwd,
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

function setup(): { dir: string; config: string; feedback: string; model: string } {
  const dir = mkdtempSync(join(tmpdir(), 'waypoint-feedback-'));
  const feedback = join(dir, 'feedback.jsonl');
  const model = join(dir, 'learned_model.json');
  const config = join(dir, 'waypoint.config.json');
  writeFileSync(
    config,
    JSON.stringify({
      tiers: {
        local: {
          description: 'local',
          providers: [{ name: 'ollama', models: ['qwen2.5-coder'] }],
        },
      },
      learnedClassifier: { enabled: true, modelFile: model, minSamples: 1 },
      logging: { feedbackFile: feedback },
    }),
    'utf8',
  );
  return { dir, config, feedback, model };
}

function feedbackLine(
  taskId: string,
  predicted: string,
  actual: string | null,
  correct: boolean | null,
  rating: number | null,
): string {
  return JSON.stringify({
    task_id: taskId,
    description: `task ${taskId}`,
    predicted_tier: predicted,
    actual_tier: actual,
    was_correct: correct,
    user_rating: rating,
    timestamp: 1700000000,
    metadata: {},
  });
}

describe('feedback command', () => {
  it('reports zeroed stats for a missing feedback file', () => {
    const { dir, config } = setup();
    const result = runIn(dir, ['feedback', '--config', config, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      total_entries: 0,
      rated_entries: 0,
      correct_predictions: 0,
      incorrect_predictions: 0,
      accuracy: 0,
      average_rating: 0,
      by_tier: {},
    });
  });

  it('prints the Python text format with sorted tiers', () => {
    const { dir, config, feedback } = setup();
    writeFileSync(
      feedback,
      [
        feedbackLine('a', 'local', 'local', true, 5),
        feedbackLine('b', 'local', 'mid', false, 3),
        feedbackLine('c', 'mid', 'mid', true, 4),
      ].join('\n') + '\n',
      'utf8',
    );

    const result = runIn(dir, ['feedback', '--config', config]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      'Entries:  3\n' +
        'Accuracy: 66.7%\n' +
        'Rating:   4.0\n' +
        '\nBy tier:\n' +
        '  local        1/2 (50%)\n' +
        '  mid          1/1 (100%)\n',
    );
  });
});

describe('train command', () => {
  it('fails cleanly with no labelled feedback', () => {
    const { dir, config } = setup();
    const result = runIn(dir, ['train', '--config', config]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No labelled feedback found at');
    expect(result.stderr).toContain('Run some tasks and record outcomes before training.');
  });

  it('trains from feedback and writes a model both CLIs can read', () => {
    const { dir, config, feedback, model } = setup();
    writeFileSync(
      feedback,
      [
        feedbackLine('a', 'local', 'local', true, 5),
        feedbackLine('b', 'mid', 'mid', true, 4),
        feedbackLine('c', 'frontier', 'frontier', true, 5),
      ].join('\n') + '\n',
      'utf8',
    );

    const trained = runIn(dir, ['train', '--config', config, '--json']);
    expect(trained.code).toBe(0);
    const payload = JSON.parse(trained.stdout) as {
      trained_on: number;
      accuracy: number;
      weights: Record<string, Record<string, number>>;
    };
    expect(payload.trained_on).toBe(3);

    // The model file carries both key spellings: the TS router reads
    // trainedOn, the Python router reads trained_on.
    const saved = JSON.parse(readFileSync(model, 'utf8')) as {
      trainedOn: number;
      trained_on: number;
    };
    expect(saved.trained_on).toBe(3);
    expect(saved.trainedOn).toBe(3);

    // Routing with the trained model engages the hybrid classifier.
    const routed = runIn(dir, [
      'route',
      '--config',
      config,
      '--task',
      'Fix a typo in the readme',
      '--json',
    ]);
    expect(routed.code).toBe(0);
    const decision = JSON.parse(routed.stdout) as { reasons: string[] };
    expect(decision.reasons.join(' ')).toMatch(/Learned model/);
  });
});
