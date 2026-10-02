import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the same renderer bundle in a native Android shell, so the
 * mobile app and the desktop app run identical JavaScript.
 */
const config: CapacitorConfig = {
  appId: 'dev.waypoint.app',
  appName: 'Waypoint',
  webDir: 'renderer',

  // The renderer is served from disk, so there is no dev server to point at.
  server: {
    androidScheme: 'https',
  },

  android: {
    // Allow cleartext only to local model servers, which typically run on
    // http://localhost:11434 over the local network or an emulator host alias.
    allowMixedContent: false,
  },

  plugins: {
    // No Capacitor plugins are used. Everything runs in the webview against
    // the user's own model endpoints, so the app requests no device
    // permissions.
  },
};

export default config;