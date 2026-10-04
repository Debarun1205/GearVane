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
// The bundled set: a tiny coder for the local tier's job, plus a general
// chat companion. ~670MB together; the installer carries both.
const MODELS = [
  {
    file: 'qwen2.5-coder-0.5b-instruct-q4_0.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_0.gguf',
  },
  {
    file: 'SmolLM2-360M-Instruct.Q4_K_M.gguf',
    url: 'https://huggingface.co/QuantFactory/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct.Q4_K_M.gguf',
  },
];

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
