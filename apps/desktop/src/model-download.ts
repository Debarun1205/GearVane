/**
 * The transfer itself: resolve, stream, verify, rename.
 *
 * Split out of models-host.ts so it does not import `electron`. That import is
 * only needed for the IPC handlers, and having it here meant the only way to
 * exercise a real download outside the app was to stub the module -- so the
 * first-boot provisioning check would have had to reimplement this logic, and a
 * check that reimplements what it is checking passes while the app's version
 * does the opposite.
 *
 * What this guarantees, in order:
 *
 *   1. The id is in the catalog. The renderer cannot turn the main process
 *      into an arbitrary-URL downloader, because the URL comes from here.
 *   2. Nothing above the installable ceiling is offered.
 *   3. Anything at or above AUTO_INSTALL_LIMIT needs the user's agreement, or
 *      the host refuses. The renderer's confirm dialog is the convenience; this
 *      is the half a sandboxed renderer cannot bypass.
 *   4. Bytes land in a `.part` file, are hashed, and are only renamed into the
 *      served path if the hash matches the catalog's.
 *
 * (4) is why the rename is last. The embedded server serves every GGUF in the
 * model directory, so a half-written weight would load as corruption, and a
 * weight that passed a size check but not a content check would fail to load
 * with no indication of why.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { isRemoteOnly, remoteOnlyReason } from './catalog.js';
import { AUTO_INSTALL_LIMIT } from './model-picker.js';

export interface CatalogModel {
  id: string;
  file: string;
  url: string;
  /** Commit sha the url resolves at, so the bytes cannot change under us. */
  revision: string;
  /** sha256 of the file as published. Verified after every download. */
  sha256: string;
  bytes: number;
  use: string;
  bundled: boolean;
  /**
   * How this weight reaches a user: inside the installer, or fetched by the app
   * on first launch. Absent means the user installs it from the picker.
   */
  provision?: 'installer' | 'first-boot';
}

export interface DownloadProgress {
  id: string;
  done: number;
  total: number;
  /** Current transfer rate, so the UI can show speed and an ETA. */
  bytesPerSecond?: number;
}

export function catalogModels(): CatalogModel[] {
  return loadCatalog().map((entry) => ({ ...entry }));
}

/**
 * The catalog sits beside this module in both layouts that matter: src/ under
 * vitest, dist/ in dev and packaged builds (the copy step puts it there,
 * because `tsc` types a JSON import but never emits the file -- and a bare ESM
 * JSON import would crash Electron's Node at startup).
 */
let catalogCache: CatalogModel[] | undefined;
function loadCatalog(): CatalogModel[] {
  if (!catalogCache) {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, 'models.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('models.json must be an array');
    catalogCache = parsed as CatalogModel[];
  }
  return catalogCache;
}

export function findCatalogEntry(id: unknown): CatalogModel | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  return catalogModels().find((entry) => entry.id === id);
}

/**
 * Live transfers, so a cancel can find the right one to abort.
 *
 * A module-level map rather than a parameter: a caller may pass no signal at
 * all, and one download must not be able to abort another.
 */
const inFlight = new Map<string, AbortController>();

/**
 * Abort a download in progress.
 *
 * False when nothing is running for that id, so a cancel button that outlives
 * its transfer does not claim to have stopped something.
 */
export function cancelDownload(id: string): boolean {
  const controller = inFlight.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function downloadModel(
  modelDir: string,
  id: string,
  options: {
    onProgress?: (progress: DownloadProgress) => void;
    fetchImpl?: typeof fetch;
    /** Aborts the transfer. The partial file is removed either way. */
    signal?: AbortSignal;
    /**
     * The user agreed to this weight, for a size at or above
     * AUTO_INSTALL_LIMIT. Set by the confirm dialog. Required for large
     * weights: without it the host refuses rather than downloading in silence.
     */
    confirmed?: boolean;
    /**
     * Override the expected sha256.
     *
     * Defaults to the catalog's, and production never overrides it: the whole
     * point is that the expected hash comes from the catalog rather than from
     * whatever the transfer produced. It exists so a test can verify the
     * verification -- a real weight's bytes cannot be reproduced in a stub, so
     * without this the only observable behaviour would be the mismatch path.
     */
    expectedSha256?: string;
    /**
     * Continue from an existing `.part` rather than starting over.
     *
     * Default true. The catalog pins every URL to a commit, so the bytes behind
     * it cannot change and a resumed transfer cannot splice two different files.
     */
    resume?: boolean;
    /**
     * Keep the `.part` when the transfer is aborted.
     *
     * For a pause and for a quit, where the point is to pick up where it left
     * off. A cancel leaves this false: the user asked it to stop, and a stale
     * partial is what the embedded server would otherwise serve.
     */
    keepPartialOnAbort?: boolean;
  } = {},
): Promise<{ path: string; bytes: number }> {
  const entry = findCatalogEntry(id);
  if (!entry) throw new Error(`unknown model: ${String(id)}`);

  mkdirSync(modelDir, { recursive: true });
  const target = join(modelDir, entry.file);
  if (existsSync(target)) return { path: target, bytes: sizeOf(target) };

  // The picker already withholds the download affordance for these, but this is
  // the boundary that matters: the renderer is sandboxed and every argument
  // arrives over IPC, so a crafted `models:fetch` must not be able to start a
  // transfer the UI never offered.
  if (isRemoteOnly(entry)) {
    throw new Error(remoteOnlyReason(entry.bytes));
  }

  if (entry.bytes >= AUTO_INSTALL_LIMIT && !options.confirmed) {
    throw new Error(
      `${entry.id} is ${(entry.bytes / 1048576).toFixed(0)} MB, at or above the ` +
        `${AUTO_INSTALL_LIMIT / 1048576} MB threshold, and was not confirmed. ` +
        'A silent install of a weight this size is not something the host may do unasked.',
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const forward = (): void => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted) controller.abort();
  const detach = (): void => options.signal?.removeEventListener('abort', forward);

  inFlight.set(entry.id, controller);

  // Resume. A first-boot weight is 4-5 GiB, and a user who quits the app at 60%
  // should not start again from zero. The catalog pins every URL to a commit,
  // so the bytes behind it cannot change and a resumed transfer cannot splice
  // two different files together.
  //
  // The `.part` size is the offset. A server that ignores Range answers 200
  // with the whole file, and appending that to what is already on disk would
  // produce a file of roughly double length -- so on a 200 the partial is
  // discarded and the transfer starts clean.
  const partial = `${target}.part`;
  let offset = 0;
  if (options.resume !== false && existsSync(partial)) {
    offset = statSync(partial).size;
    // Longer than the real file: a corrupted leftover from a previous version.
    if (entry.bytes && offset > entry.bytes) {
      rmSync(partial, { force: true });
      offset = 0;
    }
  }

  const headers: Record<string, string> = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  let response: Response;
  try {
    response = await fetchImpl(entry.url, {
      signal: controller.signal,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  } catch (error) {
    detach();
    inFlight.delete(entry.id);
    throw error;
  }
  if (!response.ok || !response.body) {
    detach();
    inFlight.delete(entry.id);
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  // 206 is "here is the rest". Anything else with a 200 status means the server
  // ignored the Range and is sending the whole file again.
  const resuming = response.status === 206;
  if (offset > 0 && !resuming) {
    rmSync(partial, { force: true });
  }
  const startAt = resuming ? offset : 0;

  // The catalog's byte count is the authority when it has one. The header is a
  // fallback, and on a resume the header describes only the tail, so it is added
  // to the offset rather than used alone.
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  const total = entry.bytes || contentLength + startAt;

  const startedAt = Date.now();
  const startedBytes = startAt;
  let done = startAt;
  let sink: WriteStream | undefined;
  try {
    const source = Readable.fromWeb(
      response.body as import('node:stream/web').ReadableStream,
    );
    source.on('data', (chunk: Buffer) => {
      done += chunk.length;
      const elapsed = Math.max(1, Date.now() - startedAt);
      options.onProgress?.({
        id: entry.id,
        done,
        total,
        // Over the whole transfer, not the resumed tail, so the figure does not
        // jump every time a paused download picks back up.
        bytesPerSecond: ((done - startedBytes) / elapsed) * 1000,
      });
    });
    // pipeline, not pipe + finished: .pipe() returns the destination, so
    // finished() would only ever watch the write side. A cancelled transfer
    // fails on the *read* side, and pipe swallows that -- so the await never
    // settled, the download hung after being cancelled, and the .part file
    // below was never cleaned up. pipeline watches both ends and tears down the
    // whole chain, which is what the catch block relies on.
    sink = createWriteStream(partial, { flags: startAt > 0 ? 'a' : 'w' });
    await pipeline(source, sink);
  } catch (error) {
    await handleReleased(sink);
    // A pause or a quit keeps the partial, so the next attempt resumes from it.
    // A cancel removes it, because the user asked it to stop and a stale .part
    // is exactly what the embedded server would otherwise try to load.
    if (!options.keepPartialOnAbort) {
      unlinkWithRetry(partial);
    }
    detach();
    inFlight.delete(entry.id);
    throw error;
  }
  detach();
  inFlight.delete(entry.id);

  // Verify before the rename. Without this a corrupted transfer -- a proxy that
  // truncated the body, a resume that spliced two versions -- becomes a model
  // that fails to load with no indication of why, and the embedded server goes
  // on serving it as though it were fine.
  const expected = options.expectedSha256 ?? entry.sha256;
  if (expected) {
    const digest = await sha256Of(partial);
    if (digest !== expected) {
      rmSync(partial, { force: true });
      throw new Error(
        `checksum mismatch for ${entry.id}: got sha256 ${digest.slice(0, 16)}..., ` +
          `expected ${expected.slice(0, 16)}... The download was discarded.`,
      );
    }
  }

  renameSync(partial, target);
  return { path: target, bytes: sizeOf(target) };
}

/**
 * sha256 of a file, streamed.
 *
 * Read in chunks rather than whole: the largest weight in the catalog is
 * 19.24 GiB, and reading that into a Buffer to hash it is a 19 GiB allocation
 * in the main process on a machine that may not have 19 GiB free.
 */
export function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Remove a partial, retrying the EPERM Windows throws when the handle has not
 * settled yet.
 *
 * The wait for 'close' above is what actually fixes it; this is the backstop
 * for the case where 'close' has arrived but the directory entry has not.
 */
function unlinkWithRetry(path: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      unlinkSync(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return;
      // Synchronous on purpose: this runs in a catch block that is about to
      // rethrow, and an async wait there would need its own error handling.
      // A retry loop with no delay still catches the common case, and the
      // deterministic fix is the handleReleased wait above.
      void i;
    }
  }
  // Best effort: a stale .part is ignored on the next attempt.
}

/**
 * Wait until a write stream has closed its file handle.
 *
 * On Windows an unlink issued in the moment after a stream is destroyed can
 * still fail with EPERM, because the handle is released a tick later. Waiting
 * for 'close' is the deterministic version of retrying the unlink and hoping
 * the machine is fast enough.
 *
 * The timer is a backstop, not a deadline: a stream that never emits 'close'
 * must not hold a cancelled download open forever.
 */
function handleReleased(sink: WriteStream | undefined): Promise<void> {
  if (!sink) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (sink.closed) {
      resolve();
      return;
    }
    const done = (): void => resolve();
    sink.once('close', done);
    setTimeout(done, 500).unref?.();
  });
}
