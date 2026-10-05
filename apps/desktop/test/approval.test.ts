import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_MODE,
  DEFAULT_APPROVAL_MODE,
  needsApproval,
  parseAgentMode,
  parseApprovalMode,
} from '../src/approval.js';

describe('needsApproval', () => {
  it('flags destructive shell text', () => {
    expect(needsApproval('run rm -rf /tmp/cache')).toBe(true);
    expect(needsApproval('sudo apt install ripgrep')).toBe(true);
    expect(needsApproval('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(needsApproval('DROP TABLE users')).toBe(true);
  });

  it('flags pushes, merges, and deploys', () => {
    expect(needsApproval('git push origin main')).toBe(true);
    expect(needsApproval('git push --force')).toBe(true);
    expect(needsApproval('gh pr merge the feature branch')).toBe(true);
    expect(needsApproval('vercel deploy --prod')).toBe(true);
    expect(needsApproval('npm publish')).toBe(true);
  });

  it('leaves ordinary prompts alone', () => {
    expect(needsApproval('fix a typo in the readme')).toBe(false);
    expect(needsApproval('explain how the router picks a tier')).toBe(false);
    expect(needsApproval('')).toBe(false);
  });
});

describe('approval and agent modes', () => {
  it('defaults to ask-first single agent', () => {
    expect(DEFAULT_APPROVAL_MODE).toBe('ask-first');
    expect(DEFAULT_AGENT_MODE).toBe('single');
  });

  it('parses stored values defensively', () => {
    expect(parseApprovalMode('auto')).toBe('auto');
    expect(parseApprovalMode('ask-first')).toBe('ask-first');
    expect(parseApprovalMode('nope')).toBe('ask-first');
    expect(parseAgentMode('pair')).toBe('pair');
    expect(parseAgentMode(null)).toBe('single');
  });
});
