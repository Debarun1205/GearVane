import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Checks on the release workflow.
 *
 * These exist because both of the failures they guard against produced an
 * error message that points somewhere other than the cause: a bad action
 * input names the input, and a packaging metadata omission names neither
 * Linux nor the manifest.
 */

const REPO = join(__dirname, '..');
const RELEASE = readFileSync(
  join(REPO, '.github', 'workflows', 'release.yml'),
  'utf8',
);

/**
 * Inputs that android-actions/setup-android actually accepts.
 *
 * The action validates its inputs against a YAML 1.2 core schema and aborts
 * on anything unrecognised, so an invented input fails the job before any
 * work happens.
 */
const SETUP_ANDROID_INPUTS = new Set(['packages', 'cmdline-tools-version']);

function androidSetupStep(): string {
  const lines = RELEASE.split('\n');
  const start = lines.findIndex((line) =>
    line.includes('android-actions/setup-android'),
  );
  expect(start).toBeGreaterThan(-1);

  // The step runs until the next line at the same or lower indentation.
  const indent = (lines[start].match(/^\s*/)?.[0] ?? '').length;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const lineIndent = (line.match(/^\s*/)?.[0] ?? '').length;
    if (line.trim() && lineIndent <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('android job', () => {
  it('passes only inputs the setup-android action accepts', () => {
    const block = androidSetupStep();
    const keys = [...block.matchAll(/^\s{10}([a-z0-9-]+):/gm)].map(
      (match) => match[1],
    );

    const unknown = keys.filter((key) => !SETUP_ANDROID_INPUTS.has(key));
    expect(unknown).toEqual([]);
  });

  it('does not invent an accept-android-sdk-licenses input', () => {
    // Regression: this input does not exist. The job failed with
    // 'Input does not meet YAML 1.2 "Core Schema" specification'.
    expect(RELEASE).not.toContain('accept-android-sdk-licenses');
  });

  it('accepts SDK licences explicitly instead', () => {
    expect(RELEASE).toContain('sdkmanager --licenses');
  });
});

describe('publish job', () => {
  it('is guarded so a failed job does not skip it silently', () => {
    const publishBlock = RELEASE.slice(RELEASE.indexOf('\n  publish:'));
    expect(publishBlock).toMatch(/if:\s/);
  });

  it('does not hard-require android', () => {
    // A missing APK should not withhold installers that already built.
    const publishBlock = RELEASE.slice(RELEASE.indexOf('\n  publish:'));
    const needsLine = publishBlock
      .split('\n')
      .find((line) => line.trim().startsWith('needs:'));
    expect(needsLine).toBeDefined();
    expect(needsLine).not.toContain('android');
  });
});

describe('desktop job', () => {
  it('builds each platform on a runner that can produce it', () => {
    // A macOS installer cannot be produced off macOS, so the matrix is not
    // collapsed into one job.
    expect(RELEASE).toContain('macos-latest');
    expect(RELEASE).toContain('windows-latest');
    expect(RELEASE).toContain('ubuntu-latest');
  });
});

const DEPENDABOT = readFileSync(
  join(REPO, '.github', 'dependabot.yml'),
  'utf8',
);
const CODEQL = readFileSync(
  join(REPO, '.github', 'workflows', 'codeql.yml'),
  'utf8',
);

describe('dependency automation', () => {
  it('watches every ecosystem the repo actually ships', () => {
    // npm for the workspaces, pip for the Python port, and the Actions the
    // workflows themselves pin - a stale action is a dependency too.
    expect(DEPENDABOT).toContain('package-ecosystem: npm');
    expect(DEPENDABOT).toContain('package-ecosystem: pip');
    expect(DEPENDABOT).toContain('package-ecosystem: github-actions');
  });

  it('scans both languages the repo ships', () => {
    // The desktop renderer and the Python port are different attack
    // surfaces; missing either would silently unscan half the repo.
    expect(CODEQL).toContain('javascript-typescript');
    expect(CODEQL).toContain('python');
    expect(CODEQL).toContain('security-events: write');
  });
});