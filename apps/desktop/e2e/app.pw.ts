import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

/**
 * End-to-end test of the real desktop app: main process, preload bridge,
 * renderer, and the IDE (Monaco included) in one run.
 *
 * Nothing else in the repo can do this. The vitest suite has no DOM, the
 * browser smoke suite has no host bridge, so the IDE - the app's largest
 * surface - had zero behavioural coverage until now.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MAIN = join(HERE, '..', 'dist', 'main.js');

let app: ElectronApplication | null = null;

test.beforeEach(async () => {
  // Fresh profile per test: onboarding state must be deterministic, and no
  // run may inherit another run's localStorage.
  const userData = await mkdtemp(join(tmpdir(), 'gearvane-e2e-'));
  app = await electron.launch({
    args: [
      MAIN,
      // CI runners have no GPU or interactive sandbox setup; these tests
      // assert DOM behaviour, not compositing.
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userData}`,
    ],
  });
});

test.afterEach(async () => {
  await app?.close();
  app = null;
});

/** Failures a human would notice: uncaught exceptions and console.error. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test('boots chat with onboarding, then opens the IDE', async () => {
  const page = await app!.firstWindow();
  const errors = trackErrors(page);

  // First run: onboarding over a live app, with the host bridge injected.
  // The preload used to be missing from dist (tsc copies no .cjs), so the
  // bridge never existed in a shipped build and the IDE could not mount.
  await expect(page.locator('#transcript')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => 'gearvane' in globalThis))
    .toBe(true);
  await expect(page.locator('#appearance-dialog')).toBeVisible();
  await expect(page.locator('#appearance-title')).toHaveText('Make GearVane yours');
  await page.locator('#appearance-cancel').click();

  // Give the IDE a workspace: with none stored, the IDE button opens a
  // native folder dialog - correct product behaviour, but no web
  // automation can drive a native dialog, so the root is seeded instead.
  const workspace = join(HERE, 'fixture-workspace');
  await page.evaluate((root) => localStorage.setItem('gearvane.ide.root', root), workspace);

  // The IDE toggle exists only where all three bridges do - inside the
  // desktop app that is exactly where it must exist.
  await expect(page.locator('#ide-toggle')).toBeVisible();
  await page.locator('#ide-toggle').click();
  await expect(page.locator('#ide-root')).toBeVisible({ timeout: 15_000 });

  // Monaco is the app's heaviest dependency and the one minification and
  // bundling are most likely to break. The tree proves the ideFs bridge
  // round-tripped the fixture workspace from the main process.
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('hello.txt').first()).toBeVisible();
  await expect(page.locator('#ide-chat-toggle')).toBeVisible();

  // Back to chat: the view swap must not leak listeners or throw.
  await page.locator('#ide-chat-toggle').click();
  await expect(page.locator('#transcript')).toBeVisible();

  expect(errors).toEqual([]);
});

test('models dialog reports on-disk weights as ready', async () => {
  // Hermetic by construction: a seeded models dir is pointed at through
  // GEARVANE_MODEL_DIR, so this passes with an empty resources/models
  // (as in CI) as well as with real weights on a developer machine. The
  // file carries a catalog name, which is what flips its row to ready.
  const modelsDir = await mkdtemp(join(tmpdir(), 'gearvane-models-'));
  await writeFile(join(modelsDir, 'qwen2.5-coder-0.5b-instruct-q4_0.gguf'), 'fake-bytes');

  await app?.close();
  const userData = await mkdtemp(join(tmpdir(), 'gearvane-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env['GEARVANE_MODEL_DIR'] = modelsDir;
  app = await electron.launch({
    args: [
      MAIN,
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userData}`,
    ],
    env,
  });

  const page = await app!.firstWindow();
  const errors = trackErrors(page);

  await expect(page.locator('#transcript')).toBeVisible();
  await page.locator('#appearance-cancel').click();

  await page.locator('#models-button').click();
  await expect(page.locator('#models-dialog')).toBeVisible();
  // Twenty-two downloadable locals plus five keyless embedded mid-tier
  // weights. Frontier is absent here by design: a fresh dev launch has
  // no config file and no vault keys, so the key-gated tier is empty.
  await expect(page.locator('#models-body [data-tier="local"] .health-row')).toHaveCount(22);
  await expect(page.locator('#models-body [data-tier="mid"] .health-row')).toHaveCount(5);
  await expect(page.locator('#models-body [data-tier="frontier"]')).toHaveCount(0);
  await expect(page.locator('#models-body')).toContainText('no key needed');
  const body = await page.locator('#models-body').textContent();
  expect(body).toContain('ready');

  expect(errors).toEqual([]);
});
