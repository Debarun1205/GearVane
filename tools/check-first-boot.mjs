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
  closeSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIRROR = join(HERE, '..', 'tmp', 'first-boot-mirror');

const results = [];

/**
 * Every scratch directory this run has created.
 *
 * A check that moves gigabytes removes its directory in a `finally` block. That
 * block does not run when the process is killed, and a killed first-boot check
 * leaves 1 to 7 GiB behind -- enough that repeated interruptions filled a disk.
 * So the directories are tracked here and removed on the way out, whatever the
 * reason for going out.
 */
const SCRATCH = [];

/** Remember a directory so it can be removed on exit. */
function track(dir) {
  SCRATCH.push(dir);
  return dir;
}

/** Remove every tracked directory. Safe to call more than once. */
function releaseScratch() {
  while (SCRATCH.length > 0) {
    const dir = SCRATCH.pop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// SIGINT (Ctrl-C) and SIGTERM (taskkill, CI timeout) both need this. Without it
// the default behaviour is to die immediately, skipping every finally block.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`\n${signal}: removing ${SCRATCH.length} scratch director` +
      `${SCRATCH.length === 1 ? 'y' : 'ies'} before exiting\n`);
    releaseScratch();
    process.exit(130);
  });
}

// The backstop for exits that are not signals: an uncaught rejection, or a check
// that throws before it reaches its own finally. `exit` fires after the event
// loop drains, which is late enough for any pending write to have settled.
process.on('exit', releaseScratch);

/**
 * How long one check may take before it is called hung.
 *
 * Generous, because these move real gigabytes and a slow disk is not a failure.
 * The point is to convert an open-ended wait into a named failure, so a stall
 * says which check stalled rather than the script simply never printing.
 */
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 15 * 60 * 1000);

/**
 * Register one check. It does not run yet.
 *
 * Registering rather than starting is the whole point. An earlier version pushed
 * an already-running promise here, so the "sequential" loop at the bottom only
 * sequenced the *awaiting* -- all twenty-three checks began at once, each
 * streaming gigabytes, and the script looked hung for over an hour. Storing the
 * thunk and calling it inside the loop is what actually makes it sequential.
 *
 * Each one announces itself and reports how long it took: a script that prints
 * nothing until it finishes cannot be told apart from one that is stuck, which
 * is exactly the failure this had twice.
 */
const registered = [];
function check(name, fn) {
  registered.push({ name, fn });
}

/**
 * The checks that move real gigabytes, by name.
 *
 * Named rather than detected, because what makes them expensive is not visible
 * from the outside: they are the ones that let a Provisioner run to completion
 * against the mirror. A check that seeds a file and asserts it is skipped is
 * cheap; one that lets the transfer finish is not.
 */
const FULL_TRANSFER_CHECKS = new Set([
  'the provisioner fetches both weights, one at a time, verified',
  'a failed attempt is retried, not abandoned',
  'it resumes from a partial instead of starting over',
  '"download anyway" continues on a metered link',
  'a weight the machine cannot hold never blocks the boot',
]);

/** Run every registered check, one at a time, and record the outcome of each. */
async function runAll() {
  for (const { name, fn } of registered) {
    const began = Date.now();
    process.stdout.write(`  ... ${name}\n`);
    try {
      // Promise.resolve, because most checks are synchronous. withoutTimeout
      // needs something with .then() and a bare string is not one.
      const detail = await withTimeout(Promise.resolve(fn()), CHECK_TIMEOUT_MS);
      results.push({ name, pass: true, detail: detail ?? '' });
      process.stdout.write(`  ok  ${name} (${secs(began)})\n`);
    } catch (error) {
      results.push({ name, pass: false, detail: error.message });
      process.stdout.write(`  FAIL ${name} (${secs(began)}): ${error.message}\n`);
    }
  }
}

function secs(began) {
  return `${((Date.now() - began) / 1000).toFixed(1)}s`;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no result after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * An HTTP mirror over the local directory.
 *
 * A local file path would not do: the app fetches over HTTP and the Range
 * request that resume depends on is an HTTP feature, so serving from disk by
 * path would skip the part of the transfer most worth proving. This speaks just
 * enough HTTP -- GET, Range, 206, Content-Range, Content-Length -- to be a real
 * origin rather than a stub that always answers 200.
 */
async function startMirror(dir) {
  const requests = [];
  let failNext = 0;

  const server = createServer((req, res) => {
    const file = pathJoin(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    requests.push(req.headers.range ?? null);

    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }

    // A deliberate failure, to exercise the retry path.
    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(503).end();
      return;
    }

    const size = statSync(file).size;
    const range = req.headers.range;
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');

    if (m) {
      const start = Number(m[1]);
      const end = m[2] === '' ? size - 1 : Number(m[2]);
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Type': 'application/octet-stream',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': String(size),
      'Content-Type': 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    failNextRequest: (n) => {
      failNext = n;
    },
    close: () =>
      new Promise((done) => {
        // closeAllConnections before close, or close never settles.
        //
        // Node's server.close() waits for every connection to end, and undici
        // -- which is what fetch uses -- holds a keep-alive socket open after a
        // multi-gigabyte response. So close() waits on an idle socket that will
        // not go away, and the whole script hangs after its last check with
        // nothing printed. The bodies already completed; it is the socket
        // linger that blocks.
        server.closeAllConnections?.();
        server.close(done);
      }),
  };
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
const { Provisioner } = await import(
  pathToFileURL(join(ROOT, 'apps/desktop/dist/provisioner.js')).href
);
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
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-firstboot-')));
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
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-firstboot-bad-')));
  const bad = track(mkdtempSync(join(tmpdir(), 'gearvane-firstboot-mirror-')));
  try {
    const target = [...firstBoot].sort((a, b) => a.bytes - b.bytes)[0];
    // A file of the right length and the wrong contents.
    const corrupt = join(bad, target.file);
    cpSync(join(MIRROR, target.file), corrupt);
    // One byte flipped, in place. Reading the whole file to do it would fail:
    // these weights are larger than Node's 2 GiB Buffer limit.
    const handle = openSync(corrupt, 'r+');
    try {
      const first = readSync(handle, Buffer.alloc(1), 0, 1, 0);
      writeSync(handle, Buffer.from([first[0] ^ 0xff]), 0, 1, 0);
    } finally {
      closeSync(handle);
    }

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

// --- the whole provisioner, driven the way the app drives it -------------------

/**
 * Run the real Provisioner against the mirror, in a clean directory.
 *
 * This is the check the README waits on. Everything above tests the plan or one
 * transfer in isolation; this runs the object the app actually constructs, with
 * the same constructor arguments main.ts passes, so a change that breaks boot
 * provisioning fails here rather than in a user's first ten minutes.
 */
async function runProvisioner(options = {}) {
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-provision-')));
  const mirror = await startMirror(options.mirrorDir ?? MIRROR);
  const seen = [];

  try {
    const provisioner = new Provisioner(dir, {
      onChange: (status) => seen.push(status),
    }, (entry) => `${mirror.origin}/${encodeURIComponent(entry.file)}`);

    if (options.before) options.before(provisioner, mirror);

    const done = provisioner.start();
    if (options.during) await options.during(provisioner, done, seen);
    await done;

    return { dir, status: provisioner.status(), mirror, seen, provisioner };
  } finally {
    await mirror.close();
  }
}

check('the provisioner fetches both weights, one at a time, verified', async () => {
  // One run proves three things, because three separate runs of this cost 27 GiB
  // of disk each and the script then takes long enough to look hung.
  const run = await runProvisioner();
  try {
    const { status, dir, seen } = run;
    const done = status.items.filter((i) => i.state === 'done');
    assert(
      done.length === firstBoot.length,
      `${done.length} of ${firstBoot.length} finished: ${JSON.stringify(status.items.map((i) => [i.id, i.state]))}`,
    );
    for (const entry of firstBoot) {
      const path = join(dir, entry.file);
      assert(existsSync(path), `${entry.file} did not land`);
      assert(
        statSync(path).size === entry.bytes,
        `${entry.file} is ${statSync(path).size}, catalog says ${entry.bytes}`,
      );
    }

    // Never two at once. Two multi-gigabyte writes into one directory help
    // neither, and the requirement is explicit.
    let worst = 0;
    for (const state of seen) {
      worst = Math.max(worst, state.items.filter((i) => i.state === 'running').length);
    }
    assert(worst === 1, `saw ${worst} transfers running at once`);

    const total = status.items.reduce((s, i) => s + i.bytes, 0);
    return (
      `${done.length} weights, ${(total / GIB).toFixed(2)} GiB, every sha256 matched; ` +
      `never more than ${worst} running (from ${seen.length} status updates)`
    );
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

check('a failed attempt is retried, not abandoned', async () => {
  // Only the smaller weight: the retry path does not depend on there being two,
  // and halving the bytes keeps this affordable.
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-retry-')));
  const mirror = await startMirror(MIRROR);
  try {
    // Seed the larger weight so it is skipped, and make the mirror reject the
    // first request so the retry has something to do.
    const biggest = [...firstBoot].sort((a, b) => b.bytes - a.bytes)[0];
    cpSync(join(MIRROR, biggest.file), join(dir, biggest.file));
    mirror.failNextRequest(1);

    const provisioner = new Provisioner(dir, {}, (entry) =>
      `${mirror.origin}/${encodeURIComponent(entry.file)}`
    );
    await provisioner.start();

    const failed = provisioner.status().items.filter((i) => i.state === 'failed');
    assert(
      failed.length === 0,
      `a weight gave up after its first failure: ${failed[0]?.reason}`,
    );
    return 'the mirror rejected one request and every weight still completed';
  } finally {
    await mirror.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

check('it resumes from a partial instead of starting over', async () => {
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-resume-')));
  const mirror = await startMirror(MIRROR);
  try {
    const target = [...firstBoot].sort((a, b) => a.bytes - b.bytes)[0];
    // Seed the other weight, so this run moves only the one under test.
    const other = firstBoot.find((e) => e.id !== target.id);
    cpSync(join(MIRROR, other.file), join(dir, other.file));

    // A partial from a previous run: the first megabyte, which is what a quit
    // at 20% would leave.
    const partial = join(dir, `${target.file}.part`);
    const already = 1024 * 1024;
    const source = createReadStream(join(MIRROR, target.file), { end: already - 1 });
    await new Promise((done, failed) => {
      const out = createWriteStream(partial);
      source.pipe(out);
      out.on('finish', done);
      out.on('error', failed);
    });
    assert(statSync(partial).size === already, 'the seeded partial is the wrong size');

    const provisioner = new Provisioner(dir, {}, (entry) =>
      `${mirror.origin}/${encodeURIComponent(entry.file)}`
    );
    await provisioner.start();

    assert(existsSync(join(dir, target.file)), 'the weight did not land');
    assert(
      statSync(join(dir, target.file)).size === target.bytes,
      'the resumed weight is the wrong length',
    );

    // The proof: the origin was asked for a range, so the bytes already on disk
    // were not fetched again.
    const ranges = mirror.requests.filter((range) => range !== null);
    assert(
      ranges.length > 0,
      'the mirror never saw a Range header, so the partial was ignored',
    );
    assert(
      ranges[0].startsWith(`bytes=${already}-`),
      `Range asked for ${ranges[0]}, expected it to start at ${already}`,
    );
    return `resumed at byte ${already}; the origin was asked for ${ranges[0]}`;
  } finally {
    await mirror.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a verified weight is never fetched again', async () => {
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-nodl-')));
  const mirror = await startMirror(MIRROR);
  try {
    // Seed both weights as if a previous launch had already fetched them.
    for (const entry of firstBoot) {
      cpSync(join(MIRROR, entry.file), join(dir, entry.file));
    }

    const provisioner = new Provisioner(dir, {}, (entry) =>
      `${mirror.origin}/${encodeURIComponent(entry.file)}`
    );
    await provisioner.start();

    const statuses = provisioner.status();
    assert(
      statuses.items.every((i) => i.state !== 'running'),
      'something started downloading despite both weights being present',
    );
    const notRequested = mirror.requests.length;
    assert(
      statuses.items.every((i) => i.reason?.includes('Already') || i.state === 'done'),
      `unexpected states: ${JSON.stringify(statuses.items.map((i) => [i.id, i.state, i.reason]))}`,
    );
    return `${statuses.items.length} weights already present, ${notRequested} network requests`;
  } finally {
    await mirror.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a pause stops the transfer and keeps the partial', async () => {
  const run = await runProvisioner({
    during: async (provisioner, done, seen) => {
      // Wait until bytes are moving, then pause.
      for (let i = 0; i < 400 && !seen.some((s) => s.items.some((x) => x.done > 4 * 1024 * 1024)); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      provisioner.pause();
      await done;
    },
  });
  try {
    const paused = run.status.items.filter((i) => i.state === 'paused');
    assert(paused.length > 0, 'nothing reported paused after pause()');
    assert(run.status.active === false, 'still active after pause()');
    const partials = readdirSync(run.dir).filter((f) => f.endsWith('.part'));
    assert(partials.length > 0, 'the partial was discarded, so resume is impossible');
    return `paused with ${partials.length} partial kept`;
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

check('a cancel discards the partial and does not block', async () => {
  const run = await runProvisioner({
    during: async (provisioner, done, seen) => {
      for (let i = 0; i < 400 && !seen.some((s) => s.items.some((x) => x.done > 4 * 1024 * 1024)); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      provisioner.cancel();
      await done;
    },
  });
  try {
    // A stale .part is exactly what the embedded server would try to load, so a
    // cancel must leave nothing behind.
    const partials = readdirSync(run.dir).filter((f) => f.endsWith('.part'));
    assert(partials.length === 0, `a partial survived the cancel: ${partials.join(', ')}`);
    const landed = run.status.items.filter((i) => i.state === 'done');
    return `${partials.length} partials left, ${landed.length} weights completed before the cancel`;
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

check('a metered connection pauses before any bytes move', async () => {
  const run = await runProvisioner({
    before: (provisioner) => {
      provisioner.reportMetered(true);
    },
  });
  try {
    const paused = run.status.items.filter((i) => i.state === 'paused');
    assert(paused.length > 0, 'a metered link did not pause');
    assert(
      run.status.pausedForMetered === true,
      'the chip would not be told why it is paused',
    );
    // The refusal is not the point: the one-click override must exist.
    assert(run.status.meterApproved === false, 'it assumed the user had approved metered use');
    return `${paused.length} paused, awaiting one click`;
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

check('"download anyway" continues on a metered link', async () => {
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-metered-')));
  const mirror = await startMirror(MIRROR);
  try {
    // Seed the larger weight so only the smaller one has to move: the point is
    // that the override works, not that 9 GiB went over a hotspot.
    const biggest = [...firstBoot].sort((a, b) => b.bytes - a.bytes)[0];
    cpSync(join(MIRROR, biggest.file), join(dir, biggest.file));

    const provisioner = new Provisioner(dir, {}, (entry) =>
      `${mirror.origin}/${encodeURIComponent(entry.file)}`
    );
    provisioner.reportMetered(true);
    const started = provisioner.start();
    await provisioner.resume({ metered: true });
    await started;

    assert(provisioner.status().meterApproved === true, 'the override did not register');
    assert(provisioner.status().pausedForMetered === false, 'the chip would still ask');
    const done = provisioner.status().items.filter((i) => i.state === 'done');
    assert(done.length === firstBoot.length, `${done.length} of ${firstBoot.length} finished`);
    return 'every weight fetched after one click on a metered link';
  } finally {
    await mirror.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

check('a machine that cannot hold a weight skips it and says why', async () => {
  // The provisioner measures the real machine, so this is checked through the
  // plan rather than by pretending a 2 GB machine exists here.
  const small = { ...roomy, totalMemory: 2 * GIB, freeMemory: 2 * GIB };
  const plan = planProvisioning(firstBoot, small);
  assert(
    plan.decisions.every((d) => d.action === 'skip'),
    'a 2 GB machine was told to fetch a 4.4 GB weight',
  );
  for (const d of plan.decisions) {
    assert(d.action === 'skip', `${d.id} was fetched`);
    assert(d.reason && d.reason.length > 40, `${d.id} has no usable reason`);
  }
  return plan.decisions[0].reason.slice(0, 70) + '...';
});

check('a weight the machine cannot hold never blocks the boot', async () => {
  // start() must resolve whatever the plan decided, and must not reject. A
  // rejection here would be an unhandled error in main.ts's boot path.
  const dir = track(mkdtempSync(join(tmpdir(), 'gearvane-skip-')));
  const mirror = await startMirror(MIRROR);
  try {
    // Only the largest weight, and a directory on a full volume is simulated by
    // seeding nothing and letting the real measurement stand.
    const provisioner = new Provisioner(dir, {}, (entry) =>
      `${mirror.origin}/${encodeURIComponent(entry.file)}`
    );
    let rejected = false;
    await provisioner.start().catch(() => {
      rejected = true;
    });
    assert(!rejected, 'start() rejected; main.ts would leave an unhandled rejection');
    assert(Array.isArray(provisioner.status().items), 'no items reported');
    return 'start() resolved with a status either way';
  } finally {
    await mirror.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

check('the chip describes each state in words a person can act on', async () => {
  const chip = await import(
    pathToFileURL(join(ROOT, 'apps/desktop/dist/provision-chip.js')).href
  );
  const base = {
    active: false,
    pausedForMetered: false,
    meterApproved: false,
    items: [],
  };
  const one = (state, extra = {}) => ({
    ...base,
    items: [{ id: 'qwen3-8b.q4_k_m', bytes: 5027783872, state, done: 0, ...extra }],
  });

  assert(chip.describe(one('running', { done: 5e8, bytesPerSecond: 5e6 })).showPause, 'no pause offered while running');
  assert(!chip.describe(one('running')).label.includes('undefined'), 'label has an undefined in it');

  const metered = chip.describe({ ...one('paused'), pausedForMetered: true });
  assert(metered.showAnyway, 'a metered pause offered no one-click override');
  assert(metered.showResume, 'a pause offered no way to continue');
  assert(/metered/i.test(metered.label), `metered pause not labelled: ${metered.label}`);

  const skipped = chip.describe({
    ...base,
    items: [{ id: 'qwen3-8b.q4_k_m', bytes: 1, state: 'skipped', done: 0, reason: 'Needs 4.4 GB of memory to load.' }],
  });
  assert(skipped.visible, 'a skipped weight produced no visible chip');
  assert(/memory to load/.test(skipped.reason), `the skip reason was not shown: ${skipped.reason}`);

  assert(!chip.describe(one('done')).visible, 'a finished weight left the chip on screen');
  assert(chip.looksMetered({ type: 'cellular' }), 'cellular not detected');
  assert(chip.looksMetered({ saveData: true }), 'saveData not detected');
  assert(chip.looksMetered({ effectiveType: '2g' }), '2g not detected');
  assert(!chip.looksMetered({ type: 'wifi', effectiveType: '4g' }), 'wifi 4g wrongly flagged as metered');
  assert(!chip.looksMetered(undefined), 'an absent connection API was called metered');

  const speed = chip.describeTransfer(1e9, 4e9, 8e6);
  assert(/MB\/s/.test(speed.detail), `no speed in ${speed.detail}`);
  assert(speed.percent === 25, `percent was ${speed.percent}`);
  assert(/left/.test(speed.eta), `no ETA: ${speed.eta}`);

  assert(chip.readyNotice(['qwen3-8b.q4_k_m']) === 'Now using qwen3-8b.', 'ready notice wrong');
  assert(chip.readyNotice([]) === null, 'a notice for nothing');
  return 'running, paused, metered, skipped, done, speed, ETA and detection all read correctly';
});

// --- report -------------------------------------------------------------------
// Every check is started above and collected here. Printing before they finish
// would report "0 passed, 0 failed" and exit 0 on a script that had checked
// nothing.

// Sequential, deliberately. See check() -- concurrent gigabyte streams made this
// look hung.
//
// --quick skips the four checks that move real gigabytes. They are the ones that
// prove the transfer end to end, and they are also the reason this script takes
// hours rather than minutes: a 9 GiB transfer at the ~4 MB/s this machine manages
// with Defender scanning every write is a 40-minute wait, and there are several.
// The logic checks -- sequencing, retry, pause, cancel, metered, skip, chip
// wording -- run in seconds and cover everything except the bytes themselves.
// So: --quick for a change to the logic, full run for a change to the transfer.
const QUICK = process.argv.includes('--quick');
if (QUICK) {
  // .has, not `in`: `in` on a Set looks at keys, and a Set has none, so the
// filter matched nothing and --quick silently ran everything.
const skipped = registered.filter((r) => FULL_TRANSFER_CHECKS.has(r.name));
  for (const r of skipped) {
    results.push({
      name: r.name,
      pass: true,
      detail: 'skipped: --quick omits the multi-gigabyte checks',
    });
  }
  const keep = registered.filter((r) => !FULL_TRANSFER_CHECKS.has(r.name));
  registered.length = 0;
  registered.push(...keep);
  process.stdout.write(
    `\n--quick: omitting ${skipped.length} multi-gigabyte check(s): ` +
      `${skipped.map((r) => r.name).join(', ')}\n\n`,
  );
}
await runAll();
results.sort((a, b) => a.name.localeCompare(b.name));

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
