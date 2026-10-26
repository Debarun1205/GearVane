import { describe, expect, it } from 'vitest';
import {
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPullTool,
  gitPushTool,
  gitStatusTool,
  gitTools,
} from '../src/tools/git.js';

describe('gitTools', () => {
  it('exports all 6 git tools', () => {
    const tools = gitTools();
    expect(tools.length).toBe(6);
    const names = tools.map((t) => t.schema.name);
    expect(names).toEqual([
      'git_status',
      'git_log',
      'git_diff',
      'git_commit',
      'git_pull',
      'git_push',
    ]);
  });

  it('declares valid schemas with correct descriptions', () => {
    expect(gitStatusTool.schema.name).toBe('git_status');
    expect(gitLogTool.schema.parameters.properties).toHaveProperty('limit');
    expect(gitDiffTool.schema.parameters.properties).toHaveProperty('staged');
    expect(gitCommitTool.schema.parameters.required).toEqual(['message']);
    expect(gitPullTool.schema.name).toBe('git_pull');
    expect(gitPushTool.schema.name).toBe('git_push');
  });

  it('runs git_status on the current workspace safely', async () => {
    const result = await gitStatusTool.execute({}, {
      workspace: { root: process.cwd() } as any,
    });
    expect(result.ok).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });
});
