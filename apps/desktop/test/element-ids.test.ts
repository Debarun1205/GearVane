/**
 * Cross-check the ids the renderer looks up against the static markup.
 *
 * Regression guard for a real shipped bug: `renderer.ts` asked for `#clear`
 * while `index.html` only ever had `#clear-button`. `byId` throws on a miss,
 * so the whole module died at load and the app never rendered anything past
 * its static markup. Source-level tests pinned plenty of strings and still
 * missed it, because no test connected the two files.
 *
 * The same idea in reverse (ids nothing references) is reported but not
 * asserted: aria-labelledby targets and form-only controls are legitimately
 * never fetched from script.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DESKTOP = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
}

function idsLookedUp(renderer: string): Set<string> {
  const found = new Set<string>();
  for (const match of renderer.matchAll(/byId(?:<[^>]*>)?\('([^']+)'\)/g)) {
    found.add(match[1]);
  }
  for (const match of renderer.matchAll(/getElementById\('([^']+)'\)/g)) {
    found.add(match[1]);
  }
  return found;
}

describe('element ids', () => {
  const html = read(DESKTOP, 'renderer', 'index.html');
  const renderer = read(DESKTOP, 'src', 'renderer.ts');

  it('resolves every id the renderer fetches from the static markup', () => {
    const declared = idsIn(html);
    const missing = [...idsLookedUp(renderer)]
      .filter((id) => !declared.has(id))
      .sort();

    expect(missing).toEqual([]);
  });

  it('looks ids up with APIs that throw loudly on a miss', () => {
    // byId throws and getElementById is checked at the call site; a silent
    // null-tolerant lookup is how the original bug survived review.
    expect(renderer).toContain('function byId');
    expect(renderer).toMatch(/if \(!element\) throw new Error\(/);
  });
});
