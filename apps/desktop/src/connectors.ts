/**
 * Connector registry: external MCP servers the user adds.
 *
 * Built-in agent capabilities live in skills.ts. This module owns the
 * user-added side: servers registered through the "+ Add MCP Server"
 * dialog, persisted device-local, shown in the sidebar Connectors section.
 * Parsing and id assignment are pure so the validation pins in unit tests.
 */

export interface McpServerDraft {
  name: string;
  url?: string;
  command?: string;
  tools: string[];
}

export interface McpServer extends McpServerDraft {
  id: string;
  enabled: boolean;
  createdAt: number;
}

export interface ConnectorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CONNECTORS_STORAGE_KEY = 'gearvane.connectors';

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'server';
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/**
 * Parse the JSON pasted into the Add dialog.
 *
 * Accepts { name, url?, command?, tools? }. At least one of url or command
 * is required: a server the app can neither reach nor spawn is a dead row.
 */
export function parseMcpServerJson(
  text: string,
): { ok: true; draft: McpServerDraft } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Describe one server as a JSON object.' };
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!name) {
    return { ok: false, error: 'A "name" string is required.' };
  }
  const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
  const command =
    typeof record['command'] === 'string' ? record['command'].trim() : '';
  if (!url && !command) {
    return { ok: false, error: 'Give the server a "url" or a "command".' };
  }
  const toolsRaw = record['tools'];
  let tools: string[] = [];
  if (toolsRaw !== undefined) {
    if (!Array.isArray(toolsRaw) || toolsRaw.some((item) => typeof item !== 'string')) {
      return { ok: false, error: '"tools" must be an array of strings.' };
    }
    tools = (toolsRaw as string[]).map((item) => item.trim()).filter(Boolean);
  }
  const draft: McpServerDraft = { name, tools };
  if (url) draft.url = url;
  if (command) draft.command = command;
  return { ok: true, draft };
}

/** Read the registry; corrupt storage reads as empty, never throws. */
export function loadConnectors(storage: ConnectorStorage): McpServer[] {
  try {
    const raw = storage.getItem(CONNECTORS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: McpServer[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || typeof record['name'] !== 'string') {
        continue;
      }
      out.push({
        id: record['id'] as string,
        name: record['name'] as string,
        tools: Array.isArray(record['tools'])
          ? (record['tools'] as unknown[]).filter((item): item is string => typeof item === 'string')
          : [],
        enabled: record['enabled'] !== false,
        createdAt: typeof record['createdAt'] === 'number' ? (record['createdAt'] as number) : 0,
        ...(typeof record['url'] === 'string' ? { url: record['url'] as string } : {}),
        ...(typeof record['command'] === 'string' ? { command: record['command'] as string } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function saveAll(storage: ConnectorStorage, servers: McpServer[]): void {
  try {
    storage.setItem(CONNECTORS_STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // A lost registry only means re-adding servers next launch.
  }
}

export function addConnector(
  storage: ConnectorStorage,
  draft: McpServerDraft,
): McpServer {
  const servers = loadConnectors(storage);
  const taken = new Set(servers.map((server) => server.id));
  const server: McpServer = {
    ...draft,
    id: uniqueId(slugify(draft.name), taken),
    enabled: true,
    createdAt: Date.now(),
  };
  servers.push(server);
  saveAll(storage, servers);
  return server;
}

export function toggleConnector(storage: ConnectorStorage, id: string): McpServer[] {
  const servers = loadConnectors(storage).map((server) =>
    server.id === id ? { ...server, enabled: !server.enabled } : server,
  );
  saveAll(storage, servers);
  return servers;
}

export function removeConnector(storage: ConnectorStorage, id: string): McpServer[] {
  const servers = loadConnectors(storage).filter((server) => server.id !== id);
  saveAll(storage, servers);
  return servers;
}
