/**
 * Destructive-prompt detection for the Ask-me-first approval mode.
 *
 * The patterns mirror SafetyManager.classifyOperation in @gearvane/core, but
 * operate on free-form chat text rather than an exact command line: a prompt
 * that asks for a push, a deploy, a deletion, or a privileged shell command
 * is intercepted with an Approve / Revise dialog before anything runs.
 * Pure so the rules pin down in unit tests without a DOM.
 */

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /:\(\)\s*\{/,
  /\bgit\s+push\b/i,
  /--force\b/i,
  /\bgit\s+branch\s+-[dD]\b/i,
  /\bgit\s+merge\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bdocker\s+push\b/i,
  /\bfly\s+deploy\b/i,
  /\bflyctl\s+deploy\b/i,
  /\bvercel\b.*--prod/i,
  /\bwrangler\s+deploy\b/i,
  /\bnpm\s+publish\b/i,
  /\btwine\s+upload\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\bdelete\s+(branch|from)\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[fsq]/i,
];

/** True when a prompt should be confirmed before it runs. */
export function needsApproval(prompt: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(prompt));
}

export type ApprovalMode = 'ask-first' | 'auto';

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'ask-first';

export function parseApprovalMode(raw: string | null): ApprovalMode {
  return raw === 'auto' ? 'auto' : 'ask-first';
}

export type AgentMode = 'single' | 'pair';

export const DEFAULT_AGENT_MODE: AgentMode = 'single';

export function parseAgentMode(raw: string | null): AgentMode {
  return raw === 'pair' ? 'pair' : 'single';
}
