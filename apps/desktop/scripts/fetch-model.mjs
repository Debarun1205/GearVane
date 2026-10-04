#!/usr/bin/env node
/**
 * Fetch the bundled local model for the desktop installers.
 *
 * The GGUF is deliberately not committed to git (400MB+): release builds
 * and local `dist` runs download it once into resources/models, and
 * electron-builder's extraResources carries it into the installer. The app
 * itself never downloads; without this file the embedded tier simply
 * reports unavailable.
 *
 * Usage: npm run models:fetch [-- --force]
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, '..', 'resources', 'models');
const MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_0.gguf';
const MODEL_FILE = 'qwen2.5-coder-0.5b-instruct-q4_0.gguf';

const force = process.argv.includes('--force');
const target = join(MODELS_DIR, MODEL_FILE);

if (existsSync(target) && !force) {
  const bytes = statSync(target).size;
  console.log(`model present: ${target} (${(bytes / 1048576).toFixed(0)} MB)`);
  process.exit(0);
}

mkdirSync(MODELS_DIR, { recursive: true });
console.log(`downloading ${MODEL_URL}`);
const response = await fetch(MODEL_URL);
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
        process.stdout.write(`\r${pct}% (${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB)`);
      }
    })
    .pipe(createWriteStream(target)),
);
const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\nsaved ${target} (${(done / 1048576).toFixed(0)} MB in ${seconds}s)`);
