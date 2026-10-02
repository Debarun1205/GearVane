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
    ];

  /**
   * Sandbox wording is checked separately because the shell tool now exists
   * and is gated, which is exactly the situation where the honest description
   * is easiest to get wrong. Gating is not containment, and a tool that
   * exists is not automatically a sandbox.
   */
  it('does not describe the shell tool as a sandbox', () => {
    const shellPath = join('packages', 'harness', 'src', 'tools', 'shell.ts');
    if (!existsSync(shellPath)) return;

    const source = read(shellPath).replace(/\s+/g, ' ');

    // It must keep denying the sandbox claim...
    expect(source).toMatch(/not a sandbox/i);
    expect(source).toMatch(/needs an OS boundary/i);

    // ...and must never make the claim in the positive.
    expect(source).not.toMatch(/\bprovides a sandbox\b/i);
    expect(source).not.toMatch(/\bis a sandbox\b/i);
    expect(source).not.toMatch(/fully (contained|sandboxed)/i);
  });

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

  it('describes the shell tool as gated rather than sandboxed', () => {
    const hasShell = existsSync(
      join(REPO, 'packages', 'harness', 'src', 'tools', 'shell.ts'),
    );

    if (!hasShell) {
      expect(prose).toMatch(/Shell containment and sandboxing\s*\|\s*\*\*not done\*\*/);
      expect(prose).toMatch(/no sandbox/i);
      return;
    }

    // Once the tool exists the row has to say what it actually is.
    expect(prose).toMatch(/gated/i);
    expect(prose).toMatch(/not a sandbox/i);
  });

  it('keeps the shell row and the sandbox row distinct', () => {
    // Two rows, because the tool exists and is gated while OS-level
    // containment does not exist at all. Collapsing them would let the word
    // "sandboxed" sit next to a feature that only gates.
    const rows = doc.split('\n').filter((line) => line.trim().startsWith('|'));
    const shellRow = rows.find((line) => line.includes('Shell tool'));
    const sandboxRow = rows.find((line) => line.includes('Sandboxing'));

    expect(shellRow).toBeDefined();
    expect(sandboxRow).toBeDefined();
    expect(shellRow).not.toBe(sandboxRow);

    // The tool is done; containment is not.
    expect(shellRow).not.toMatch(/\*\*not done\*\*/);
    expect(sandboxRow).toMatch(/\*\*not done/);
  });

  it('never describes the gated shell as containment', () => {
    // cwd controls relative path resolution, not what a process can open. A
    // document that implied otherwise would mislead exactly the reader most
    // likely to be harmed by it.
    expect(prose).toMatch(/started there/i);
    expect(prose).toMatch(/needs an OS boundary/i);
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