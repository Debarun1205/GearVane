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

  // Save persists; the dialog closes.
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

  await expect(page.locator('#ide-toggle')).toBeVisible();
  await page.locator('#ide-toggle').click();
  await expect(page.locator('#ide-root')).toBeVisible();
  await expect(page.locator('#ide')).toContainText('README.md');

  // The workspace persists: reload reopens the IDE where it left off.
  await page.reload();
  await expect(page.locator('#ide-root')).toBeVisible();

  expect(errors).toEqual([]);
});

test('models dialog lists the catalog without host bridges', async ({ page }) => {
  // No bridge, so no downloads: the eight catalog rows still render from
  // the bundled list, with the note saying where fetching works.
  const errors = trackErrors(page);
  await page.goto('/');
  await page.locator('#appearance-cancel').click();

  await page.locator('#models-button').click();
  const dialog = page.locator('#models-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#models-body [data-tier="local"] .health-row')).toHaveCount(17);
  await expect(page.locator('#models-body')).toContainText('desktop app');
  await expect(page.locator('#models-body')).toContainText('qwen2.5-coder-0.5b-instruct-q4_0');

  expect(errors).toEqual([]);
});
