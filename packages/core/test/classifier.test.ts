import { describe, expect, it } from 'vitest';

import { TaskClassifier, compilePatterns, globToRegex } from '../src/classifier.js';
import { classifyGlob, compilePattern } from '../src/globs.js';
import type { TaskContext } from '../src/types.js';

const ctx = (
  description: string,
  filesTouched: string[] = [],
  extra: Partial<TaskContext> = {},
): TaskContext => ({
  description,
  filesTouched,
  errorLoops: 0,
  testFailures: 0,
  ...extra,
});

describe('TaskClassifier', () => {
  const classifier = new TaskClassifier();

  it('routes a simple task to local', () => {
    const result = classifier.classify(ctx('Fix a typo in the readme', ['README.md']));
    expect(result.tier).toBe('local');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('routes a complex task to frontier', () => {
    const result = classifier.classify(
      ctx('Refactor the authentication system to use OAuth2', [
        'src/auth/login.ts',
        'src/auth/oauth.ts',
        'src/auth/session.ts',
      ]),
    );
    expect(result.tier).toBe('frontier');
  });

  it('defaults to mid when there are no signals', () => {
    const result = classifier.classify(ctx('Update the thing'));
    expect(result.tier).toBe('mid');
    expect(result.confidence).toBe(0.5);
  });

  it('raises complexity on error loops', () => {
    const result = classifier.classify(
      ctx('Fix the bug', ['src/bug.ts'], { errorLoops: 3 }),
    );
    expect(result.tier).toBe('frontier');
  });

  it('raises complexity on test failures', () => {
    const result = classifier.classify(
      ctx('Fix tests', ['tests/test_foo.ts'], { testFailures: 5 }),
    );
    expect(result.tier).toBe('frontier');
  });

  it('raises complexity when many files are touched', () => {
    const result = classifier.classify(
      ctx('Update code', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']),
    );
    expect(result.tier).toBe('frontier');
  });

  it('promotes a task that already failed at local', () => {
    const result = classifier.classify(
      ctx('Fix the thing', ['src/thing.ts'], {
        previousTier: 'local',
        previousAttempts: 3,
      }),
    );
    expect(result.tier).toBe('mid');
  });

  it('promotes a task that already failed at mid', () => {
    const result = classifier.classify(
      ctx('Fix the thing', ['src/thing.ts'], {
        previousTier: 'mid',
        previousAttempts: 3,
      }),
    );
    expect(result.tier).toBe('frontier');
  });

  it('keeps confidence within bounds', () => {
    for (const description of ['simple fix', 'refactor the architecture']) {
      const result = classifier.classify(ctx(description));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('always explains its decision', () => {
    const result = classifier.classify(ctx('Fix a typo in documentation'));
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('glob and regex pattern handling', () => {
  // Regression: the shipped config uses globs like "*.rs", which are not
  // valid regex. Treating them as regex raised "nothing to repeat" on every
  // classification.
  it('accepts a glob from config without throwing', () => {
    const classifier = new TaskClassifier({
      complexFilePatterns: ['*.rs', '*_test.*', 'src/core/*'],
    });
    const result = classifier.classify(ctx('update', ['src/main.rs']));
    expect(result.scores.frontier).toBeGreaterThan(0);
  });

  it('matches a nested path for a bare extension glob', () => {
    expect(classifyGlob('src/main.rs', '*.rs')).toBe(true);
    expect(classifyGlob('src/main.go', '*.rs')).toBe(false);
  });

  it('matches the mid-name suffix form', () => {
    expect(classifyGlob('src/parser_test.go', '*_test.*')).toBe(true);
    // A prefixed name does not match a mid-name pattern; documented so the
    // behaviour is not mistaken for a bug.
    expect(classifyGlob('src/test_foo.py', '*_test.*')).toBe(false);
  });

  it('still honours regex patterns', () => {
    const classifier = new TaskClassifier({ complexFilePatterns: [String.raw`\.go$`] });
    const result = classifier.classify(ctx('update', ['main.go']));
    expect(result.scores.frontier).toBeGreaterThan(0);
  });

  it('treats an invalid regex as a glob instead of failing', () => {
    // A bare "+" is invalid regex but a valid glob meaning a literal plus.
    expect(() => compilePattern('+')).not.toThrow();
    expect(classifyGlob('c++', '+')).toBe(true);
  });

  it('escapes regex metacharacters when translating a glob', () => {
    // globToRegex escapes metacharacters so the glob matches literally.
    expect(globToRegex('a.b')).toBe(String.raw`a\.b`);
    expect(globToRegex('*.rs')).toBe('.*\\.rs');
  });

  it('prefers regex syntax when a pattern is valid regex', () => {
    // Documented precedence: "a.b" is valid regex, so it is used as a regex
    // and matches "axb". This is why glob-only metacharacters such as "*.rs"
    // work: they are not valid regex, so they fall through to glob handling.
    expect(classifyGlob('axb', 'a.b')).toBe(true);
    expect(classifyGlob('a.b', 'a.b')).toBe(true);
  });

  it('treats a glob-only metacharacter literally', () => {
    // "+" is invalid regex, so it becomes a glob matching a literal plus.
    expect(classifyGlob('c++', '+')).toBe(true);
    expect(classifyGlob('ccc', '+')).toBe(false);
  });

  it('compiles a list of mixed patterns', () => {
    const patterns = compilePatterns(['*.rs', String.raw`\.go$`, '+']);
    expect(patterns).toHaveLength(3);
    for (const pattern of patterns) expect(pattern).toBeInstanceOf(RegExp);
  });

  it('uses valid regex defaults', () => {
    const classifier = new TaskClassifier();
    expect(() =>
      classifier.classify(ctx('x', ['src/core/engine.ts'])),
    ).not.toThrow();
  });
});