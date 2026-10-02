import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Checks on docs/harness-architecture.md.
 *
 * The architecture document is the plan for work that is mostly not done. Its
 * value depends entirely on the gap table being true, so the claims that can
 * be checked mechanically are checked mechanically rather than trusted.
 *
 * Every assertion here is written to fail when a capability is claimed but
 * absent, and to fail when a real gap stops being documented.
 */

const REPO = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const doc = read(REPO, 'docs', 'harness-architecture.md');
const prose = doc.replace(/\s+/g, ' ');

const coreSrc = read(REPO, 'packages', 'core', 'src', 'providers.ts');

describe('architecture document', () => {
  it('exists', () => {
    expect(existsSync(join(REPO, 'docs', 'harness-architecture.md'))).toBe(true);
  });

  it('has a status table', () => {
    expect(doc).toMatch(/\|\s*Area\s*\|\s*State\s*\|/);
  });
});

describe('the document does not overstate what exists', () => {
  /**
   * Capabilities the harness is intended to have. Each entry is marked either
   * done or not done in the document; this test verifies the marks match the
   * repository rather than the author's optimism.
   *
   * The marker a row must contain depends on what proves it. That matters for
   * sandboxing in particular: the file half of containment is built, so keying
   * that row on the workspace directory alone would let "sandboxed" appear
   * next to a feature that protects files only.
   */
  const CAPABILITIES = [
    {
      // The loop is the package's main export rather than a directory.
      label: 'Agent loop',
      path: join('packages', 'harness', 'src', 'index.ts'),
      // Also require the export, so renaming the function cannot leave the
      // row reading "done" with nothing behind it.
      mustContain: 'runAgent',
    },
    {
      label: 'Tool call **advertising**',
      path: join('packages', 'core', 'src', 'providers.ts'),
      mustContain: "'tools'",
    },
    {
      label: 'Tool layer',
      path: join('packages', 'harness', 'src', 'tools', 'registry.ts'),
    },
    {
      label: 'File tools',
      path: join('packages', 'harness', 'src', 'tools', 'fs.ts'),
    },
    {
      // Matched loosely because the doc row names the layer, not the class.
      label: 'path containment for file tools',
      path: join('packages', 'harness', 'src', 'workspace', 'containment.ts'),
      mustContain: 'class Workspace',
    },
    {
      // The shell tool is what would make this true.
      label: 'Shell containment and sandboxing',
      path: join('packages', 'harness', 'src', 'tools', 'shell'),
    },
  ];

  it.each(CAPABILITIES)(
    'agrees with the repository about "$label"',
    ({ label, path, mustContain }) => {
      const target = join(REPO, path);
      const exists = existsSync(target);
      const source = exists ? read(target) : '';

      const row = doc
        .split('\n')
        .find((line) => line.includes(label) && line.trim().startsWith('|'));

      expect(row, `no status row for ${label}`).toBeDefined();

      const markedDone = !/\*\*not done\*\*/i.test(row ?? '');
      expect(
        markedDone,
        `"${label}" is marked ${markedDone ? 'done' : 'not done'} in the document but ` +
          `${exists ? 'the file exists' : 'the file is missing'}`,
      ).toBe(exists);

      if (exists && mustContain) {
        expect(
          source.includes(mustContain),
          `"${label}" is marked done but ${path} does not contain "${mustContain}"`,
        ).toBe(true);
      }
    },
  );

  it('does not claim tool advertising before it is sent', () => {
    // The most misleading claim available: the parsing half of tool calls has
    // always existed, so "tool calls are supported" reads as true while the
    // request that provokes one is missing.
    //
    // Checked by looking for an actual assignment in the request body, not for
    // the word "tools" appearing anywhere in the file.
    const advertises = /body\[['\"]tools['\"]\]\s*=|payload\[['\"]tools['\"]\]\s*=/.test(
      coreSrc,
    );

    if (!advertises) {
      expect(prose).toMatch(/tool call \*\*advertising\*\*/i);
      expect(prose).toMatch(/\*\*not done\*\*/);
    } else {
      // Both halves must be claimed together, never one without the other.
      expect(coreSrc).toMatch(/normaliseToolCalls|tool_use/);
    }
  });

  it('never claims the harness has a sandbox while the shell tool is missing', () => {
    const hasShell = existsSync(
      join(REPO, 'packages', 'harness', 'src', 'tools', 'shell'),
    );

    if (!hasShell) {
      expect(prose).toMatch(/Shell containment and sandboxing\s*\|\s*\*\*not done\*\*/);
      expect(prose).toMatch(/no sandbox/i);
    }
  });

  it('separates file containment from command containment', () => {
    // The distinction that keeps "sandboxed" honest while only files are
    // confined.
    expect(prose).toMatch(/separate rows on purpose/i);
    expect(prose).toMatch(/file half/i);
    expect(prose).toMatch(/command half/i);
  });
});

describe('the document keeps the risks stated', () => {
  it('says gating is not containment', () => {
    // The most dangerous sentence to drop, once an agent can run commands.
    expect(prose).toMatch(/Gating is not containment/);
  });

  it('warns that a budget-only stop condition will overspend', () => {
    expect(prose).toMatch(/only stops when it runs out of budget/i);
  });

  it('records that not every tier supports tool calling', () => {
    // A local model that cannot do tool calls is a real deployment
    // constraint, and the loop has to handle it deliberately.
    expect(prose).toMatch(/not universally supported/i);
  });

  it('states the layering and its dependency direction', () => {
    for (const layer of ['tools', 'workspace', 'agent', 'context', 'session']) {
      expect(doc).toContain(layer);
    }
    expect(prose).toMatch(/Dependency direction is strictly downward/);
  });
});