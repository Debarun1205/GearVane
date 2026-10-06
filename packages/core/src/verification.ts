/**
 * Verification: deciding whether an answer is actually right.
 *
 * This is the piece the product's name promises and the code did not have.
 * Escalation fired on a model or provider error - a 500, a timeout, a refusal -
 * which is a signal that the *transport* failed. Nothing looked at whether the
 * *answer* was correct, so a confidently wrong local model returned a bad
 * result and the run reported success.
 *
 * ## Why the verifier is injected
 *
 * Core cannot know what "correct" means for a task. Whether that is a passing
 * test suite, a typecheck, a lint, or a file existing depends on the project,
 * and running any of them needs a subprocess that core has no business owning.
 * So the host supplies a verifier and core asks it.
 *
 * This matters for honesty as much as for design. With no verifier the
 * behaviour is exactly what it was, and the result says so:
 * `verification: 'unverified'`. Nothing infers a pass from an absence.
 */

/** What a verifier concluded. */
export type VerificationOutcome =
  /** The answer works. */
  | 'pass'
  /**
   * The answer does not work, and here is why.
   *
   * The detail is not decoration: it goes back into the next attempt's prompt,
   * so a stronger model is told what actually failed rather than being asked
   * the same question again.
   */
  | 'fail'
  /**
   * The verifier could not tell.
   *
   * Distinct from pass on purpose. A verifier that times out, or a check that
   * cannot run in this environment, has not confirmed anything - and treating
   * that as a pass would make the app claim verification it never performed.
   * Unknown does not escalate.
   */
  | 'unknown';

/** A verifier's verdict, with enough detail to act on. */
export interface VerificationResult {
  outcome: VerificationOutcome;
  /**
   * Why, in a form a model can read.
   *
   * Capped because this is fed into the next prompt: a 4,000-line test log
   * would crowd out the task and cost more than the model being escalated to.
   */
  detail?: string;
}

/**
 * Check whether `content` is a correct answer.
 *
 * Returns unknown rather than throwing for "could not check". A throw is
 * reserved for a verifier that is genuinely broken, and the orchestrator treats
 * a thrown verifier as unknown too - a broken check must not be able to
 * manufacture a failure and drive escalation.
 */
export type Verifier = (
  content: string,
  context: {
    taskId: string;
    prompt: string;
    tier: string;
    model: string;
    attempt: number;
    signal?: AbortSignal;
  },
) => Promise<VerificationResult> | VerificationResult;

/** Longest verifier detail carried into a retry prompt. */
export const MAX_VERIFIER_DETAIL = 2000;

/**
 * Trim verifier output to what a retry can use.
 *
 * Keeps the tail rather than the head: a test runner's useful signal is the
 * failure, which is at the end, and the head is progress noise.
 */
export function trimDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length <= MAX_VERIFIER_DETAIL) return trimmed;
  return `...\n${trimmed.slice(-MAX_VERIFIER_DETAIL)}`;
}

/**
 * Run a verifier, converting anything unexpected into `unknown`.
 *
 * A verifier is the one component whose failure mode matters most: a thrown
 * error here must never look like a failed check, or a bug in the check would
 * escalate every task and burn a frontier model on a working answer.
 */
export async function runVerifier(
  verifier: Verifier,
  content: string,
  context: Parameters<Verifier>[1],
): Promise<VerificationResult> {
  try {
    const result = await verifier(content, context);
    if (!result || typeof result.outcome !== 'string') {
      return { outcome: 'unknown', detail: 'verifier returned no outcome' };
    }
    if (!['pass', 'fail', 'unknown'].includes(result.outcome)) {
      return {
        outcome: 'unknown',
        detail: `verifier returned an unrecognised outcome: ${result.outcome}`,
      };
    }
    return { outcome: result.outcome, detail: trimDetail(result.detail) };
  } catch (error) {
    return {
      outcome: 'unknown',
      detail: `verifier failed to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** How a result's verification should be reported. */
export interface VerificationSummary {
  outcome: VerificationOutcome;
  detail?: string;
  /** Which attempt produced this verdict. */
  attempt: number;
  /** Tier that was checked, which may differ from the tier that answered. */
  tier: string;
  model: string;
}

/**
 * The prompt for a retry that follows a failed check.
 *
 * Without the verifier's detail a retry is just the same question again with a
 * bigger model, which is the thing this whole mechanism exists to avoid.
 */
export function retryPrompt(prompt: string, verification: VerificationSummary): string {
  const parts = [prompt];
  if (verification.outcome === 'fail') {
    parts.push(
      '',
      'A previous attempt at this task was checked and did not pass:',
      verification.detail ? verification.detail : '(the check reported no detail)',
      '',
      'That was attempted on the ' +
        `${verification.tier} tier using ${verification.model}. ` +
        'Fix the specific problem above rather than redoing the task from scratch.',
    );
  }
  return parts.join('\n');
}