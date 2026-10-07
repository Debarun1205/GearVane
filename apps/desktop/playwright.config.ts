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
  /**
   * One worker in CI, and for a specific reason.
   *
   * There are exactly two spec files, so the default two workers means
   * smoke.pw.ts (Chromium) and app.pw.ts (Electron) run at the same time on
   * one runner. On the Linux job that is a virtual display and no GPU, and the
   * contention is not affordable: the suite went from ~8s locally to 2m20s,
   * and the workers then could not tear down inside Playwright's 30s limit.
   * The assertions were never the problem -- they passed, on retry, every
   * time ("10 passed, 2 flaky"), and the two reported errors were worker
   * teardown, not a failed expectation.
   *
   * The Electron tests were already serial within their file, so serialising
   * across files removes the contention and costs almost nothing.
   */
  workers: process.env.CI === 'true' ? 1 : undefined,
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
