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
  await expect(page.locator('#appearance-title')).toHaveText('Make Waypoint yours');

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
    await page.evaluate(() => localStorage.getItem('waypoint.appearance')),
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
        (await page.evaluate(() => localStorage.getItem('waypoint.appearance'))) ?? '',
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
