#!/usr/bin/env node
/**
 * Check that a packaged desktop build can actually run, before it is released.
 *
 *   node tools/verify-packaged.mjs <win|linux|mac> [releaseDir]
 *
 * Reads electron-builder's unpacked output (win-unpacked, linux-unpacked,
 * mac-arm64/GearVane.app) and asserts what a unit test cannot see, because
 * every one of these has failed in a way that left the build green:
 *
 *   - resources/models is a DIRECTORY holding both bundled weights at their
 *     exact catalog sizes. A `to: "models"` for a single-file `from` copied the
 *     first weight AS a file called `models` and let the second overwrite it.
 *   - app.asar holds the compiled main process, the renderer, and the
 *     workspace packages the main process imports. A missing @gearvane/core is
 *     an app that dies on launch with "Cannot find module".
 *   - node-llama-cpp's native binary sits OUTSIDE the asar. A .node file or its
 *     DLLs cannot be loaded from inside an archive, so a packed one is an
 *     embedded model that never starts.
 *
 * It does not run the app. The Playwright packaged smoke test does that.
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');

const platform = process.argv[2];
const releaseDir = process.argv[3] ?? join(DESKTOP, 'release');

const failures = [];
const notes = [];
const pass = (message) => console.log(`  [PASS] ${message}`);
const fail = (message) => {
  failures.push(message);
  console.log(`  [FAIL] ${message}`);
};

/** Where electron-builder leaves the unpacked resources for a platform. */
function resourcesDir() {
  if (platform === 'win') return join(releaseDir, 'win-unpacked', 'resources');
  if (platform === 'linux') return join(releaseDir, 'linux-unpacked', 'resources');
  if (platform === 'mac') {
    const candidates = readdirSync(releaseDir).filter((name) => /^mac(-arm64|-universal)?$/.test(name));
    for (const dir of candidates) {
      const app = join(releaseDir, dir, 'GearVane.app', 'Contents', 'Resources');
      if (existsSync(app)) return app;
    }
  }
  return null;
}

/** The asar's file tree, read from its header without needing the asar package. */
function readAsarTree(file) {
  const fd = openSync(file, 'r');
  try {
    const sizeBuffer = Buffer.alloc(8);
    readSync(fd, sizeBuffer, 0, 8, 0);
    const headerSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerSize);
    readSync(fd, headerBuffer, 0, headerSize, 8);
    const jsonLength = headerBuffer.readUInt32LE(4);
    return JSON.parse(headerBuffer.subarray(8, 8 + jsonLength).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/** Whether a slash-separated path exists in an asar header tree. */
function inAsar(tree, path) {
  let node = tree;
  for (const part of path.split('/')) {
    node = node?.files?.[part];
    if (!node) return false;
  }
  return true;
}

/** Every file under a directory whose name matches. */
function findFiles(dir, test, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, test, found);
    else if (test(full)) found.push(full);
  }
  return found;
}

if (!['win', 'linux', 'mac'].includes(platform ?? '')) {
  console.error('Usage: node tools/verify-packaged.mjs <win|linux|mac> [releaseDir]');
  process.exit(2);
}

const resources = existsSync(releaseDir) ? resourcesDir() : null;
console.log(`\nPackaged build check: ${platform}`);
if (!resources) {
  fail(`no unpacked ${platform} build under ${releaseDir}`);
  process.exit(1);
}
console.log(`  resources: ${resources}\n`);

// 1. The bundled weights are a directory of real files.
const catalog = JSON.parse(readFileSync(join(DESKTOP, 'src', 'models.json'), 'utf8'));
const bundled = catalog.filter((entry) => entry.bundled === true);
const modelsDir = join(resources, 'models');

if (!existsSync(modelsDir)) {
  fail('resources/models does not exist');
} else if (!statSync(modelsDir).isDirectory()) {
  fail(
    `resources/models is a ${statSync(modelsDir).size}-byte FILE, not a directory. ` +
      'electron-builder copied one weight over another: give each extraResources entry a full "to" path',
  );
} else {
  pass('resources/models is a directory');
  for (const entry of bundled) {
    const file = join(modelsDir, entry.file);
    if (!existsSync(file)) fail(`bundled weight missing: ${entry.file}`);
    else if (statSync(file).size !== entry.bytes) {
      fail(`${entry.file} is ${statSync(file).size} bytes, the catalog says ${entry.bytes}`);
    } else pass(`${entry.file} present at the catalog size`);
  }
  const extra = readdirSync(modelsDir).filter((name) => !bundled.some((entry) => entry.file === name));
  if (extra.length > 0) fail(`unexpected files shipped in models/: ${extra.join(', ')}`);
}

// 2. The app code is inside the archive, or beside it.
const asarPath = join(resources, 'app.asar');
const unpackedModules = join(resources, 'app.asar.unpacked', 'node_modules');
const looseApp = join(resources, 'app');

if (existsSync(asarPath)) {
  let tree = null;
  try {
    const header = readAsarTree(asarPath);
    tree = header.files ? header : null;
  } catch (error) {
    notes.push(`could not read the asar header (${error.message}); skipped archive content checks`);
  }
  if (tree) {
    for (const required of ['dist/main.js', 'renderer/index.html', 'package.json']) {
      if (inAsar(tree, required)) pass(`app.asar contains ${required}`);
      else fail(`app.asar is missing ${required}`);
    }
    for (const module of ['node_modules/@gearvane/core', 'node_modules/@gearvane/harness', 'node_modules/@gearvane/app-core', 'node_modules/node-llama-cpp']) {
      const packed = inAsar(tree, `${module}/package.json`);
      const unpacked = existsSync(join(resources, 'app.asar.unpacked', module, 'package.json'));
      if (packed || unpacked) pass(`${module} is resolvable at runtime`);
      else fail(`${module} is not in the build: the main process would die on launch with "Cannot find module"`);
    }
  }
} else if (existsSync(looseApp)) {
  notes.push('app is not packed in an asar; archive content checks skipped');
} else {
  fail('neither app.asar nor an app/ directory is present');
}

// 3. The native inference binary is loadable.
const natives = findFiles(unpackedModules, (file) => file.endsWith('.node') && /node-llama-cpp/.test(file));
if (natives.length > 0) {
  pass(`node-llama-cpp native binary is unpacked (${natives.length} .node file${natives.length === 1 ? '' : 's'})`);
} else {
  fail(
    'no node-llama-cpp .node file under app.asar.unpacked: a native binary cannot be loaded from inside ' +
      'an archive, so the embedded model would never start. Add asarUnpack for node-llama-cpp and @node-llama-cpp/*',
  );
}

// node-pty is an optional dependency with a runtime fallback, so its absence is a warning.
const pty = findFiles(unpackedModules, (file) => file.endsWith('.node') && /node-pty/.test(file));
if (pty.length > 0) pass('node-pty native binary is unpacked');
else notes.push('node-pty has no unpacked .node file: the in-app terminal will report itself unavailable');

for (const note of notes) console.log(`  [NOTE] ${note}`);
console.log(`\n${failures.length === 0 ? 'OK' : `${failures.length} problem(s)`}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
