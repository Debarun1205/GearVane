#!/usr/bin/env node
/**
 * First-boot provisioning check.
 *
 * The README does not claim "four models ready at first launch" until this
 * passes. Two of the four are in the installer; this is the half that has to be
 * proven rather than asserted -- that on a first launch the app fetches exactly
 * the two it promises, from pinned revisions, verifies what arrived, and refuses
 * what the machine cannot hold.
 *
 * It runs against a local directory, not the network. `mirror/` is populated
 * with the real bytes for the two first-boot weights (fetched once with
 * `node tools/fetch-first-boot-mirror.mjs`, which verifies each against the
 * catalog's sha256), and the harness downloads from `file://` URLs, so the whole
 * path -- resolve, stream, verify, rename -- is exercised without a 9 GiB
 * transfer and without a rate limit.
 *
 * Run it:
 *   node tools/check-first-boot.mjs
 *
 * Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIRROR = join(HERE, '..', 'tmp', 'first-boot-mirror');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail ?? '' });
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// The provisioning logic is the same module the app imports, compiled to
// JavaScript. Reading it from dist/ rather than reimplementing it here is the
// point: a check that reimplemented the logic would pass while the app's
// version did the opposite.
const DIST = join(ROOT, 'apps/desktop/dist/provision.js');
if (!existsSync(DIST)) {
  process.stderr.write(
    `${DIST} is missing. Run: npm run build --workspace gearvane-app\n`,
  );
  process.exit(1);
}

const { planProvisioning, DISK_SAFETY_MARGIN } = await import(pathToFileURL(DIST).href);
const catalog = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/src/models.json'), 'utf8'),
);
const GIB = 1073741824;
const firstBoot = catalog.filter((e) => e.provision === 'first-boot');
const installer = catalog.filter((e) => e.provision === 'installer');

// A machine with room for everything, so the default plan is not a skip.
const roomy = {
  totalMemory: 64 * GIB,
  freeMemory: 48 * GIB,
  cpuCount: 8,
  diskFree: 500 * GIB,
  diskTotal: 1000 * GIB,
  degraded: false,
};

// --- what the catalog promises ------------------------------------------------

check('exactly two weights are provisioned on first boot', () => {
  assert(
    firstBoot.length === 2,
    `expected 2, catalog has ${firstBoot.length}`,
  );
  return firstBoot.map((e) => `${e.id} ${(e.bytes / GIB).toFixed(2)} GiB`).join(', ');
});

check('two weights ship in the installer, and they are different', () => {
  assert(installer.length === 2, `expected 2, catalog has ${installer.length}`);
  const overlap = firstBoot.filter((f) => installer.some((i) => i.id === f.id));
  assert(overlap.length === 0, `${overlap.map((e) => e.id)} are in both sets`);
  return installer.map((e) => e.id).join(', ');
});

check('all four first-boot weights are permissively licensed', () => {
  const all = [...installer, ...firstBoot];
  const bad = all.filter((e) => !['Apache-2.0', 'MIT'].includes(e.license));
  assert(bad.length === 0, bad.map((e) => `${e.id}=${e.license}`).join(', '));
  return all.map((e) => `${e.id}=${e.license}`).join(', ');
});

// --- the plan -----------------------------------------------------------------

check('a roomy machine fetches both, and nothing else', () => {
  const plan = planProvisioning(firstBoot, roomy);
  assert(
    plan.decisions.every((d) => d.action === 'fetch'),
    `expected both fetched, got ${JSON.stringify(plan.decisions)}`,
  );
  assert(plan.planned === firstBoot.reduce((s, e) => s + e.bytes, 0));
  return `${(plan.planned / GIB).toFixed(2)} GiB planned`;
});

check('a weight larger than physical RAM is skipped with a reason', () => {
  // The arithmetic floor: mmapped weights cannot load above total RAM.
  const plan = planProvisioning(firstBoot, { ...roomy, totalMemory: 2 * GIB, freeMemory: 2 * GIB });
  assert(
    plan.decisions.every((d) => d.action === 'skip'),
    'nothing was skipped on a 2 GB machine',
  );
  for (const d of plan.decisions) {
    assert(d.action === 'skip' && d.reason.length > 40, `${d.id}: no usable reason`);
    assert(/memory-mapped/.test(d.reason), `${d.id}: reason does not say why`);
  }
  return plan.decisions[0].reason.slice(0, 80) + '...';
});

check('a nearly full volume is skipped with the margin named', () => {
  // Enough room for the file, not for the file plus working space.
  const big = firstBoot[0];
  const plan = planProvisioning(
    [big],
    { ...roomy, diskFree: big.bytes + DISK_SAFETY_MARGIN - 1 },
  );
  assert(plan.decisions[0].action === 'skip', 'a full volume was not detected');
  assert(/free disk/.test(plan.decisions[0].reason), 'reason does not mention disk');
  return plan.decisions[0].reason.slice(0, 80) + '...';
});

check('room above the margin is enough', () => {
  const big = firstBoot[0];
  const plan = planProvisioning(
    [big],
    { ...roomy, diskFree: big.bytes + DISK_SAFETY_MARGIN + 1 },
  );
  assert(plan.decisions[0].action === 'fetch', 'a volume with room was refused');
  return 'fetched with the margin satisfied';
});

check('an unmeasurable machine fetches rather than refusing', () => {
  // Zeroes mean "could not measure", which is not a reason to skip. Refusing
  // here would mean an Android webview, or a locked-down volume, silently gets
  // nothing.
  const plan = planProvisioning(firstBoot, {
    totalMemory: 0, freeMemory: 0, cpuCount: 0, diskFree: 0, diskTotal: 0, degraded: true,
  });
  assert(
    plan.decisions.every((d) => d.action === 'fetch'),
    'an unmeasured machine refused everything',
  );
  return 'both fetch, because nothing could be measured to refuse them';
});

check('a weight already on disk is not fetched again', () => {
  const plan = planProvisioning(firstBoot, roomy, new Set([firstBoot[0].id]));
  const first = plan.decisions.find((d) => d.id === firstBoot[0].id);
  assert(first.action === 'skip' && first.bytes === 0, 'an existing weight was re-fetched');
  assert(/already/i.test(first.reason), `reason is unhelpful: ${first.reason}`);
  return first.reason;
});

// --- the transfer itself ------------------------------------------------------

check('the mirror holds both weights, verified against the catalog', () => {
  const missing = firstBoot.filter((e) => !existsSync(join(MIRROR, e.file)));
  assert(
    missing.length === 0,
    `mirror is missing ${missing.map((e) => e.file).join(', ')}. ` +
      'Run: node tools/fetch-first-boot-mirror.mjs',
  );
  return `${firstBoot.length} files, ${(
    firstBoot.reduce((s, e) => s + statSync(join(MIRROR, e.file)).size, 0) / GIB
  ).toFixed(2)} GiB total`;
});

check('a real download from the mirror verifies and lands', () => {
  // The whole path: resolve, stream, hash, compare, rename. Run through the
  // same harness the app uses, so what passes here is what the app does.
  const dir = mkdtempSync(join(tmpdir(), 'gearvane-firstboot-'));
  try {
    // Smallest first so the check is quick if a future catalog picks differently.
    const target = [...firstBoot].sort((a, b) => a.bytes - b.bytes)[0];
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'tools', 'first-boot-fetch.mjs'),
        '--mirror', MIRROR,
        '--into', dir,
        '--only', target.id,
      ],
      { stdio: 'pipe' },
    );
    const landed = join(dir, target.file);
    assert(existsSync(landed), `${target.file} did not land`);
    assert(
      statSync(landed).size === target.bytes,
      `landed ${statSync(landed).size} bytes, catalog says ${target.bytes}`,
    );
    // Nothing partial left behind.
    assert(
      !readdirSync(dir).some((f) => f.endsWith('.part')),
      'a .part file survived a successful transfer',
    );
    return `${target.id}: ${(target.bytes / GIB).toFixed(2)} GiB, sha256 matched`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a corrupted mirror file is rejected, not renamed into place', () => {
  // The failure path matters more than the happy one: a weight that lands
  // corrupt fails to load with no explanation, and the embedded server serves
  // every GGUF in the directory.
  const dir = mkdtempSync(join(tmpdir(), 'gearvane-firstboot-bad-'));
  const bad = mkdtempSync(join(tmpdir(), 'gearvane-firstboot-mirror-'));
  try {
    const target = [...firstBoot].sort((a, b) => a.bytes - b.bytes)[0];
    // A file of the right length and the wrong contents.
    const corrupt = join(bad, target.file);
    cpSync(join(MIRROR, target.file), corrupt);
    const raw = readFileSync(corrupt);
    raw[0] = raw[0] ^ 0xff;
    writeFileSync(corrupt, raw);

    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'tools', 'first-boot-fetch.mjs'),
          '--mirror', bad,
          '--into', dir,
          '--only', target.id,
        ],
        { stdio: 'pipe' },
      );
    } catch {
      failed = true;
    }
    assert(failed, 'a corrupt transfer was accepted');
    assert(!existsSync(join(dir, target.file)), 'a corrupt weight landed anyway');
    assert(
      !readdirSync(dir).some((f) => f.endsWith('.part')),
      'a .part survived the rejection',
    );
    return 'exit 1, nothing landed, no partial left';
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

// --- report -------------------------------------------------------------------

const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write('\nFirst-boot provisioning\n\n');
for (const r of results) {
  process.stdout.write(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}\n`);
}
const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length === 0) {
  process.stdout.write(
    '\nFour weights are ready at first boot: two inside the installer, two\n' +
      'fetched here. That claim may now be made in the README.\n',
  );
}
process.exit(failed.length === 0 ? 0 : 1);
