import { describe, expect, it } from 'vitest';

import { SafetyManager } from '../src/safety.js';
import type { SafetyConfig } from '../src/types.js';

const safety = (): SafetyConfig => ({
  requireApproval: ['git_push', 'git_force_push', 'deploy_production', 'merge_pr', 'shell_injection'],
  sandboxAllowed: ['git status', 'git log', 'ls', 'cat'],
  blockedCommands: ['rm -rf', 'sudo'],
});

describe('SafetyManager gating', () => {
  it('denies a blocked command', () => {
    expect(new SafetyManager(safety()).check('rm -rf /').status).toBe('denied');
  });

  it('denies a blocked command even before approval logic runs', () => {
    // Order matters: a blocked pattern must win over an allowlist prefix.
    const manager = new SafetyManager({
      ...safety(),
      sandboxAllowed: ['rm -rf'],
    });
    expect(manager.check('rm -rf /tmp').status).toBe('denied');
  });

  it('auto-approves an allowlisted command', () => {
    expect(new SafetyManager(safety()).check('git status').status).toBe('auto_approved');
  });

  it('requires approval for a push', () => {
    expect(new SafetyManager(safety()).check('git push origin main').status).toBe('pending');
  });

  it('requires approval for a force push', () => {
    expect(
      new SafetyManager(safety()).check('git push --force origin main').status,
    ).toBe('pending');
  });

  it('requires approval for a production deploy', () => {
    expect(
      new SafetyManager(safety()).check('vercel deploy --prod').status,
    ).toBe('pending');
  });

  it('auto-approves an unlisted shell command', () => {
    expect(new SafetyManager(safety()).check('npm run build').status).toBe('auto_approved');
  });

  it('tracks pending approvals', () => {
    const manager = new SafetyManager(safety());
    manager.check('git push origin main');
    manager.check('git push --force origin main');
    expect(manager.getPendingApprovals()).toHaveLength(2);
  });

  it('clears a request from the pending list once approved', () => {
    const manager = new SafetyManager(safety());
    manager.check('git push origin main');
    expect(manager.getPendingApprovals()).toHaveLength(1);

    expect(manager.approveCommand('git push origin main')).toBe(true);
    expect(manager.getPendingApprovals()).toHaveLength(0);
  });

  it('reports no match for an unknown command', () => {
    expect(new SafetyManager(safety()).approveCommand('nothing pending')).toBe(false);
  });

  it('can deny a request', () => {
    const manager = new SafetyManager(safety());
    const request = manager.check('git push origin main');
    manager.deny(request);
    expect(request.status).toBe('denied');
  });
});

describe('operation classification', () => {
  const classify = SafetyManager.classifyOperation;

  it('distinguishes push from force push', () => {
    expect(classify('git push origin main')).toBe('git_push');
    expect(classify('git push --force origin main')).toBe('git_force_push');
    expect(classify('git push -f origin main')).toBe('git_force_push');
  });

  it('recognises destructive operations', () => {
    expect(classify('git branch -D feature')).toBe('delete_branch');
    expect(classify('git push --delete origin feature')).toBe('delete_branch');
    expect(classify('git merge main')).toBe('merge_pr');
    expect(classify('gh pr merge 12')).toBe('merge_pr');
  });

  it('recognises deploys', () => {
    expect(classify('fly deploy')).toBe('deploy_production');
    expect(classify('wrangler deploy')).toBe('deploy_production');
    expect(classify('npm publish')).toBe('deploy_production');
    expect(classify('twine upload dist/*')).toBe('deploy_production');
    expect(classify('docker push myapp')).toBe('docker_push');
  });

  it('is case insensitive', () => {
    expect(classify('GIT PUSH origin main')).toBe('git_push');
  });

  it('falls back to shell', () => {
    expect(classify('npm run build')).toBe('shell');
  });

  it('is the reason the checked command must match the executed command', () => {
    // Regression: a caller passed "push origin main" rather than
    // "git push origin main", which classified as shell and auto-approved.
    // Matching is documented and tested so the shape cannot silently drift.
    expect(classify('push origin main')).toBe('shell');
    expect(classify('git push origin main')).toBe('git_push');
  });

  const nested: Array<[string, string]> = [
    ['bash -c', 'bash -c "git push origin main"'],
    ['sh -c', 'sh -c "git push"'],
    ['zsh with flags', 'zsh -e -c "git push"'],
    ['cmd /c', 'cmd /c git push'],
    ['powershell -EncodedCommand', 'powershell -EncodedCommand ZWNobw=='],
    ['pwsh -c', 'pwsh -c "git push"'],
    ['path-prefixed', '/bin/bash -c "git push"'],
    ['quote-split payload', 'bash -c "git\' \'push"'],
  ];

  it.each(nested)('classifies %s as shell_injection', (_label, command) => {
    // The nested interpreter re-parses its argument, so the gate sees a
    // different string than the shell executes. Quoting tricks defeat
    // every substring check, so the construct itself is consequential.
    expect(classify(command)).toBe('shell_injection');
  });
});

describe('gate-bypass hardening', () => {
  const manager = (): SafetyManager => new SafetyManager(safety());

  it('auto-approves an exact allowlisted command', () => {
    const decision = manager().check('git status');
    expect(decision.status).toBe('auto_approved');
    expect(decision.operation).toBe('sandbox');
  });

  it('does not let a compound command ride the allowlist past a gate', () => {
    // The bypass: `git status; git push` starts with an allowlisted
    // command, so the prefix match auto-approved it and the push gate
    // never ran. Exact argv matching closes it: the compound command
    // classifies as a push and requires approval.
    const decision = manager().check('git status; git push origin main');
    expect(decision.operation).toBe('git_push');
    expect(decision.status).toBe('pending');
  });

  it('does not classify a compound command as sandbox even when auto-approved', () => {
    // A non-consequential compound command is auto-approved as 'shell' —
    // the same as any unknown command — but never via the allowlist.
    const decision = manager().check('git status; curl example.com');
    expect(decision.operation).not.toBe('sandbox');
    expect(decision.operation).toBe('shell');
  });

  it('does not let an allowlisted command with extra arguments ride the allowlist', () => {
    const decision = manager().check('git status --porcelain');
    expect(decision.operation).not.toBe('sandbox');
  });

  it('does not let a Unicode look-alike ride the allowlist', () => {
    const decision = manager().check('git ｓtatus');
    expect(decision.operation).not.toBe('sandbox');
  });

  it('requires approval for a nested interpreter, however it is quoted', () => {
    expect(manager().check('bash -c "git push origin main"').status).toBe('pending');
    expect(manager().check('bash -c "git\' \'push"').status).toBe('pending');
    expect(manager().check('powershell -EncodedCommand ZWNobw==').status).toBe('pending');
  });

  it('still auto-approves an unlisted simple command', () => {
    const decision = manager().check('npm run build');
    expect(decision.status).toBe('auto_approved');
    expect(decision.operation).toBe('shell');
  });
});