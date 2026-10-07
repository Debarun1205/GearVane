/**
 * Preload script.
 *
 * Runs in a sandboxed context with access to a minimal API surface. It uses
 * contextBridge rather than exposing Node, so the renderer cannot reach the
 * filesystem or spawn processes even if a dependency is compromised.
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  /**
   * Builder surface.
   *
   * The renderer can plan and write a scaffold but has no filesystem of its
   * own. Every argument crosses a channel, so the main process validates what
   * it receives rather than trusting the shape.
   */
  builder: {
    templates: () => ipcRenderer.invoke('builder:templates'),
    preview: (templateId, values) =>
      ipcRenderer.invoke('builder:preview', { templateId, values }),
    chooseFolder: () => ipcRenderer.invoke('builder:chooseFolder'),
    write: (templateId, values, directory) =>
      ipcRenderer.invoke('builder:write', { templateId, values, directory }),
    deployers: () => ipcRenderer.invoke('builder:deployers'),
  },

  /**
   * Machine facts, measured in the main process.
   *
   * A sandboxed renderer cannot statfs a volume or read total memory, and the
   * install dialog needs both to tell someone whether a weight will fit.
   */
  hardware: {
    info: () => ipcRenderer.invoke('hardware:info'),
  },

  /**
   * Terminal bridge.
   *
   * The renderer cannot load node-pty, so the main process owns the PTY and
   * this forwards keystrokes one way and output the other.
   */
  terminal: {
    start: (cwd) => ipcRenderer.invoke('terminal:start', cwd),
    write: (data) => ipcRenderer.send('terminal:write', data),
    resize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
    kill: () => ipcRenderer.send('terminal:kill'),
    onData: (handler) => {
      ipcRenderer.on('terminal:data', (_event, data) => handler(data));
    },
    onExit: (handler) => {
      ipcRenderer.on('terminal:exit', () => handler());
    },
  },

  /**
   * The directory the IDE works in.
   *
   * The renderer has no filesystem, so the main process asks for a folder.
   * Returns null when the user cancels, which the renderer reports rather than
   * defaulting to an arbitrary directory.
   */
  workspaceRoot: () => ipcRenderer.invoke('workspace:root'),

  /**
   * IDE filesystem bridge.
   *
   * Listing, reading, and saving go through the main process, which enforces
   * the same `Workspace` containment as the harness tools. The renderer never
   * touches `node:fs`, which is what keeps this bundle loadable inside the
   * Android webview.
   */
  ideFs: {
    list: (root) => ipcRenderer.invoke('ide:list', root),
    read: (root, path) => ipcRenderer.invoke('ide:read', root, path),
    write: (root, path, content) => ipcRenderer.invoke('ide:write', root, path, content),
    remove: (root, path) => ipcRenderer.invoke('ide:remove', root, path),
    search: (root, query, directory) =>
      ipcRenderer.invoke('ide:search', root, query, directory),
  },

  /**
   * IDE agent bridge.
   *
   * The loop runs in the main process, where the harness tool layer can use
   * Node. The renderer sends a prompt and receives step events plus a final
   * result; it never sees a tool or a provider client.
   */
  agent: {
    models: () => ipcRenderer.invoke('agent:models'),
    run: (prompt, root, options) =>
      ipcRenderer.invoke('agent:run', { prompt, root, ...(options ?? {}) }),
    cancel: () => ipcRenderer.send('agent:cancel'),
    onStep: (handler) => {
      const listener = (_event, step) => handler(step);
      ipcRenderer.on('agent:step', listener);
      return () => ipcRenderer.removeListener('agent:step', listener);
    },
  },

  /**
   * Model catalog for the Models dialog.
   *
   * Listing and fetching go through the main process, which writes into
   * the same directory the embedded server serves. The id is checked
   * against the catalog there, so the renderer cannot aim a download at
   * an arbitrary URL.
   */
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    // `confirmed` is the user's agreement, carried from the confirm dialog. The
    // main process refuses a weight at or above AUTO_INSTALL_LIMIT without
    // it, so a renderer that skipped the dialog cannot start a silent
    // multi-gigabyte transfer.
    fetch: (id, options) =>
      ipcRenderer.invoke('models:fetch', id, { confirmed: options?.confirmed === true }),
    cancel: (id) => ipcRenderer.invoke('models:cancel', id),
    // Measured in the main process: a sandboxed renderer cannot statfs or
    // read total memory.
    onProgress: (handler) => {
      const listener = (_event, progress) => handler(progress);
      ipcRenderer.on('models:progress', listener);
      return () => ipcRenderer.removeListener('models:progress', listener);
    },
  },

  /**
   * Key vault.
   *
   * The file is owned and encrypted by the main process through the OS secret
   * store; the renderer never touches it. Save is sanitized there too, so
   * whatever this channel carries cannot widen the variable allowlist.
   */
  keys: {
    read: () => ipcRenderer.invoke('keys:read'),
    save: (keys) => ipcRenderer.invoke('keys:save', keys),
    clear: () => ipcRenderer.invoke('keys:clear'),
  },

  /**
   * Subscribe to a main-process message.
   *
   * Returns an unsubscribe function so the renderer cannot leak listeners
   * across re-renders.
   */
  on: (channel, handler) => {
    const allowed = new Set(['config:error']);
    if (!allowed.has(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('gearvane', api);