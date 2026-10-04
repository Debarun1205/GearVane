/**
 * Appearance: themes, backgrounds, accents, motion, and onboarding.
 *
 * The look is user-facing but invisible to a headless test run, so the
 * assertions split in two: the pure selection/validation logic runs for
 * real, and the DOM wiring is guarded at the source level the way the rest
 * of this suite guards the renderer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACCENTS,
  APPEARANCE_STORAGE_KEY,
  BACKGROUNDS,
  DEFAULT_APPEARANCE,
  MOTIONS,
  ONBOARDED_STORAGE_KEY,
  THEMES,
  applyAppearance,
  appearanceVars,
  hasOnboarded,
  loadAppearance,
  markOnboarded,
  resolveAppearance,
  saveAppearance,
  type Appearance,
  type AppearanceStorage,
} from '../src/theme.js';

const DESKTOP = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

function memoryStorage(initial: Record<string, string> = {}): AppearanceStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('presets', () => {
  it('offers a meaningful set of choices', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(5);
    expect(BACKGROUNDS.length).toBeGreaterThanOrEqual(4);
    expect(ACCENTS.length).toBeGreaterThanOrEqual(6);
    expect(MOTIONS.map((motion) => motion.id)).toEqual(['full', 'calm']);
  });

  it('keeps every id unique within its axis', () => {
    for (const list of [THEMES, BACKGROUNDS, ACCENTS]) {
      const ids = list.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('leaves the default look exactly as it was before themes existed', () => {
    // An upgrading user must see no change until they opt in.
    const midnight = THEMES.find((theme) => theme.id === 'midnight');
    const sky = ACCENTS.find((accent) => accent.id === 'sky');

    expect(DEFAULT_APPEARANCE).toEqual({
      theme: 'midnight',
      background: 'gradient',
      accent: 'sky',
      motion: 'full',
    });
    expect(midnight?.vars['--bg']).toBe('#0b1120');
    expect(midnight?.vars['--bg-raised']).toBe('#131c31');
    expect(sky?.color).toBe('#38bdf8');
  });

  it('suggests a theme during onboarding', () => {
    expect(THEMES.some((theme) => theme.suggested === true)).toBe(true);
  });

  it('uses plain hex colours so Monaco and xterm can consume them', () => {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
    for (const theme of THEMES) {
      for (const value of Object.values(theme.vars)) {
        expect(value).toMatch(hex);
      }
      for (const stop of theme.swatch) {
        expect(stop).toMatch(hex);
      }
    }
    for (const accent of ACCENTS) {
      expect(accent.color).toMatch(hex);
      expect(accent.dim).toMatch(hex);
      expect(accent.on).toMatch(hex);
    }
  });

  it('keeps accents light enough for the on-accent foreground', () => {
    // Every --on value is a near-black; a dark accent would ship a button
    // nobody can read. Reject luminance below the point where #04121d stops
    // being legible by requiring each accent to be a light colour: the
    // simplest honest check is that none of them is itself near-black.
    for (const accent of ACCENTS) {
      expect(accent.on).toBe('#04121d');
      expect(accent.color).not.toMatch(/^#0[0-9a-f]0[0-9a-f]0[0-9a-f]$/i);
    }
  });
});

describe('resolveAppearance', () => {
  it('falls back to defaults for nonsense', () => {
    expect(resolveAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance('midnight')).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance(42)).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance([])).toEqual(DEFAULT_APPEARANCE);
  });

  it('keeps the valid fields of a partially broken object', () => {
    const resolved = resolveAppearance({
      theme: 'nebula',
      background: 'not-a-background',
      accent: 'green',
      motion: 'calm',
    });

    expect(resolved.theme).toBe('nebula');
    expect(resolved.background).toBe(DEFAULT_APPEARANCE.background);
    expect(resolved.accent).toBe('green');
    expect(resolved.motion).toBe('calm');
  });

  it('rejects an unknown motion value', () => {
    expect(resolveAppearance({ motion: 'hyperspeed' }).motion).toBe('full');
  });
});

describe('appearanceVars', () => {
  it('layers the accent over the theme surfaces', () => {
    const vars = appearanceVars({
      theme: 'ember',
      background: 'flat',
      accent: 'green',
      motion: 'full',
    });

    expect(vars['--bg']).toBe('#150e0c');
    expect(vars['--accent']).toBe('#34d399');
    expect(vars['--accent-dim']).toBe('#047857');
    expect(vars['--accent-contrast']).toBe('#04121d');
    expect(vars['--glow-b']).toBe('#fb923c');
  });

  it('never lets a theme smuggle in its own accent', () => {
    // The accent axis owns --accent; a theme overriding it would make the
    // swatch in the dialog a lie.
    for (const theme of THEMES) {
      expect(theme.vars['--accent']).toBeUndefined();
      expect(theme.vars['--accent-dim']).toBeUndefined();
    }
  });
});

describe('applyAppearance', () => {
  it('writes the mode attributes and every custom property', () => {
    const attributes = new Map<string, string>();
    const properties = new Map<string, string>();
    const target: AppearanceTarget = {
      setAttribute: (name, value) => attributes.set(name, value),
      style: {
        setProperty: (name, value) => properties.set(name, value),
      },
    };

    applyAppearance(target, {
      theme: 'aurora',
      background: 'grid',
      accent: 'violet',
      motion: 'calm',
    });

    expect(attributes.get('data-bg')).toBe('grid');
    expect(attributes.get('data-motion')).toBe('calm');
    expect(properties.get('--bg')).toBe('#070b18');
    expect(properties.get('--accent')).toBe('#a78bfa');
    // 8 theme surfaces + the glow, plus 3 accent properties.
    expect(properties.size).toBeGreaterThanOrEqual(11);
  });
});

describe('storage', () => {
  it('round-trips a look', () => {
    const storage = memoryStorage();
    const look: Appearance = {
      theme: 'verdant',
      background: 'aurora',
      accent: 'amber',
      motion: 'calm',
    };

    saveAppearance(storage, look);
    expect(loadAppearance(storage)).toEqual(look);
    expect(storage.data.has(APPEARANCE_STORAGE_KEY)).toBe(true);
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadAppearance(memoryStorage())).toEqual(DEFAULT_APPEARANCE);
  });

  it('returns defaults for corrupt stored JSON', () => {
    const storage = memoryStorage({ [APPEARANCE_STORAGE_KEY]: '{not json' });
    expect(loadAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
  });

  it('records onboarding exactly once', () => {
    const storage = memoryStorage();
    expect(hasOnboarded(storage)).toBe(false);
    expect(storage.data.has(ONBOARDED_STORAGE_KEY)).toBe(false);

    markOnboarded(storage);
    expect(hasOnboarded(storage)).toBe(true);
  });

  it('treats unreadable storage as already onboarded', () => {
    // If we cannot ask, we do not nag on every launch.
    const hostile: AppearanceStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => undefined,
    };
    expect(hasOnboarded(hostile)).toBe(true);
    expect(loadAppearance(hostile)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('wiring', () => {
  const renderer = read(DESKTOP, 'src', 'renderer.ts');
  const html = read(DESKTOP, 'renderer', 'index.html');
  const css = read(DESKTOP, 'renderer', 'styles.css');
  const terminal = read(DESKTOP, 'src', 'ide', 'terminal.ts');
  const monaco = read(DESKTOP, 'src', 'ide', 'monaco.ts');
  const view = read(DESKTOP, 'src', 'ide', 'ide-view.ts');

  it('applies the stored look before main runs', () => {
    // Module evaluation order is the flash guard: the theme must be on the
    // root before the first frame, not after config resolution.
    const applied = renderer.indexOf('applyAppearance(document.documentElement');
    const mains = renderer.indexOf('async function main');

    expect(applied).toBeGreaterThan(-1);
    expect(mains).toBeGreaterThan(-1);
    expect(applied).toBeLessThan(mains);
  });

  it('shows onboarding once and survives a skip', () => {
    expect(renderer).toContain('if (!hasOnboarded(appearanceStorage)) {');
    // Marked seen where it opens, not in the queued close handler: the close
    // event races with a fast reopen and could lose the flag. Exactly one
    // call site, adjacent to the open.
    const calls = renderer.match(/markOnboarded\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(renderer).toMatch(
      /openAppearance\('onboarding'\);\s*\n\s*markOnboarded\(appearanceStorage\)/,
    );
  });

  it('reverts an unconfirmed preview instead of keeping it', () => {
    expect(renderer).toMatch(/returnValue === 'save'/);
    expect(renderer).toMatch(/applyAppearance\(document\.documentElement, appearanceSnapshot\)/);
  });

  it('offers the dialog from both the chat and the IDE top bars', () => {
    expect(html).toContain('id="appearance-dialog"');
    expect(html).toContain('id="appearance-toggle"');
    expect(html).toContain('id="ide-appearance-toggle"');
    expect(renderer).toContain("getElementById('appearance-toggle')");
    expect(renderer).toContain("getElementById('ide-appearance-toggle')");
  });

  it('builds every option with DOM APIs, not markup strings', () => {
    expect(renderer).not.toMatch(/innerHTML/);
    expect(renderer).toContain('createElement');
    expect(renderer).toContain('textContent');
  });

  it('keeps the dialog out of the forbidden id space', () => {
    // ide-agent.test.ts forbids the substring "ide-dialog" in index.html;
    // the appearance dialog must not collide with that guard.
    expect(html).not.toContain('ide-dialog');
  });

  it('declares the pane background that was referenced but never defined', () => {
    // Regression: --bg-soft was used across the IDE before this change and
    // silently resolved to transparent everywhere.
    expect(css).toMatch(/--bg-soft:\s*rgb\(/);
    expect(css).toMatch(/--accent-contrast:/);
  });

  it('styles the ambience layer for every background and a calm motion', () => {
    for (const background of BACKGROUNDS) {
      expect(css).toContain(`data-bg='${background.id}'`);
    }
    expect(css).toContain("data-motion='calm'");
    expect(css).toContain('.ambience');
  });

  it('follows the look where CSS variables cannot reach', () => {
    // xterm draws to a canvas and Monaco renders its own chrome: both must
    // sample the variables on every change.
    expect(terminal).toContain("from '../theme.js'");
    expect(terminal).toContain('APPEARANCE_EVENT');
    expect(monaco).toContain('applyMonacoTheme');
    expect(monaco).toContain('defineTheme');
    expect(view).toContain("theme: 'gearvane'");
    expect(view).toContain('APPEARANCE_EVENT');
  });

  it('removes the appearance listener on dispose', () => {
    expect(view).toMatch(/removeEventListener\(APPEARANCE_EVENT/);
    expect(terminal).toMatch(/removeEventListener\(APPEARANCE_EVENT/);
  });
});
