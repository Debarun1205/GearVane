import { describe, expect, it } from 'vitest';

import { SafetyManager } from '../src/safety.js';
import type { SafetyConfig } from '../src/types.js';

const safety = (): SafetyConfig => ({
  requireApproval: ['git_push', 'git_force_push', 'deploy_production', 'merge_pr'],
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
});