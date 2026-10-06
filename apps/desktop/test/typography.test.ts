import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every font size in the renderer must be in rem, and none may sit below a
 * legible floor.
 *
 * rem is what makes the app respect a user's browser or OS text size: a rem
 * value tracks the root font size, a px value does not. So an app written
 * entirely in rem already scales with the system setting, and the accessibility
 * work here is keeping the *floor* readable rather than adding a control that
 * duplicates the one the OS already provides.
 *
 * The floor is 0.7rem. Below that, text stops being readable at 1x on a
 * laptop panel, and badges and metadata are the first things squeezed - which
 * is backwards, since they are the text carrying the least redundancy.
 */

const APP = join(import.meta.dirname, '..');
const css = readFileSync(join(APP, 'renderer', 'styles.css'), 'utf8');

/** Every font-size declaration, with the line it came from. */
function fontSizes(): Array<{ value: number; unit: string; line: number }> {
  const out: Array<{ value: number; unit: string; line: number }> = [];
  css.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(/font-size:\s*([\d.]+)(rem|px|pt|em)\b/g)) {
      out.push({
        value: Number(match[1]),
        unit: match[2] ?? '',
        line: index + 1,
      });
    }
  });
  return out;
}

const sizes = fontSizes();

describe('font sizing', () => {
  it('declares font sizes at all', () => {
    // A zero here would mean the extraction broke, which would make every
    // assertion below pass vacuously.
    expect(sizes.length).toBeGreaterThan(10);
  });

  it('uses rem everywhere, so the OS text size is honoured', () => {
    const absolute = sizes.filter((size) => size.unit !== 'rem');
    expect(
      absolute.map((s) => `line ${s.line}: ${s.value}${s.unit}`),
      'px, pt, or em sizes ignore the browser/OS text-size setting',
    ).toEqual([]);
  });

  it('keeps every size at or above the legible floor', () => {
    const tooSmall = sizes.filter((size) => size.value < 0.7);
    expect(
      tooSmall.map((s) => `line ${s.line}: ${s.value}rem`),
      'sub-0.7rem text is not readable at 1x, and it is always the badges and ' +
        'metadata that get squeezed',
    ).toEqual([]);
  });

  it('does not set a fixed root font size', () => {
    // Setting :root { font-size: 16px } would break the OS text-size setting
    // the rem values above depend on. It has to stay unset so the browser
    // default applies.
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rootBlock).not.toMatch(/font-size:\s*[\d.]+px/);
    expect(rootBlock).not.toMatch(/font-size:\s*[\d.]+rem/);
  });
});

describe('focus visibility', () => {
  it('gives every focusable element a baseline ring', () => {
    // A component rule that draws a focus style is not enough: what matters is
    // that a control nobody styled still has a visible ring. This rule is what
    // makes that true, and it is the one to delete by accident.
    expect(css).toMatch(
      /:where\([^)]*\)\s*:focus-visible\s*\{[^}]*outline:\s*\d[^}]*\}/,
    );
  });

  it('uses :focus-visible rather than :focus for rings', () => {
    // :focus fires on mouse click too, which would draw a ring on every
    // control anyone clicks. Only :focus-visible distinguishes keyboard use.
    const plain = css.match(/(^|[^:a-z-])(:focus)\s*\{/g) ?? [];
    expect(
      plain.map((m) => m.trim()),
      'a bare :focus rule draws a ring on mouse click as well',
    ).toEqual([]);
  });

  it('gives interactive controls a visible focus ring', () => {
    const focusRules = css.match(/:focus-visible\s*\{[^}]*\}/g) ?? [];
    expect(focusRules.length).toBeGreaterThan(0);

    // Each rule either draws a ring or marks the row with a background change.
    // A rule that does neither is a focus state with nothing in it.
    for (const rule of focusRules) {
      expect(rule, `empty focus rule: ${rule}`).toMatch(
        /outline:\s*\d|background:|border-color:/,
      );
    }
  });

  it('never removes a focus ring outright', () => {
    // outline: none without a replacement is the usual way these get lost.
    const removals = css.match(/outline:\s*(none|0)\s*;/g) ?? [];
    expect(removals).toEqual([]);
  });
});

describe('reduced motion', () => {
  it('honours prefers-reduced-motion', () => {
    // The app has theme-driven transitions; someone who has asked the OS to
    // reduce motion gets fewer of them.
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('disables animation inside that query, not just some of it', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/.exec(css);
    expect(block).not.toBeNull();
    const after = css.slice(block?.index ?? 0);
    const body = after.slice(0, after.indexOf('\n}'));
    expect(body).toMatch(/animation-duration:\s*0\.01ms/);
    expect(body).toMatch(/transition-duration:\s*0\.01ms/);
  });
});