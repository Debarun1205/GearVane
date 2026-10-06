/**
 * Contrast audit of the renderer's own palette.
 *
 * The theme variables are fixed hex values on a fixed background, so every
 * foreground/background pair in the stylesheet has a computable ratio. The
 * point of computing it here rather than eyeballing it in a screenshot is that
 * dim text on near-black is exactly the kind of thing that looks acceptable
 * and fails at 4.5:1.
 *
 * These are the app's own colours only. Monaco ships its own themes and is not
 * ours to audit here.
 */

export interface Ratio {
  /** WCAG 2.1 relative luminance of the foreground. */
  fg: number;
  bg: number;
  /** Contrast ratio, 1 to 21. */
  ratio: number;
  /** Passes WCAG AA for normal text. */
  aa: boolean;
  /** Passes AA for large text (18.66px bold, or 24px). */
  aaLarge: boolean;
  /** Passes AAA for normal text. */
  aaa: boolean;
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(fg: string, bg: string): Ratio {
  const a = luminance(fg);
  const b = luminance(bg);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return {
    fg: a,
    bg: b,
    ratio,
    aa: ratio >= 4.5,
    aaLarge: ratio >= 3,
    aaa: ratio >= 7,
  };
}

/** The palette under test, mirroring the :root block in styles.css. */
export const PALETTE = {
  bg: '#0b1120',
  bgRaised: '#131c31',
  bgSoft: '#0f1729',
  text: '#e2e8f0',
  textDim: '#8494b0',
  accent: '#38bdf8',
  accentDim: '#0e7490',
  accentContrast: '#04121d',
  tierLocal: '#22c55e',
  tierMid: '#f59e0b',
  tierFrontier: '#f472b6',
  danger: '#ef4444',
  warning: '#f0b866',
  border: '#24304a',
  borderStrong: '#33415e',
} as const;

/** Foreground/background pairs that actually appear together. */
export const PAIRS: Array<{ what: string; fg: keyof typeof PALETTE; bg: keyof typeof PALETTE }> = [
  { what: 'body text on the app background', fg: 'text', bg: 'bg' },
  { what: 'body text on a raised panel', fg: 'text', bg: 'bgRaised' },
  { what: 'body text on a soft input', fg: 'text', bg: 'bgSoft' },
  { what: 'dim text on the app background', fg: 'textDim', bg: 'bg' },
  { what: 'dim text on a raised panel', fg: 'textDim', bg: 'bgRaised' },
  { what: 'accent text on the app background', fg: 'accent', bg: 'bg' },
  { what: 'accent text on a raised panel', fg: 'accent', bg: 'bgRaised' },
  { what: 'text on an accent-filled button', fg: 'accentContrast', bg: 'accent' },
  { what: 'local-tier marker on the app background', fg: 'tierLocal', bg: 'bg' },
  { what: 'mid-tier marker on the app background', fg: 'tierMid', bg: 'bg' },
  { what: 'frontier-tier marker on the app background', fg: 'tierFrontier', bg: 'bg' },
  { what: 'danger text on the app background', fg: 'danger', bg: 'bg' },
  { what: 'warning text on the app background', fg: 'warning', bg: 'bg' },
  { what: 'warning text on a raised panel', fg: 'warning', bg: 'bgRaised' },
  { what: 'border on the app background', fg: 'borderStrong', bg: 'bg' },
];