import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Smoke test for a PACKAGED build, run by the release workflow.
 *
 * Every other end-to-end test launches dist/main.js from source, where the
 * models directory, node_modules and the native binaries all sit exactly where
 * the code expects. A packaged app is a different program: resources live in an
 * archive, the native inference binary has to be outside it, and the bundled
 * weights are copied by electron-builder rather than found in the tree. All of
 * the failures that matter for a download (a `models` file where a directory
 * should be, a missing workspace package, a native binary packed into the
 * archive) are invisible from source and fatal when installed.
 *
 *   GEARVANE_PACKAGED_EXE=/path/to/GearVane  npx playwright test e2e/packaged.pw.ts
 *
 * Skipped when the variable is not set, so the ordinary e2e run ignores it.
 */

const EXE = process.env['GEARVANE_PACKAGED_EXE'];

test.skip(!EXE, 'GEARVANE_PACKAGED_EXE is not set; this runs against a packaged build');

test('the packaged app starts, finds its bundled weights, and answers a prompt', async () => {
  // Loading a model from cold on a CI runner is slow; the first token can take
  // a while even for a 0.5B weight.
  test.setTimeout(300_000);

  const userData = await mkdtemp(join(tmpdir(), 'gearvane-packaged-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // The installed app downloads 9 GiB on first launch. A smoke test must not.
  env['GEARVANE_PROVISION'] = '0';

  const app = await electron.launch({
    executablePath: EXE as string,
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
    env,
  });

  try {
    // 1. It really is the packaged app, not a source checkout.
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);

    // 2. The renderer booted, which means the main bundle, the preload and the
    //    workspace packages all resolved.
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('#transcript')).toBeVisible({ timeout: 60_000 });

    // 3. The installer's weights are a directory of real files.
    const resources = await app.evaluate(() => process.resourcesPath);
    const modelsDir = join(resources, 'models');
    expect((await stat(modelsDir)).isDirectory()).toBe(true);
    const shipped = (await readdir(modelsDir)).filter((name) => name.endsWith('.gguf'));
    expect(shipped.length).toBeGreaterThanOrEqual(2);

    // 4. The app counts them as installed, so the picker's green dots are true.
    const listed = await page.evaluate(() =>
      (
        window as unknown as { gearvane: { models?: { list(): Promise<unknown> } } }
      ).gearvane.models?.list(),
    );
    if (Array.isArray(listed)) {
      const present = (listed as Array<{ file: string; present: boolean }>).filter(
        (entry) => entry.present,
      );
      expect(present.length).toBeGreaterThanOrEqual(2);
    }

    // 5. The embedded model runtime started and serves the shipped weights.
    const config = await page.evaluate(() =>
      (
        window as unknown as { gearvane: { readConfig(): Promise<unknown> } }
      ).gearvane.readConfig(),
    );
    const tiers = (config as { tiers: Record<string, { providers: Array<Record<string, string>> }> })
      .tiers;
    const embedded = Object.values(tiers)
      .flatMap((tier) => tier.providers)
      .find((provider) => provider['name'] === 'embedded');
    expect(embedded?.['baseUrl']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const headers = {
      Authorization: `Bearer ${embedded?.['apiKey']}`,
      'Content-Type': 'application/json',
    };
    const modelsResponse = await fetch(`${embedded?.['baseUrl']}/v1/models`, { headers });
    expect(modelsResponse.status).toBe(200);
    const ids = ((await modelsResponse.json()) as { data: Array<{ id: string }> }).data.map(
      (model) => model.id,
    );
    expect(ids.length).toBeGreaterThanOrEqual(2);

    // 6. A real prompt gets a real answer. This is the check that proves the
    //    native binary loaded from outside the archive and the weight is usable.
    const small = ids.find((id) => /smollm2/i.test(id)) ?? (ids[0] as string);
    const reply = await fetch(`${embedded?.['baseUrl']}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: small,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 16,
        stream: false,
      }),
    });
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content.trim().length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
