import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The onboarding wizard's step list and its dots are two separate declarations
 * of the same thing.
 *
 * ONBOARDING_STEPS drives the flow in renderer.ts. The dots are static markup in
 * index.html, because the renderer only toggles an active class per index and
 * never creates one. Adding a step without a dot leaves the progress indicator
 * showing 3 of 4 forever; adding a dot without a step leaves a permanent dot
 * that never lights up. Neither shows up as a failure - the wizard just works,
 * and the indicator quietly lies.
 */

const APP = join(import.meta.dirname, '..');

const read = (...parts: string[]): string =>
  readFileSync(join(...parts), 'utf8');

const renderer = read(APP, 'src', 'renderer.ts');
const index = read(APP, 'renderer', 'index.html');

const stepList = /const ONBOARDING_STEPS = \[([^\]]+)\] as const;/.exec(renderer);

describe('onboarding wizard steps', () => {
  it('declares its steps in one place', () => {
    expect(stepList, 'ONBOARDING_STEPS not found in renderer.ts').not.toBeNull();
  });

  it('renders one progress dot per step', () => {
    const steps = (stepList?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(steps.length).toBeGreaterThan(0);

    const dots = index.match(/class="onboarding-step-dot"/g) ?? [];
    expect(
      dots.length,
      `${steps.length} steps (${steps.join(', ')}) but ${dots.length} dots in index.html`,
    ).toBe(steps.length);
  });

  it('reaches every step through Next', () => {
    // Next advances by index into the array, so it works for any step count as
    // long as the last step is the final entry. This guards the alternative
    // mistake: a hardcoded "isLast" that names a step other than the last one.
    const last = (stepList?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .pop();
    expect(last).toBeDefined();
    expect(renderer).toMatch(new RegExp(`isLast = onboardingStep === '${last}'`));
  });

  it('renders a distinct step for every entry', () => {
    // A new step that falls through to another step's renderer would make the
    // dot advance while the content stayed put.
    const steps = (stepList?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);

    for (const step of steps) {
      const mentioned = renderer.match(
        new RegExp(`onboardingStep === '${step}'`, 'g'),
      );
      expect(mentioned?.length ?? 0, `${step} has no branch in renderStep`).toBeGreaterThan(0);
    }
  });
});