import { matchesAllowlist } from './command-parse.js';
import type { SafetyConfig } from './types.js';
import type { Tier } from './types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'auto_approved';

export interface ApprovalRequest {
  operation: string;
  command: string;
  reason: string;
  status: ApprovalStatus;
}

/**
 * Approval gating for shell commands.
 *
 * Three classes of command: blocked (never runs), allowlisted (runs without
 * asking), and everything else (needs approval).
 */
export class SafetyManager {
  readonly requireApproval: Set<string>;
  readonly sandboxAllowed: readonly string[];
  readonly blockedCommands: readonly string[];

  private pending: ApprovalRequest[] = [];

  constructor(config: SafetyConfig) {
    this.requireApproval = new Set(config.requireApproval);
    this.sandboxAllowed = config.sandboxAllowed;
    this.blockedCommands = config.blockedCommands;
  }

  /**
   * Classify a command into an operation type.
   *
   * Matching is done on the full command line, so callers must pass the
   * string that will actually execute. Passing a bare subcommand such as
   * "push" instead of "git push" classifies as an ordinary shell command
   * and bypasses the push gate; that was a real bug.
   */
  static classifyOperation(command: string): string {
    const normalized = command.toLowerCase();

    // A nested interpreter re-parses its argument, so the gate sees a
    // different string than the shell executes: `bash -c "git' 'push"`
    // classifies as an ordinary shell command but runs a push. Quoting
    // tricks defeat every substring check, so the construct itself is
    // consequential and always requires approval.
    if (/(^|\s)(\S*\/)?(bash|sh|zsh|ksh|cmd|powershell|pwsh)(\s+[^\s]+)*\s+(-c\b|-encodedcommand\b|\/c\b)/.test(normalized)) {
      return 'shell_injection';
    }

    // "git push --delete" removes a remote branch, so it must be classified as
    // a deletion rather than a push. Order matters.
    if (normalized.includes('git push --delete') || normalized.includes('git push --mirror')) {
      return 'delete_branch';
    }
    if (normalized.includes('git branch -d') || normalized.includes('git branch -D')) {
      return 'delete_branch';
    }
    if (normalized.includes('git push')) {
      return normalized.includes('--force') || /\s-f(\s|$)/.test(normalized)
        ? 'git_force_push'
        : 'git_push';
    }
    if (normalized.includes('git merge') || normalized.includes('gh pr merge')) {
      return 'merge_pr';
    }
    if (normalized.includes('docker push')) return 'docker_push';
    if (normalized.includes('fly deploy') || normalized.includes('flyctl deploy')) {
      return 'deploy_production';
    }
    if (normalized.includes('vercel') && normalized.includes('--prod')) {
      return 'deploy_production';
    }
    if (normalized.includes('wrangler deploy')) return 'deploy_production';
    if (normalized.includes('npm publish') || normalized.includes('twine upload')) {
      return 'deploy_production';
    }
    if (normalized.includes('rm -rf') || normalized.includes('del /')) {
      return 'destructive';
    }

    return 'shell';
  }

  check(command: string): ApprovalRequest {
    for (const blocked of this.blockedCommands) {
      if (command.includes(blocked)) {
        return {
          operation: 'blocked',
          command,
          reason: `Command contains blocked pattern: ${blocked}`,
          status: 'denied',
        };
      }
    }

    // Exact argv match, never a prefix: `git status; rm -rf /` starts with
    // `git status` but is not it, and a compound command must never ride
    // the allowlist past the approval gate.
    if (matchesAllowlist(command, this.sandboxAllowed)) {
      return {
        operation: 'sandbox',
        command,
        reason: 'Command is in the sandbox allowlist',
        status: 'auto_approved',
      };
    }

    const operation = SafetyManager.classifyOperation(command);
    if (this.requireApproval.has(operation)) {
      const request: ApprovalRequest = {
        operation,
        command,
        reason: `Operation '${operation}' requires approval`,
        status: 'pending',
      };
      this.pending.push(request);
      return request;
    }

    return {
      operation,
      command,
      reason: 'No approval required',
      status: 'auto_approved',
    };
  }

  approve(request: ApprovalRequest): void {
    request.status = 'approved';
  }

  deny(request: ApprovalRequest): void {
    request.status = 'denied';
  }

  getPendingApprovals(): ApprovalRequest[] {
    return this.pending.filter((request) => request.status === 'pending');
  }

  approveCommand(command: string): boolean {
    const match = this.getPendingApprovals().find((r) => r.command === command);
    if (!match) return false;
    this.approve(match);
    return true;
  }
}

/** Convenience alias used by the CLI. */
export type GatedOperation = Tier;