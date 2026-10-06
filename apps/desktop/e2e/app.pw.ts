import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

import { defaultConfig } from '../../../packages/core/src/defaults.js';

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

/**
 * Expected row counts derived from the catalog and the default config,
 * so adding a model updates the catalog, the tiers, and these checks
 * together instead of failing on a stale literal (the counts are pinned
 * exactly in unit tests; here they only size the waits).
 */
async function expectedCounts(): Promise<{ local: number; mid: number; picker: number; frontier: number }> {
  const catalog = JSON.parse(
    await readFile(join(HERE, '..', 'src', 'models.json'), 'utf8'),
  ) as Array<unknown>;
  const config = defaultConfig();
  const embedded = (tier: 'mid' | 'frontier'): number =>
    config.tiers[tier].providers.find((provider) => provider.name === 'embedded')?.models.length ?? 0;
  // Fresh profile, no keys: the picker lists Auto plus the catalog, and
  // the dialog lists the catalog plus the keyless embedded tier rows.
  return {
    local: catalog.length,
    mid: embedded('mid'),
    frontier: embedded('frontier'),
    picker: 1 + catalog.length,
  };
}

let app: ElectronApplication | null = null;

/** Whether a path exists, without throwing. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

  // With every host bridge present the capability banner has nothing to warn
  // about, so it stays hidden. A banner that appeared here would be claiming a
  // limitation on the platform where nothing is missing - and it would push
  // the topbar down on every desktop screen.
  await expect(page.locator('#capability-banner')).toBeHidden();

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
  // Counts derive from the catalog and the default tiers above: the
  // local section lists every catalog entry, mid and frontier list the
  // keyless embedded rows a keyless profile can route to.
  const counts = await expectedCounts();
  await expect(page.locator('#models-body [data-tier="local"] .health-row')).toHaveCount(counts.local);
  await expect(page.locator('#models-body [data-tier="mid"] .health-row')).toHaveCount(counts.mid);
  await expect(page.locator('#models-body [data-tier="frontier"] .health-row')).toHaveCount(counts.frontier);
  await expect(page.locator('#models-body')).toContainText('no key needed');
  const body = await page.locator('#models-body').textContent();
  expect(body).toContain('ready');

  expect(errors).toEqual([]);
});

test('the key vault never stores a key in the clear', async () => {
  // This is the assertion the whole feature exists for: after saving a key,
  // the key must not be readable anywhere on disk. The old localStorage vault
  // wrote it in the clear, where any process reading the profile recovered it.
  //
  // Both branches assert the same invariant. Where the platform has a secret
  // store — Windows, macOS, a Linux session with a keyring — the file exists
  // and must be ciphertext. Where it has none, as on CI, nothing is written
  // at all, which satisfies the invariant more strongly. What must never
  // happen is the key appearing in the clear, so that case is a failure in
  // both branches.
  await app?.close();
  const userData = await mkdtemp(join(tmpdir(), 'gearvane-e2e-'));
  app = await electron.launch({
    args: [MAIN, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
  });

  const page = await app!.firstWindow();
  const errors = trackErrors(page);

  await expect(page.locator('#transcript')).toBeVisible();
  await page.locator('#appearance-cancel').click();

  await page.locator('#keys-button').click();
  await page.locator('#keys-fields input[aria-label="OpenAI API key"]').fill('sk-vault-e2e-secret');
  await page.locator('#keys-save').click();
  await expect(page.locator('#keys-dialog')).toBeHidden();

  // The renderer keeps no copy: its storage is a session mirror, not a vault.
  expect(await page.evaluate(() => localStorage.getItem('gearvane.keys'))).toBeNull();

  const vaultPath = join(userData, 'keys.vault');
  const persisted = await exists(vaultPath);
  if (persisted) {
    // Encrypted: the key and even the variable name are absent from the file.
    const vault = await readFile(vaultPath);
    expect(vault.includes(Buffer.from('sk-vault-e2e-secret'))).toBe(false);
    expect(vault.includes(Buffer.from('OPENAI_API_KEY'))).toBe(false);
  } else {
    // No secret store on this machine: the UI must have said so rather than
    // quietly falling back to plaintext.
    await page.locator('#keys-button').click();
    await expect(page.locator('#keys-note')).toContainText('not written to disk');
    await page.locator('#keys-cancel').click();
  }

  // Either way the key survives the turn: it still reaches the provider call.
  await page.locator('#keys-button').click();
  await expect(page.locator('#keys-fields input[aria-label="OpenAI API key"]')).toHaveValue(
    'sk-vault-e2e-secret',
  );

  // Clearing forgets it, and leaves no file behind.
  await page.locator('#keys-clear').click();
  await expect(page.locator('#keys-fields input[aria-label="OpenAI API key"]')).toHaveValue('');
  expect(await exists(vaultPath)).toBe(false);

  expect(errors).toEqual([]);
});

test('chat model picker lists models, marks installed, and pins a choice', async () => {
  // A seeded models dir gives one weight the green installed marker.
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
    args: [MAIN, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
    env,
  });

  const page = await app!.firstWindow();
  const errors = trackErrors(page);

  await expect(page.locator('#transcript')).toBeVisible();
  await page.locator('#appearance-cancel').click();

  // The header picker opens on Auto with the catalog listed.
  const button = page.locator('#model-picker-host .model-picker-button');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Auto');
  await button.click();
  const panel = page.locator('#model-picker-host .model-picker-panel');
  await expect(panel).toBeVisible();
  // Auto plus every catalog entry (derived above, not a literal).
  await expect(panel.locator('.model-picker-row')).toHaveCount((await expectedCounts()).picker);

  // The seeded weight carries the green installed marker.
  const seeded = panel.locator(
    '.model-picker-row[data-model-id="qwen2.5-coder-0.5b-instruct-q4_0"]',
  );
  await expect(seeded.locator('.model-dot.present')).toHaveCount(1);

  // Choosing it pins the run; the button label and storage follow.
  await seeded.click();
  await expect(button).toHaveText('qwen2.5-coder-0.5b-instruct-q4_0');
  expect(await page.evaluate(() => localStorage.getItem('gearvane.modelPin'))).toBe(
    'qwen2.5-coder-0.5b-instruct-q4_0',
  );

  expect(errors).toEqual([]);
});
