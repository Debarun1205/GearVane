#!/usr/bin/env node
/**
 * Fetch the bundled local models for the desktop installers.
 *
 * The set comes from src/models.json (entries flagged bundled), so the
 * script, the Models dialog, and the installer payload can never drift
 * apart. The GGUFs are deliberately not committed to git: release builds
 * and local `dist` runs download them once into resources/models, and
 * electron-builder's extraResources carries them into the installer. The
 * app itself never downloads; without these files the embedded tier
 * reports unavailable.
 *
 * Usage: npm run models:fetch [-- --force]
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, '..', 'resources', 'models');

const catalog = JSON.parse(readFileSync(join(HERE, '..', 'src', 'models.json'), 'utf8'));
const MODELS = catalog.filter((entry) => entry.bundled === true);
if (MODELS.length === 0) throw new Error('models.json flags no bundled models');

const force = process.argv.includes('--force');

async function fetchOne({ file, url }) {
  const target = join(MODELS_DIR, file);
  if (existsSync(target) && !force) {
    const bytes = statSync(target).size;
    console.log(`model present: ${file} (${(bytes / 1048576).toFixed(0)} MB)`);
    return;
  }

  mkdirSync(MODELS_DIR, { recursive: true });
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  let done = 0;
  const started = Date.now();
  await finished(
    Readable.fromWeb(response.body)
      .on('data', (chunk) => {
        done += chunk.length;
        if (total > 0 && done % (32 * 1048576) < chunk.length) {
          const pct = ((done / total) * 100).toFixed(0);
          process.stdout.write(
            `\r${file} ${pct}% (${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB)`,
          );
        }
      })
      .pipe(createWriteStream(target)),
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nsaved ${target} (${(done / 1048576).toFixed(0)} MB in ${seconds}s)`);
}

for (const model of MODELS) {
  await fetchOne(model);
}
