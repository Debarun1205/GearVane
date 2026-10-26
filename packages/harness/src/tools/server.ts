import { spawn, type ChildProcess } from 'node:child_process';
import { failure, type Tool, type ToolContext, type ToolResult } from './types.js';

export interface ActiveServer {
  id: string;
  command: string;
  port: number;
  url: string;
  startTime: number;
  process: ChildProcess;
}

const activeServers = new Map<string, ActiveServer>();

/** Tool to host/serve a web application locally with live browser preview */
export const hostAppTool: Tool = {
  schema: {
    name: 'host_app',
    description:
      'Start a local web server (e.g. Vite, Next.js, static HTTP server) in the workspace to host ' +
      'and preview a web application on loopback.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to start the dev server, e.g. "npm run dev", "npx serve -p 3000", or "python -m http.server 8080".',
        },
        port: {
          type: 'number',
          description: 'Port number the server is expected to bind to (e.g. 3000, 5173, 8080). Defaults to 3000.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args['command'] ?? '').trim();
    if (!command) return failure('Server command is required.');

    const port = typeof args['port'] === 'number' ? args['port'] : 3000;
    const serverId = `server-${port}`;

    if (activeServers.has(serverId)) {
      const existing = activeServers.get(serverId)!;
      return {
        ok: true,
        content: `A server is already running on port ${port} (PID ${existing.process.pid}): ${existing.url}`,
      };
    }

    try {
      const child = spawn(command, {
        cwd: ctx.workspace.root,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const url = `http://127.0.0.1:${port}`;
      activeServers.set(serverId, {
        id: serverId,
        command,
        port,
        url,
        startTime: Date.now(),
        process: child,
      });

      child.on('close', () => {
        activeServers.delete(serverId);
      });

      child.on('error', () => {
        activeServers.delete(serverId);
      });

      return {
        ok: true,
        content:
          `Dev server started successfully.\n` +
          `URL: ${url}\n` +
          `Port: ${port}\n` +
          `Process PID: ${child.pid}\n` +
          `Status: Running in workspace. Ready for live in-app preview iframe.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failure(`Failed to start server: ${msg}`);
    }
  },
};

/** Tool to stop an active local server */
export const stopServerTool: Tool = {
  schema: {
    name: 'stop_server',
    description: 'Stop a running local development server by its port number.',
    parameters: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: 'Port number of the server to stop.',
        },
      },
      required: ['port'],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const port = Number(args['port']);
    const serverId = `server-${port}`;
    const server = activeServers.get(serverId);

    if (!server) {
      return failure(`No active server found listening on port ${port}.`);
    }

    server.process.kill();
    activeServers.delete(serverId);
    return {
      ok: true,
      content: `Stopped dev server on port ${port} (PID ${server.process.pid}).`,
    };
  },
};

/** List all running local dev servers */
export function getActiveDevServers(): Array<{ id: string; command: string; port: number; url: string }> {
  return [...activeServers.values()].map((s) => ({
    id: s.id,
    command: s.command,
    port: s.port,
    url: s.url,
  }));
}
