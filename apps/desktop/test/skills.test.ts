import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SKILLS } from '../src/skills.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, '..', '..', '..', 'packages', 'harness', 'src');

/**
 * The sidebar Skills list is static so the browser bundle never imports
 * Node-only harness modules. This test keeps it honest: every tool name
 * the harness defines must appear here, and nothing here may name a tool
 * the harness does not have.
 */
describe('skills parity with the harness', () => {
  it('names exactly the tools the harness defines', () => {
    const sources = [
      readFileSync(join(HARNESS, 'tools', 'fs.ts'), 'utf8'),
      readFileSync(join(HARNESS, 'tools', 'search.ts'), 'utf8'),
      readFileSync(join(HARNESS, 'tools', 'shell.ts'), 'utf8'),
      readFileSync(join(HARNESS, 'builder', 'agent-tools.ts'), 'utf8'),
    ].join('\n');

    const defined = new Set<string>();
    for (const match of sources.matchAll(/name:\s*'([a-z_]+)'/g)) {
      const name = match[1];
      if (name) defined.add(name);
    }

    expect(new Set(SKILLS.map((skill) => skill.name))).toEqual(defined);
  });
});
