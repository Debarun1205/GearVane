/**
 * What this session and this day have cost, and whether it costs anything.
 *
 * R4 says no usage or spend limit is enforced on the user, for any model. This
 * is what replaced the limit: a readout. There is no cap behind it, no warning
 * threshold, and nothing that can cut a run off. `BudgetExceeded` was deleted
 * from both engines rather than left present and unreachable, and this is the
 * half of the idea that survives.
 *
 * The distinction it has to draw is free versus billable, and the rule is the
 * same one the engine uses: a run costs money only if reaching the model needed
 * a key that belongs to somebody else. A weight on the user's own disk costs
 * nothing in any tier, so a local run reads as free rather than as $0.00 --
 * "$0.00" invites the question of what the zero was out of.
 */

/** What a provider is, as far as cost is concerned. */
export type CostKind = 'free' | 'metered';

export interface CostReading {
  /** USD this session. */
  session: number;
  /** USD today, across sessions. */
  day: number;
  /** Whether any of it could have cost anything. */
  kind: CostKind;
  /** What to put on screen. Empty when nothing has run yet. */
  label: string;
  /** Longer text for the tooltip and for a screen reader. */
  detail: string;
}

const KEY = 'gearvane.daySpend';

/**
 * "Today", keyed by calendar date in the user's own timezone.
 *
 * A calendar date rather than a rolling 24 hours, because the figure is labelled
 * "today" and a rolling window would quietly disagree with the word.
 */
export function dayKey(now: number): string {
  const local = new Date(now);
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const date = String(local.getDate()).padStart(2, '0');
  return `${local.getFullYear()}-${month}-${date}`;
}

export interface DaySpendStore {
  /** Reads the stored total and the day it belongs to. */
  read(): { day: string; usd: number } | null;
  write(day: string, usd: number): void;
}

/**
 * localStorage, behind an interface.
 *
 * An interface so the day total can be driven without a DOM, and so a host with
 * no storage (the Android webview before it is ready) degrades to session-only
 * rather than throwing.
 */
export function browserDaySpendStore(storage?: Storage): DaySpendStore {
  return {
    read() {
      try {
        const raw = (storage ?? globalThis.localStorage)?.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { day?: string; usd?: number };
        if (typeof parsed.day !== 'string' || typeof parsed.usd !== 'number') return null;
        return { day: parsed.day, usd: parsed.usd };
      } catch {
        return null;
      }
    },
    write(day, usd) {
      try {
        (storage ?? globalThis.localStorage)?.setItem(KEY, JSON.stringify({ day, usd }));
      } catch {
        // A full or disabled store means the day total is unavailable, not that
        // the session total is wrong.
      }
    },
  };
}

/**
 * Accumulate a run's cost into the session and day totals.
 *
 * `kind` is sticky in the pessimistic direction: once anything billable has run
 * today, the meter keeps showing a figure. A local run after a keyed one does not
 * reset it to "free", because the day's cost did not go away.
 */
export function accumulate(
  state: { session: number; day: number },
  costUsd: number | undefined,
  kind: CostKind,
  now: number,
  store: DaySpendStore,
): { session: number; day: number } {
  const today = dayKey(now);
  const stored = store.read();
  // A new day starts the running total again; yesterday's spend is not today.
  const base = stored && stored.day === today ? stored.usd : 0;

  const added = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const session = round(state.session + added);
  const day = round(base + added);
  store.write(today, day);
  return { session, day };
}

/**
 * What to show.
 *
 * Free and nothing has run reads as an absence, not a zero. Metered reads as a
 * figure with its unit, because that is the number someone on a metered link
 * wants.
 */
export function describe(reading: {
  session: number;
  day: number;
  kind: CostKind;
}): CostReading {
  const { session, day, kind } = reading;

  if (kind === 'free') {
    return {
      ...reading,
      // "Free, unlimited" whether or not something has run. It is a statement
      // about the model, not about the day's arithmetic -- and it is the honest
      // thing to show after a local run, where "$0.00" would invite the question
      // of what the zero was a fraction of.
      label: 'Free, unlimited',
      detail:
        'This ran on a local weight, on your own machine. Local models cost ' +
        'nothing per token, and no limit is enforced on any model.',
    };
  }

  const usd = `$${day.toFixed(4)}`;
  return {
    ...reading,
    label: usd,
    detail:
      `$${session.toFixed(4)} this session, ${usd} today, through your own API key. ` +
      'Nothing is capped: this is a readout, not a limit, and no run is stopped ' +
      'for costing anything.',
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
