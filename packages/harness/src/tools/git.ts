import { spawn } from 'node:child_process';
import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

/** Execute a git subcommand inside the workspace root. */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 60000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ ok: false, stdout, stderr: `${stderr}\n[git command timed out]`, code: -1 });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: -1 });
    });
  });
}

/** Check git status in the workspace. */
export const gitStatusTool: Tool = {
  schema: {
    name: 'git_status',
    description: 'Check git repository status: branch, untracked files, modified files, and staging status.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const res = await runGit(['status', '--short', '--branch'], ctx.workspace.root);
    return {
      ok: res.ok,
      content: res.stdout || res.stderr || 'Clean working tree.',
      ...(res.ok ? {} : { error: res.stderr }),
    };
  },
};

/** View recent git commit logs. */
export const gitLogTool: Tool = {
  schema: {
    name: 'git_log',
    description: 'View the last commit messages in the repository.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of commits to show (default: 5).',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const limit = typeof args['limit'] === 'number' ? Math.min(Math.max(1, args['limit']), 30) : 5;
    const res = await runGit(['log', `-${limit}`, '--oneline'], ctx.workspace.root);
    return {
      ok: res.ok,
      content: res.stdout || res.stderr || 'No commit history.',
      ...(res.ok ? {} : { error: res.stderr }),
    };
  },
};

/** Show git diff for unstaged or staged changes. */
export const gitDiffTool: Tool = {
  schema: {
    name: 'git_diff',
    description: 'Show git diff of changes in the repository.',
    parameters: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description: 'If true, shows changes staged for commit (--cached).',
        },
        path: {
          type: 'string',
          description: 'Optional specific file or folder path to inspect.',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gitArgs = ['diff'];
    if (args['staged']) gitArgs.push('--cached');
    if (typeof args['path'] === 'string' && args['path'].trim()) {
      gitArgs.push('--', args['path'].trim());
    }
    const res = await runGit(gitArgs, ctx.workspace.root);
    return {
      ok: res.ok,
      content: res.stdout || (res.ok ? 'No changes detected.' : res.stderr),
      ...(res.ok ? {} : { error: res.stderr }),
    };
  },
};

/** Stage files and create a git commit. */
export const gitCommitTool: Tool = {
  schema: {
    name: 'git_commit',
    description: 'Stage modified/new files and create a git commit.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message describing what changed.',
        },
        all: {
          type: 'boolean',
          description: 'If true, stages all tracked modified files (-a). Defaults to true.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const message = typeof args['message'] === 'string' ? args['message'].trim() : '';
    if (!message) return failure('Commit message is required.');

    // Stage all changes
    await runGit(['add', '-A'], ctx.workspace.root);
    const res = await runGit(['commit', '-m', message], ctx.workspace.root);
    return {
      ok: res.ok,
      content: res.stdout || res.stderr,
      ...(res.ok ? {} : { error: res.stderr }),
    };
  },
};

/** Git pull from remote repository. */
export const gitPullTool: Tool = {
  schema: {
    name: 'git_pull',
    description: 'Fetch and integrate changes from a remote repository into the current branch.',
    parameters: {
      type: 'object',
      properties: {
        remote: {
          type: 'string',
          description: 'Remote name (default: origin).',
        },
        branch: {
          type: 'string',
          description: 'Branch name (optional).',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gitArgs = ['pull'];
    if (typeof args['remote'] === 'string' && args['remote'].trim()) {
      gitArgs.push(args['remote'].trim());
      if (typeof args['branch'] === 'string' && args['branch'].trim()) {
        gitArgs.push(args['branch'].trim());
      }
    }
    const res = await runGit(gitArgs, ctx.workspace.root);
    return {
      ok: res.ok,
      content: res.stdout || res.stderr,
      ...(res.ok ? {} : { error: res.stderr }),
    };
  },
};

/** Git push to remote repository (requires safety approval). */
export const gitPushTool: Tool = {
  schema: {
    name: 'git_push',
    description: 'Push committed changes to a remote git repository.',
    parameters: {
      type: 'object',
      properties: {
        remote: {
          type: 'string',
          description: 'Remote name (default: origin).',
        },
        branch: {
          type: 'string',
          description: 'Branch name (optional).',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gitArgs = ['push'];
    if (typeof args['remote'] === 'string' && args['remote'].trim()) {
      gitArgs.push(args['remote'].trim());
      if (typeof args['branch'] === 'string' && args['branch'].trim()) {
        gitArgs.push(args['branch'].trim());
      }
    }
    const res = await runGit(gitArgs, ctx.workspace.root);
    return {
      ok: res.ok,
      content: res.stdout || res.stderr,
      ...(res.ok ? {} : { error: res.stderr }),
    };
  },
};

/** All standard git tools. */
export function gitTools(): Tool[] {
  return [gitStatusTool, gitLogTool, gitDiffTool, gitCommitTool, gitPullTool, gitPushTool];
}
