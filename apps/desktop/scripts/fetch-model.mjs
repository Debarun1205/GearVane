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
 * Usage: npm run models:fetch [-- --force] [--first-run] [--verify]
 *
 * --first-run  Download only models NOT shipped in the installer (for first launch)
 * --verify     Verify SHA256 checksums after download
 * --force      Re-download even if file exists
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, '..', 'resources', 'models');

const catalog = JSON.parse(readFileSync(join(HERE, '..', 'src', 'models.json'), 'utf8'));
const BUNDLED = catalog.filter((entry) => entry.bundled === true);
if (BUNDLED.length === 0) throw new Error('models.json flags no bundled models');

// Determine which models to fetch based on mode
const firstRun = process.argv.includes('--first-run');
const MODELS = firstRun
  ? catalog.filter((entry) => entry.bundled !== true)  // Download everything NOT in installer
  : catalog.filter((entry) => entry.bundled === true);  // Download only bundled (for installer build)

if (MODELS.length === 0) {
  if (firstRun) console.log('First-run: all non-bundled models already present');
  else throw new Error('models.json flags no bundled models');
}

const force = process.argv.includes('--force');
const verify = process.argv.includes('--verify');

async function fetchOne({ file, url, bytes }) {
  const target = join(MODELS_DIR, file);
  if (existsSync(target) && !force) {
    const existingBytes = statSync(target).size;
    if (existingBytes === bytes) {
      console.log(`model present: ${file} (${(bytes / 1048576).toFixed(0)} MB)`);
      return;
    }
    console.log(`model size mismatch: ${file} (${(existingBytes / 1048576).toFixed(0)} vs ${(bytes / 1048576).toFixed(0)} MB), re-downloading`);
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

  // Verify checksum if requested
  if (verify) {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256');
    const stream = require('node:fs').createReadStream(target);
    for await (const chunk of stream) hash.update(chunk);
    const digest = hash.digest('hex');
    console.log(`sha256: ${digest}`);
  }
}

for (const model of MODELS) {
  await fetchOne({ file: model.file, url: model.url, bytes: model.bytes });
}