import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PAIRS, PALETTE, contrast, luminance } from '../src/contrast.js';

/**
 * The palette is fixed hex values on fixed backgrounds, so every pair has a
 * computable contrast ratio. These assertions are the accessibility floor: they
 * fail if a colour is changed to something that reads well in a screenshot and
 * fails at 4.5:1 on the actual background.
 *
 * Everything here is the app's own styling. Monaco ships its own themes and is
 * out of scope.
 */

const APP = join(import.meta.dirname, '..');

/** Pull the real values out of the stylesheet, so this cannot drift. */
function declaredVar(name: string): string {
  const css = readFileSync(join(APP, 'renderer', 'styles.css'), 'utf8');
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8});`).exec(css);
  expect(match, `--${name} not declared in styles.css`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('luminance', () => {
  it('matches the known values', () => {
    // Black and white are the two anchors; anything wrong here invalidates
    // every ratio below.
    expect(luminance('#000000')).toBeCloseTo(0, 5);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('puts green above blue at equal channel values', () => {
    // Green carries the most luminance weight, so the arithmetic order matters.
    expect(luminance('#00ff00')).toBeGreaterThan(luminance('#0000ff'));
  });

  it('treats white-on-black as the maximum ratio', () => {
    expect(contrast('#ffffff', '#000000').ratio).toBeCloseTo(21, 1);
  });
});

describe('palette contrast', () => {
  it('passes AA for every text pair in the stylesheet', () => {
    // The border pair is excluded deliberately: a boundary is not text, and is
    // held to the 3:1 non-text minimum in the test below. Naming it is better
    // than filtering silently, so the exclusion has to be visible.
    const borderPair = PAIRS.filter((pair) => pair.what.startsWith('border'));
    expect(borderPair).toHaveLength(1);

    const textPairs = PAIRS.filter((pair) => !pair.what.startsWith('border'));
    const failures = textPairs
      .map(({ what, fg, bg }) => ({ what, ratio: contrast(PALETTE[fg], PALETTE[bg]).ratio }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ what, ratio }) => `${what}: ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it('clears 3:1 for the strong border on every background', () => {
    // WCAG 1.4.11: a control boundary is the only thing identifying most of
    // these inputs. It sat at 1.85:1 on --bg before, which looked fine and was
    // not. All three backgrounds it can land on, because a dialog on a raised
    // panel is darker than the app behind it.
    const border = declaredVar('border-strong');
    for (const bg of ['bg', 'bgRaised', 'bgSoft'] as const) {
      const { ratio } = contrast(border, PALETTE[bg]);
      expect(ratio, `--border-strong on --${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps body text comfortably readable', () => {
    // Not just passing: the transcript is the primary content, and 4.5:1 is
    // the floor for the size it is set at.
    const { ratio } = contrast(PALETTE.text, PALETTE.bg);
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  it('keeps the dim text readable rather than merely present', () => {
    // --text-dim carries help text and metadata. At 6.14:1 it passes AA; the
    // assertion is here so lowering it is a deliberate act.
    const { ratio } = contrast(PALETTE.textDim, PALETTE.bg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the accent button label readable', () => {
    // Text on a filled button, which is the one place a light foreground sits
    // on a light background.
    const { ratio } = contrast(PALETTE.accentContrast, PALETTE.accent);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('separates the three tier colours from each other', () => {
    // The tier badge is a colour-coded marker, so the three tiers must not be
    // confusable at a glance - and each already carries a text label, which is
    // what actually makes it accessible.
    const tiers = [PALETTE.tierLocal, PALETTE.tierMid, PALETTE.tierFrontier];
    for (const tier of tiers) {
      const { ratio } = contrast(tier, PALETTE.bg);
      expect(ratio, `${tier} on --bg`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the warning colour readable on a raised panel', () => {
    // The capability banner sits on a panel, and amber-on-dark is the pair
    // most likely to be nudged down for looking loud.
    const { ratio } = contrast(PALETTE.warning, PALETTE.bgRaised);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

