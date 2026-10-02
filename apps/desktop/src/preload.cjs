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

contextBridge.exposeInMainWorld('waypoint', api);