/**
 * First-boot provisioning: fetch the two non-installer weights in the background.
 *
 * R2 says four weights are ready at first boot. Two are inside the installer.
 * These are the other two -- one mid, one high, 9.04 GiB -- and nothing in the
 * app fetched them, so the README's claim about a first launch was ahead of the
 * code.
 *
 * What this is, precisely:
 *
 *   - Runs once per install, at boot, in the background. It never blocks the
 *     window, never prompts, and never reports an error the user has to act on.
 *   - One transfer at a time. Two multi-gigabyte writes into one directory help
 *     neither, and a user on a metered link should not see two of them.
 *   - Resumes. Quit at 60% and the next launch continues from the `.part`.
 *   - Skips what the machine cannot hold, and says why in the picker.
 *   - Pauses on a metered connection until the user says otherwise.
 *   - Retries, with backoff, a few times. A dropped connection on first launch
 *     is normal and is not an error the user caused.
 *
 * It reports progress to the renderer; it does not decide what to do about it.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  cancelDownload,
  catalogModels,
  downloadModel,
  type DownloadProgress,
} from './model-download.js';
import { planProvisioning, DISK_SAFETY_MARGIN, type ProvisionCandidate } from './provision.js';
import { measureMachine } from './machine.js';

/** One weight the app wants ready, and where it stands. */
export interface ProvisionItem {
  id: string;
  bytes: number;
  /**
   * The weight's filename, e.g. `Qwen2.5-7B-Instruct-Q4_K_M.gguf`.
   *
   * Not the id, and the two differ: the id is `qwen2.5-7b-instruct-q4_k_m`. The
   * partial is written next to the *file*, so anything that has to find or remove
   * one needs this field. cancel() used the id, deleted a path that never existed,
   * and left a 4 GiB `.part` in the directory the embedded server serves -- the
   * exact outcome its own comment said it was preventing.
   */
  file: string;
  /** 'fetch' queued, 'running', 'done', 'skipped', 'paused', 'failed'. */
  state: 'queued' | 'running' | 'done' | 'skipped' | 'paused' | 'failed';
  /** Bytes on disk, including a partial from a previous run. */
  done: number;
  bytesPerSecond?: number;
  /** Why this was skipped, or the last failure. Empty while healthy. */
  reason?: string;
  /** The url actually fetched, so a mirror can be substituted in a test. */
  url: string;
}

export interface ProvisionStatus {
  items: ProvisionItem[];
  /** True while a transfer is in flight. */
  active: boolean;
  /**
   * True when the connection looks metered and we have paused for it.
   *
   * The user gets a one-click way to continue. We do not refuse: the download
   * is the app's own promise, and a user on a hotspot has decided to pay.
   */
  pausedForMetered: boolean;
  /** Set once the user has told us to continue on a metered link. */
  meterApproved: boolean;
}

export interface ProvisionEvents {
  onChange?: (status: ProvisionStatus) => void;
}

/**
 * Attempts before giving up on a weight.
 *
 * Three, not thirty. A first launch on a flaky hotel network should recover
 * from one or two blips; a weight that has failed three times has a real
 * problem and the honest move is to leave it for the user to retry from the
 * picker, where there is a button.
 */
const MAX_ATTEMPTS = 3;

/** Backoff between attempts. Deliberately short: first boot is interactive. */
const RETRY_DELAY_MS = [2000, 8000, 30_000];

/**
 * Bound a wait that should take milliseconds.
 *
 * Used where a caller has to wait on something it does not control -- a transfer
 * unwinding, a socket closing -- and where an unbounded await would leave a
 * button looking like it did nothing. The timeout is a bound, not a prediction:
 * it fires only if the thing being waited on is wedged.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)),
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

export class Provisioner {
  private items: ProvisionItem[] = [];
  private controller: AbortController | undefined;
  private running = false;
  private paused = false;
  private pausedForMetered = false;
  private meterApproved = false;
  private attempts = new Map<string, number>();
  private stopped = false;
  /**
   * The in-flight drain(), so cancel() can wait for it.
   *
   * Not for resuming -- resume() starts a new one. This exists so cancel() can
   * know when the transfer has actually unwound, because the partial cannot be
   * removed while its write stream is open.
   */
  private drainPromise: Promise<void> | undefined;

  constructor(
    private readonly modelDir: string,
    private readonly events: ProvisionEvents = {},
    /** Overrides the catalog url, so a test can serve from a local mirror. */
    private readonly urlFor: (entry: { url: string; file: string }) => string = (e) => e.url,
  ) {}

  /** The weights that are not in the installer: one mid, one high. */
  private candidates(): ProvisionCandidate[] {
    return catalogModels()
      .filter((entry) => entry.provision === 'first-boot')
      .map((entry) => ({
        id: entry.id,
        file: entry.file,
        url: this.urlFor(entry),
        revision: entry.revision,
        sha256: entry.sha256,
        bytes: entry.bytes,
      }));
  }

  status(): ProvisionStatus {
    return {
      items: this.items.map((item) => ({ ...item })),
      active: this.running,
      pausedForMetered: this.pausedForMetered,
      meterApproved: this.meterApproved,
    };
  }

  /**
   * Plan, then fetch, one at a time.
   *
   * Resolves when every candidate is done, skipped, or given up on. Never
   * rejects: provisioning is a background convenience and a rejection here would
   * be an unhandled error in a boot path.
   */
  async start(): Promise<void> {
    if (this.running || this.items.length > 0) return;

    const candidates = this.candidates();
    if (candidates.length === 0) return;

    const machine = await measureMachine(this.modelDir);
    const present = new Set(
      candidates.filter((c) => existsSync(join(this.modelDir, c.file))).map((c) => c.id),
    );
    const plan = planProvisioning(candidates, machine, present);

    this.items = plan.decisions.map((decision) => {
      const candidate = candidates.find((c) => c.id === decision.id)!;
      const partial = join(this.modelDir, `${candidate.file}.part`);
      return {
        id: decision.id,
        file: candidate.file,
        bytes: decision.bytes,
        state: decision.action === 'fetch' ? ('queued' as const) : ('skipped' as const),
        // A resumed transfer starts from whatever survived the last quit.
        done: existsSync(partial) ? statSync(partial).size : 0,
        ...(decision.action === 'skip' ? { reason: decision.reason } : {}),
        url: candidate.url,
      };
    });

    this.emit();
    // Kept, not just awaited: cancel() has to know when the transfer has unwound
    // before it can remove the partial. See drainPromise.
    this.drainPromise = this.drain();
    await this.drainPromise;
  }

  /**
   * Fetch queued items in order. One at a time, by construction.
   *
   * A `while` rather than a `for`, because a retry has to come back to the item
   * that failed. A `for` with a `break` left the item 'queued' and returned, so
   * a single failed attempt silently ended provisioning with a weight still
   * marked as pending -- and start() resolved, so nothing reported it.
   *
   * Work is anything 'queued' *or* 'paused'. Only accepting 'queued' meant a
   * pause mid-transfer set the item to 'paused', and resume() then found nothing
   * to do and provisioning stopped for good -- the Pause button looked like it
   * worked, because it did, and nothing ever came back.
   */
  private async drain(): Promise<void> {
    this.running = true;
    this.emit();

    try {
      for (;;) {
        const item = this.items.find((i) => i.state === 'queued' || i.state === 'paused');
        if (!item) break;
        if (this.stopped) break;
        // A metered link pauses before the first byte, not after 4 GiB. Report
        // the truth first: an item that says "queued" and will not start is a
        // lie the chip cannot render honestly.
        if (this.paused) {
          item.state = 'paused';
          this.emit();
          break;
        }

        this.controller = new AbortController();
        item.state = 'running';
        item.reason = undefined;
        this.emit();

        const ok = await this.transfer(item);

        if (ok) {
          item.state = 'done';
          item.done = item.bytes;
          this.emit();
          continue;
        }

        if (this.paused || this.stopped) {
          item.state = 'paused';
          this.emit();
          break;
        }

        const attempt = (this.attempts.get(item.id) ?? 0) + 1;
        this.attempts.set(item.id, attempt);
        if (attempt < MAX_ATTEMPTS) {
          item.state = 'queued';
          item.reason = `Attempt ${attempt} failed; trying again shortly.`;
          this.emit();
          await sleep(RETRY_DELAY_MS[attempt - 1] ?? 30_000);
          // A pause or a cancel during the backoff must not be undone by the
          // next turn of this loop.
          if (this.paused || this.stopped) {
            item.state = 'paused';
            this.emit();
            break;
          }
          continue;
        }

        item.state = 'failed';
        item.reason = item.reason ?? 'The transfer failed.';
        this.emit();
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.emit();
    }
  }

  /**
   * One transfer, with retries folded in.
   *
   * Returns false when it should not be retried -- a pause, a stop, or the user
   * cancelling.
   */
  private async transfer(item: ProvisionItem): Promise<boolean> {
    try {
      await downloadModel(this.modelDir, item.id, {
        confirmed: true,
        // The app promised these; asking again would be asking about something
        // already decided.
        signal: this.controller?.signal,
        resume: true,
        // A pause and a quit keep the partial so the next launch resumes. A cancel
        // does not, and downloadModel is the one that knows when the abort
        // settles -- having cancel() unlink the file while the transfer is still
        // unwinding races it against the writer.
        keepPartialOnAbort: !this.stopped,
        onProgress: (progress: DownloadProgress) => {
          item.done = progress.done;
          if (progress.bytesPerSecond !== undefined) {
            item.bytesPerSecond = progress.bytesPerSecond;
          }
          this.emit();
        },
      });
      return true;
    } catch (error) {
      if (this.paused || this.stopped) return false;
      if (!isAbort(error)) item.reason = errorMessage(error);
      return false;
    }
  }

  /**
   * Stop the current transfer and keep the partial.
   *
   * Sets `paused` whether or not something is running, because a pause reported
   * before the first boot call still has to be honoured when drain() reaches its
   * first item. Guarding on `running` -- as this used to -- meant a pause on an
   * idle provisioner was silently dropped.
   */
  pause(): void {
    this.paused = true;
    this.controller?.abort();
    this.emit();
  }

  /**
   * Continue after a pause.
   *
   * `metered` records that the user chose to continue on a metered link, so the
   * chip does not ask again on the next boot for the same install.
   */
  async resume(options: { metered?: boolean } = {}): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    if (options.metered) {
      this.meterApproved = true;
      this.pausedForMetered = false;
    }
    this.emit();
    if (!this.running) await this.drain();
  }

  /**
   * Stop for good, discarding the partial.
   *
   * Distinct from pause: the user is saying they do not want this weight, so a
   * leftover `.part` is exactly what should not survive -- the embedded server
   * serves every GGUF in the directory and a partial one loads as corruption.
   *
   * Async, and the await matters. Unlinking the partial while the write stream
   * is still open does not work: on Windows the unlink fails with EPERM and
   * `rmSync(..., { force: true })` swallows that error, so the file is still
   * there afterwards and the failure is invisible. So this waits for the transfer
   * to unwind -- which is what closes the stream -- and only then removes it.
   * The timeout is a bound on a wait that should take milliseconds, so a wedged
   * transfer cannot leave the Cancel button looking like it did nothing.
   */
  async cancel(id?: string): Promise<void> {
    this.stopped = true;
    this.paused = false;
    if (id) cancelDownload(id);
    else for (const item of this.items) if (item.state === 'running') cancelDownload(item.id);
    this.controller?.abort();

    // Both guards, not either. `running` is set false in drain()'s finally, which
    // can run before this line; drainPromise is the thing that is actually
    // awaited, and it is undefined when nothing was ever started.
    if (this.running && this.drainPromise) {
      await withTimeout(this.drainPromise, 10_000, 'the transfer to unwind');
    }

    for (const item of this.items) {
      if (id && item.id !== id) continue;
      if (item.state === 'done' || item.state === 'skipped') continue;
      item.state = 'skipped';
      item.reason = 'Cancelled.';
      // The file name, not the id. See ProvisionItem.file.
      rmSync(join(this.modelDir, `${item.file}.part`), { force: true });
      // Nothing on disk means nothing on the progress bar, and leaving it would
      // show "3.1 of 4.4 GiB" for a file that no longer exists.
      item.done = 0;
    }
    this.emit();
  }

  /**
   * The connection looks metered.
   *
   * Reported by the renderer from `navigator.connection`, which is the only
   * place this is available: Chromium exposes it, Node does not. Best effort by
   * construction, so the answer is a pause and a one-click continue, never a
   * refusal.
   *
   * Order matters and this handles both orders. The renderer reports the
   * connection as soon as the chip mounts, which can be before or after the
   * first boot calls start(). Recording the flag here and honouring it in drain()
   * means a report that arrives early pauses before the first byte, rather than
   * being silently dropped because nothing was running yet.
   */
  reportMetered(metered: boolean): void {
    if (metered === this.pausedForMetered) return;
    this.pausedForMetered = metered;

    if (metered && !this.meterApproved) {
      this.paused = true;
      // Only abort a live transfer; drain() checks `paused` before starting the
      // next item, which is what covers the report-before-start case.
      this.controller?.abort();
    }
    this.emit();
  }

  private emit(): void {
    this.events.onChange?.(this.status());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DISK_SAFETY_MARGIN };
