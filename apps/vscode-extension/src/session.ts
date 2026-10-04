/**
 * Session state shown in the GearVane sidebar view.
 *
 * Kept separate from the extension's command handlers so the view tree has
 * no dependency on the vscode module and can be unit tested.
 */

export interface SessionEntry {
  label: string;
  /** Secondary text shown to the right of the label. */
  description?: string;
  detail?: string;
  icon?: string;
}

export interface SessionState {
  routing: SessionEntry[];
  spend: SessionEntry[];
  health: SessionEntry[];
}

/** Icon ids that ship with VS Code's built-in icon set. */
export const ICONS = {
  tierLocal: 'symbol-event',
  tierMid: 'symbol-interface',
  tierFrontier: 'flame',
  healthy: 'pass',
  degraded: 'warning',
  unhealthy: 'error',
  unknown: 'question',
} as const;

export function tierIcon(tier: string): string {
  switch (tier) {
    case 'local':
      return ICONS.tierLocal;
    case 'mid':
      return ICONS.tierMid;
    case 'frontier':
      return ICONS.tierFrontier;
    default:
      return ICONS.unknown;
  }
}

export function healthIcon(status: string): string {
  switch (status) {
    case 'healthy':
      return ICONS.healthy;
    case 'degraded':
      return ICONS.degraded;
    case 'unhealthy':
      return ICONS.unhealthy;
    default:
      return ICONS.unknown;
  }
}

export function emptyState(): SessionState {
  return { routing: [], spend: [], health: [] };
}

/** Format a USD amount for display. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Format a duration in the most readable unit. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}