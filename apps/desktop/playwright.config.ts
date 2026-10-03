import { defineConfig } from '@playwright/test';

/**
 * Smoke suite for the shipped renderer bundle.
 *
 * The vitest suite here runs in the node environment and cannot execute the
 * DOM, so it pins structure instead of behaviour - which is exactly how a
 * renderer that threw on load passed every unit test in v0.3.0. These tests
 * run the real `renderer/renderer.js` in Chromium and assert behaviour:
 * the page boots, stays error-free, and the dialogs work.
 *
 * Specs use the `.pw.ts` suffix so vitest's `test/**` glob never collects
 * them and Playwright's `testMatch` picks them up unambiguously.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8940',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://127.0.0.1:8940/index.html',
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 15_000,
  },
});
