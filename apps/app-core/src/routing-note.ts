/**
 * Why the router picked what it picked, said so it can be read rather than
 * hovered.
 *
 * The router has recorded `reasons` on every decision since it started
 * recording them. Nothing displayed them. The desktop app put them in the tier
 * badge's `title`, which means: visible if you knew to look, invisible if you
 * did not, and gone the moment the pointer moved. The VS Code extension already
 * prints them in full.
 *
 * So this is presentation, and deliberately thin. It turns a decision into two
 * things -- a one-line summary for the status bar and a list for the detail --
 * without re-deciding anything. The wording is here rather than in the renderer
 * so it can be checked without a DOM, the same reason `provision-chip.ts` is a
 * module and not markup.
 */

/** The shape both a preview and a finished run present. */
export interface Routed {
  tier?: string;
  provider?: string;
  model?: string;
  reasons?: readonly string[];
  escalated?: boolean;
}

export interface RoutingNote {
  /** One line for the status bar. Empty when there is nothing worth saying. */
  summary: string;
  /** The reasons, for the detail view. */
  reasons: string[];
  /** True when something in the reasons means the choice was not routine. */
  notable: boolean;
}

/**
 * Reasons that are worth pulling out of the list.
 *
 * Substring matching, because the reasons are prose written by several places
 * and there is no enum to match on. Each phrase here is checked before it ships
 * by the desktop e2e, so a rewrite of the wording that loses one of these is a
 * test failure rather than a quiet demotion.
 */
const NOTABLE = [
  'escalat',
  'manual override',
  'matched no configured',
  'no config for tier',
  'degraded',
  'unavailable',
  'fallback',
];

/**
 * The one-line summary.
 *
 * Deliberately says which provider answered, not just the tier. The tier is the
 * part the router chose; the provider is the part that decides whether the run
 * costs anything, and it is the part people are actually trying to find out when
 * they look at a badge.
 */
export function summarise(decision: Routed): string {
  const where = decision.model
    ? `${decision.provider ?? '?'}/${decision.model}`
    : (decision.provider ?? decision.tier ?? 'unknown');
  const tier = decision.tier ? `${decision.tier} tier` : 'no tier';
  return `${tier} -> ${where}`;
}

export function describeRouting(decision: Routed): RoutingNote {
  const reasons = [...(decision.reasons ?? [])];
  return {
    summary: reasons.length === 0 ? '' : summarise(decision),
    reasons,
    notable: reasons.some((reason) =>
      NOTABLE.some((phrase) => reason.toLowerCase().includes(phrase)),
    ),
  };
}

/**
 * Why the last routing decision was notable, in one clause.
 *
 * For the escalation and no-config cases the badge alone reads as ordinary -- a
 * tier badge saying "high" gives no hint that it got there by failing twice on
 * "mid". So the escalation is called out in the visible line rather than left
 * for the reader to infer from the reasons list.
 */
export function headline(note: RoutingNote, decision: Routed): string {
  if (decision.escalated) return `${note.summary} (escalated after failures)`;
  const missing = note.reasons.find((reason) => reason.includes('matched no configured'));
  if (missing) return `${note.summary} (the pin you set matches no configured model)`;
  return note.summary;
}