import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Behavioural smoke tests for the built renderer.
 *
 * The vitest suite in this package runs in the node environment, so it can
 * only pin structure - which is how a renderer that threw on load shipped in
 * v0.3.0 with every unit test green. These tests execute the shipped bundle
 * in Chromium and assert what structure cannot: it boots, it stays free of
 * page and console errors, and the appearance dialogs behave.
 *
 * Every test starts from a fresh context, so first-run onboarding is visible
 * to the tests that want it and dismissed by the tests that do not.
 */

/** Failures a human would notice: uncaught exceptions and console.error. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

const bg = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());

test('boots without page or console errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // First run opens onboarding over a live app.
  await expect(page.locator('#appearance-dialog')).toBeVisible();
  await expect(page.locator('#appearance-title')).toHaveText('Make GearVane yours');

  // The app behind the dialog is there, not a blank page.
  await expect(page.locator('#transcript')).toBeVisible();
  await expect(page.locator('#send')).toBeVisible();

  // Dismiss onboarding, then exercise the control the renderer once asked
  // for by a name the markup never had: byId throws on a missing element,
  // and that is precisely the crash that shipped in v0.3.0.
  await page.locator('#appearance-cancel').click();
  await expect(page.locator('#appearance-dialog')).toBeHidden();
  await page.locator('#clear-button').click();

  expect(errors).toEqual([]);
});

test('onboarding previews live, saves once, and never returns', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  const dialog = page.locator('#appearance-dialog');
  await expect(dialog).toBeVisible();

  // The wizard opens on the welcome step; the theme groups live on
  // the second step.
  await page.locator('#appearance-next').click();

  // Every option group is built.
  await expect(page.locator('#appearance-themes .appearance-option')).toHaveCount(5);
  await expect(page.locator('#appearance-backgrounds .appearance-option')).toHaveCount(4);
  await expect(page.locator('#appearance-accents .appearance-accent')).toHaveCount(6);
  await expect(page.locator('#appearance-motion .appearance-option')).toHaveCount(2);

  const before = await bg(page);

  // Selecting a theme previews immediately, without saving anything yet.
  await page.locator('#appearance-themes .appearance-option', { hasText: 'Nebula' }).click();
  await expect.poll(() => bg(page)).not.toBe(before);
  const previewed = await bg(page);
  expect(
    await page.evaluate(() => localStorage.getItem('gearvane.appearance')),
  ).toBeNull();

  // Advance to the environment step.
  await page.locator('#appearance-next').click();

  // On to the hardware scan, which measures the machine rather than reading the
  // catalog's RAM prose. The webview has no host bridge, so it must say it
  // cannot measure - not show zeros that read as "this machine has no memory".
  await page.locator('#appearance-next').click();
  const scan = page.locator('.onboarding-hardware');
  await expect(scan).toBeVisible();
  await expect(scan).toContainText(/cannot read memory or disk|could not read/i);
  // A fit claim of "all clear" from an unmeasurable host is exactly the bug.
  await expect(scan).not.toContainText(/\d+\s*of\s*\d+\s*weights fit/i);

  await page.locator('#appearance-save').click();
  await expect(dialog).toBeHidden();
  expect(await bg(page)).toBe(previewed);
  // Persisting happens in the dialog's close handler, which runs in a task
  // after the dialog is already hidden. Reading storage immediately races
  // that task, and the macOS CI runner lost the race; poll for the effect.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => localStorage.getItem('gearvane.appearance'))) ?? '',
    )
    .toContain('nebula');

  // Reload: the look survived and onboarding does not run a second time.
  await page.reload();
  await expect(dialog).toBeHidden();
  expect(await bg(page)).toBe(previewed);

  expect(errors).toEqual([]);
});

test('settings mode reopens and cancel reverts the live preview', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  const saved = await bg(page);

  // The Look button opens the same dialog as settings.
  await page.locator('#appearance-toggle').click();
  const dialog = page.locator('#appearance-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#appearance-title')).toHaveText('Appearance');
  await expect(page.locator('#appearance-cancel')).toBeVisible();

  await page.locator('#appearance-themes .appearance-option', { hasText: 'Ember' }).click();
  await expect.poll(() => bg(page)).not.toBe(saved);

  // Cancel and Escape must both revert: nothing was persisted.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // The revert runs in the close handler, a task after hidden; poll for it
  // rather than racing it (the macOS runner lost that race once).
  await expect.poll(() => bg(page)).toBe(saved);

  expect(errors).toEqual([]);
});

test('keys dialog stores keys on this device', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  await expect(page.locator('#keys-button')).toBeVisible();
  await page.locator('#keys-button').click();
  const dialog = page.locator('#keys-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#keys-fields input[type="password"]')).toHaveCount(11);

  // Save persists the vault; the dialog closes on submit.
  await page.locator('#keys-fields input[aria-label="OpenAI API key"]').fill('sk-test');
  await page.locator('#keys-save').click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('gearvane.keys'))).toContain('sk-test');

  // Reopen and clear: nothing survives.
  await page.locator('#keys-button').click();
  await expect(dialog).toBeVisible();
  await page.locator('#keys-clear').click();
  expect(await page.evaluate(() => localStorage.getItem('gearvane.keys'))).toBeNull();

  expect(errors).toEqual([]);
});

test('ide mounts the device-local workspace without host bridges', async ({ page }) => {
  // The static server injects no window.gearvane, exactly like the Android
  // webview: the IDE button must be visible, and opening it mounts the
  // editor over the seeded workspace rather than an error.
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  // The capability banner states what this host cannot do. Without it a
  // Build-mode refusal and a missing terminal both read as bugs rather than as
  // a webview's limits, because everything visible works.
  const banner = page.locator('#capability-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Chat, routing, the editor, and search all work here');
  // The terminal claim, specifically: a webview has no shell.
  await expect(banner).toContainText('Terminal');
  // And Build mode, the other Android limitation the site documents.
  await expect(banner).toContainText('Build mode');
  // It must not claim the thing that does work is missing.
  await expect(banner).not.toContainText(/Not available:[^.]*\bChat\b/);

  await expect(page.locator('#ide-toggle')).toBeVisible();
  await page.locator('#ide-toggle').click();
  await expect(page.locator('#ide-root')).toBeVisible();
  await expect(page.locator('#ide')).toContainText('README.md');

  // The workspace persists: reload reopens the IDE where it left off.
  await page.reload();
  await expect(page.locator('#ide-root')).toBeVisible();

  expect(errors).toEqual([]);
});

test('dashboard shell: sidebar, effort, and approval revise', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  // Eigent-style shell: nav, sessions, activity, skills, connectors.
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#nav-workspace')).toBeVisible();
  await expect(page.locator('#session-new')).toBeVisible();
  await expect(page.locator('#sessions-list')).toContainText('New chat');
  await expect(page.locator('#activity-list')).toContainText('No runs yet.');
  await expect(page.locator('#skills-list')).toContainText('run_command');
  await expect(page.locator('#connectors-list')).toContainText('No servers yet.');
  await expect(page.locator('#space-select')).toContainText('Untitled Space');

  // Thinking effort persists across reloads. Onboarding does not return
  // (the flag survives reload in the same context), so no dismiss needed.
  await page.locator('#effort-select').selectOption('high');
  await expect(page.locator('#run-readout')).toContainText('High');
  await page.reload();
  await expect(page.locator('#appearance-dialog')).toBeHidden();
  await expect(page.locator('#effort-select')).toHaveValue('high');

  // Ask-me-first intercepts a destructive prompt; Revise keeps the draft
  // and sends nothing, so this needs no model and no network. Typed
  // keystroke by keystroke so the composer draft follows along.
  await page.locator('#input').pressSequentially('git push origin main');
  await page.locator('#send').click();
  await expect(page.locator('#approval-dialog')).toBeVisible();
  await page.locator('#approval-revise').click();
  await expect(page.locator('#approval-dialog')).toBeHidden();
  await expect(page.locator('#input')).toHaveValue('git push origin main');
  await expect(page.locator('#transcript .message')).toHaveCount(0);

  // The gate is keyboard-operable, and the default key does not run anything.
  // autofocus puts the safe choice under the caret; Enter then declines, so
  // both halves are asserted separately rather than one assertion hiding
  // which of them moved.
  await page.locator('#send').click();
  await expect(page.locator('#approval-dialog')).toBeVisible();
  await expect(page.locator('#approval-revise')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#approval-dialog')).toBeHidden();
  await expect(page.locator('#input')).toHaveValue('git push origin main');
  await expect(page.locator('#transcript .message')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('switching models shows a context-carried notice', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  // Pick a specific model in the header picker.
  await page.locator('#model-picker-host').click();
  const row = page.locator('.model-picker-row', { hasText: 'qwen2.5-7b-instruct-q4_k_m' }).first();
  await row.click();

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Switched to qwen2.5-7b-instruct-q4_k_m');
  await expect(toast).toContainText('Context carried over');

  expect(errors).toEqual([]);
});

test('models dialog lists the catalog without host bridges', async ({ page }) => {
  // No bridge, so no downloads: the catalog rows still render from
  // the bundled list, with the note saying where fetching works.
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  await page.locator('#models-button').click();
  const dialog = page.locator('#models-dialog');
  await expect(dialog).toBeVisible();
  // The local section lists every catalog entry; the count derives from
  // the catalog so it cannot go stale. Hosted groups are absent here by
  // design: the static server answers an empty config, so mid and
  // frontier have no providers at all. Their grouping is pinned in unit
  // tests and the Electron spec, which run against real configs.
  const catalog = JSON.parse(
    await readFile(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'models.json'),
      'utf8',
    ),
  ) as Array<unknown>;
  await expect(page.locator('#models-body [data-tier="local"] .health-row')).toHaveCount(catalog.length);
  await expect(page.locator('#models-body [data-tier="mid"]')).toHaveCount(0);
  await expect(page.locator('#models-body [data-tier="frontier"]')).toHaveCount(0);
  await expect(page.locator('#models-body')).toContainText('desktop app');
  await expect(page.locator('#models-body')).toContainText('qwen2.5-coder-0.5b-instruct-q4_0');

  expect(errors).toEqual([]);
});
