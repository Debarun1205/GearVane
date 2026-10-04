/**
 * Appearance: themes, backgrounds, accents, and motion.
 *
 * The app ships five dark theme presets, four background (ambience) styles,
 * six accents, and a motion setting. The user assembles a look from those
 * four axes; nothing here invents colours at runtime, every combination is a
 * set of CSS custom properties applied to the document root.
 *
 * ## Why localStorage and not IPC
 *
 * The same renderer runs in the Electron window and in the Android webview.
 * localStorage exists in both, needs no bridge, and cannot fail in a way that
 * blocks startup (see the try/catch at the call sites). The look is personal
 * to a device, not part of the shared config file, so it must not travel into
 * version control. The Electron window's initial `backgroundColor` stays the
 * near-black default: every preset keeps a near-black base, so the difference
 * during window creation is imperceptible and no main-process round trip is
 * worth it.
 *
 * ## Live preview
 *
 * The dialog applies every choice immediately and only persists on Save.
 * `resolveAppearance` plus a snapshot taken when the dialog opens is what
 * makes Cancel (or the Escape key) revert cleanly: preview is cheap because
 * applying is just a property write.
 *
 * ## Why a structural target
 *
 * `applyAppearance` takes anything with `setAttribute` and `style.setProperty`
 * rather than a DOM element. The test environment is Node, so this keeps the
 * whole module importable and testable without a DOM, while `document.documentElement`
 * satisfies the shape at the real call site.
 */

/** The four choices that make up a look. */
export interface Appearance {
  /** Preset id from THEMES. */
  theme: string;
  /** Preset id from BACKGROUNDS. */
  background: string;
  /** Preset id from ACCENTS. */
  accent: string;
  /** Decorative motion preference. */
  motion: 'full' | 'calm';
}

export interface ThemePreset {
  id: string;
  name: string;
  /** One line describing the mood, shown under the name. */
  vibe: string;
  /** Gradient stops for the preview swatch, left to right. */
  swatch: [string, string, string];
  /** Marked as the suggested pick during onboarding. */
  suggested?: boolean;
  /** CSS custom properties this theme sets on the document root. */
  vars: Record<string, string>;
}

export interface OptionPreset {
  id: string;
  name: string;
  vibe: string;
  /** Preview colour for backgrounds and motion; unused by themes. */
  color?: string;
  /** Accent swatch colour. */
  color2?: string;
}

export interface AccentPreset {
  id: string;
  name: string;
  /** The accent itself. */
  color: string;
  /** The dimmer variant used for focus rings and hover borders. */
  dim: string;
  /** Foreground that sits on top of the accent (buttons). */
  on: string;
}

/**
 * Anything the look can be written onto. `document.documentElement`
 * satisfies this; the tests pass a small fake.
 */
export interface AppearanceTarget {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void };
}

/** A storage surface, so tests can pass an in-memory stub. */
export interface AppearanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const APPEARANCE_STORAGE_KEY = 'gearvane.appearance';
export const ONBOARDED_STORAGE_KEY = 'gearvane.onboarded';
export const APPEARANCE_EVENT = 'gearvane:appearance';

/**
 * Theme presets.
 *
 * Each theme owns the surfaces (backgrounds, borders, text) plus the second
 * ambience glow colour; the accent axis owns `--accent`. The default theme
 * reproduces the palette the app shipped before themes existed, so an
 * upgrading user sees no change until they opt into something else.
 */
export const THEMES: ThemePreset[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    vibe: 'The stock deep-space look',
    swatch: ['#0b1120', '#38bdf8', '#94a3b8'],
    vars: {
      '--bg': '#0b1120',
      '--bg-raised': '#131c31',
      '--bg-input': '#0f1729',
      '--border': '#24304a',
      '--border-strong': '#33415e',
      '--text': '#e2e8f0',
      '--text-dim': '#8494b0',
      '--glow-b': '#38bdf8',
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    vibe: 'Cyan light drifting through violet',
    swatch: ['#070b18', '#22d3ee', '#818cf8'],
    suggested: true,
    vars: {
      '--bg': '#070b18',
      '--bg-raised': '#101a33',
      '--bg-input': '#0c1428',
      '--border': '#26324f',
      '--border-strong': '#354463',
      '--text': '#e6ecfa',
      '--text-dim': '#8fa0bd',
      '--glow-b': '#22d3ee',
    },
  },
  {
    id: 'nebula',
    name: 'Nebula',
    vibe: 'Purple haze with high contrast',
    swatch: ['#0d0a1a', '#a78bfa', '#f472b6'],
    vars: {
      '--bg': '#0d0a1a',
      '--bg-raised': '#181233',
      '--bg-input': '#120e26',
      '--border': '#2e2552',
      '--border-strong': '#3f3468',
      '--text': '#ece9f8',
      '--text-dim': '#9a92bb',
      '--glow-b': '#a78bfa',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    vibe: 'Warm amber on charcoal',
    swatch: ['#150e0c', '#fb923c', '#f59e0b'],
    vars: {
      '--bg': '#150e0c',
      '--bg-raised': '#241715',
      '--bg-input': '#1b1210',
      '--border': '#3a2723',
      '--border-strong': '#4d352f',
      '--text': '#f1e8e4',
      '--text-dim': '#ab948c',
      '--glow-b': '#fb923c',
    },
  },
  {
    id: 'verdant',
    name: 'Verdant',
    vibe: 'Forest calm, moss-green edges',
    swatch: ['#0a1310', '#34d399', '#22c55e'],
    vars: {
      '--bg': '#0a1310',
      '--bg-raised': '#12211c',
      '--bg-input': '#0e1a16',
      '--border': '#234036',
      '--border-strong': '#2f5548',
      '--text': '#e6f2ec',
      '--text-dim': '#8faea1',
      '--glow-b': '#34d399',
    },
  },
];

/** Background (ambience) styles. The CSS keys off `data-bg`. */
export const BACKGROUNDS: OptionPreset[] = [
  { id: 'flat', name: 'Flat', vibe: 'Plain colour, no decoration', color: '#131c31' },
  { id: 'gradient', name: 'Wash', vibe: 'A soft colour wash in the corners', color: '#1d2b4d' },
  { id: 'aurora', name: 'Aurora', vibe: 'Slow drifting glows', color: '#2b1d4d' },
  { id: 'grid', name: 'Grid', vibe: 'Blueprint lines behind the panes', color: '#16233d' },
];

/** Accent colours. The CSS keys off `--accent` and friends. */
export const ACCENTS: AccentPreset[] = [
  { id: 'sky', name: 'Sky', color: '#38bdf8', dim: '#0e7490', on: '#04121d' },
  { id: 'violet', name: 'Violet', color: '#a78bfa', dim: '#5b21b6', on: '#04121d' },
  { id: 'pink', name: 'Pink', color: '#f472b6', dim: '#be185d', on: '#04121d' },
  { id: 'amber', name: 'Amber', color: '#fbbf24', dim: '#b45309', on: '#04121d' },
  { id: 'green', name: 'Green', color: '#34d399', dim: '#047857', on: '#04121d' },
  { id: 'graphite', name: 'Graphite', color: '#e2e8f0', dim: '#64748b', on: '#04121d' },
];

/** Motion styles. The CSS keys off `data-motion`. */
export const MOTIONS: OptionPreset[] = [
  { id: 'full', name: 'Full', vibe: 'Glows drift and transitions run' },
  { id: 'calm', name: 'Calm', vibe: 'Static colours, no decoration' },
];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'midnight',
  background: 'gradient',
  accent: 'sky',
  motion: 'full',
};

const themeIds = THEMES.map((theme) => theme.id);
const backgroundIds = BACKGROUNDS.map((option) => option.id);
const accentIds = ACCENTS.map((option) => option.id);

/**
 * Validate anything (stored JSON, a query string, a typo) into a usable
 * look. Unknown values fall back per field, so a partially valid stored
 * object keeps the parts that still make sense.
 */
export function resolveAppearance(raw: unknown): Appearance {
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const pick = (value: unknown, ids: string[], fallback: string): string =>
    typeof value === 'string' && ids.includes(value) ? value : fallback;

  return {
    theme: pick(source.theme, themeIds, DEFAULT_APPEARANCE.theme),
    background: pick(source.background, backgroundIds, DEFAULT_APPEARANCE.background),
    accent: pick(source.accent, accentIds, DEFAULT_APPEARANCE.accent),
    motion: source.motion === 'calm' || source.motion === 'full'
      ? source.motion
      : DEFAULT_APPEARANCE.motion,
  };
}

/**
 * First entry of a constant preset list.
 *
 * The lists below are declared non-empty in this file; the throw exists
 * only so the fallbacks below satisfy strict index checking without a
 * non-null assertion. It is unreachable in practice.
 */
function firstOf<T>(list: readonly T[]): T {
  const first = list[0];
  if (first === undefined) {
    throw new Error('gearvane appearance presets are empty');
  }
  return first;
}

/**
 * The custom properties a look sets on the document root.
 *
 * The theme supplies surfaces and the secondary glow; the accent supplies
 * the foreground pair. `--glow-a` follows the accent and is declared once in
 * the stylesheet as `var(--accent)`.
 */
export function appearanceVars(appearance: Appearance): Record<string, string> {
  const theme = THEMES.find((entry) => entry.id === appearance.theme) ?? firstOf(THEMES);
  const accent = ACCENTS.find((entry) => entry.id === appearance.accent) ?? firstOf(ACCENTS);

  return {
    ...theme.vars,
    '--accent': accent.color,
    '--accent-dim': accent.dim,
    '--accent-contrast': accent.on,
  };
}

/** Write a look onto a target. Pure property writes; no network, no I/O. */
export function applyAppearance(target: AppearanceTarget, appearance: Appearance): void {
  target.setAttribute('data-bg', appearance.background);
  target.setAttribute('data-motion', appearance.motion);

  for (const [name, value] of Object.entries(appearanceVars(appearance))) {
    target.style.setProperty(name, value);
  }
}

/** Read the stored look, falling back field by field on anything odd. */
export function loadAppearance(storage: AppearanceStorage): Appearance {
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    return resolveAppearance(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage must not stop the app from starting.
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(storage: AppearanceStorage, appearance: Appearance): void {
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Private-mode storage failure loses the look, not the session.
  }
}

/** True once the onboarding dialog has been shown, however it was closed. */
export function hasOnboarded(storage: AppearanceStorage): boolean {
  try {
    return storage.getItem(ONBOARDED_STORAGE_KEY) === 'yes';
  } catch {
    return true;
  }
}

export function markOnboarded(storage: AppearanceStorage): void {
  try {
    storage.setItem(ONBOARDED_STORAGE_KEY, 'yes');
  } catch {
    // If we cannot record it, the dialog shows again next launch: safe.
  }
}
