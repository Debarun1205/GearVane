/**
 * The first-boot provisioning chip.
 *
 * Reports what the main process is doing, and offers the three things a user
 * can do about it: pause, cancel, or continue on a metered connection.
 *
 * It never blocks. No run is gated on this, no dialog is modal, and nothing here
 * takes focus -- a background download that stole the caret would be worse than
 * one the user could not see.
 *
 * Metered detection is a guess and is treated as one. `navigator.connection` is
 * the only place the answer exists and it is Chromium-only, so the honest
 * response is to pause and say why, with one click to continue. Refusing would
 * be a decision made from a guess on the user's behalf.
 */

/** What the main process reports. Mirrors ProvisionStatus; kept local so the
 *  renderer bundle does not pull in a main-process type. */
export interface ProvisionStatus {
  items: Array<{
    id: string;
    bytes: number;
    state: 'queued' | 'running' | 'done' | 'skipped' | 'paused' | 'failed';
    done: number;
    bytesPerSecond?: number;
    reason?: string;
  }>;
  active: boolean;
  pausedForMetered: boolean;
  meterApproved: boolean;
}

/** The bridge the chip needs. Every member optional: a host without
 *  provisioning gets no chip rather than a broken one. */
export interface ProvisionBridge {
  status?(): Promise<ProvisionStatus>;
  pause?(): Promise<ProvisionStatus>;
  resume?(options?: { metered?: boolean }): Promise<ProvisionStatus>;
  cancel?(id?: string): Promise<ProvisionStatus>;
  reportMetered?(metered: boolean): Promise<ProvisionStatus>;
  onStatus?(handler: (status: ProvisionStatus) => void): () => void;
  onReady?(handler: (ids: string[]) => void): () => void;
}

export interface ProvisionElements {
  chip: HTMLElement;
  label: HTMLElement;
  detail: HTMLElement;
  reason: HTMLElement;
  fill: HTMLElement;
  pause: HTMLButtonElement;
  resume: HTMLButtonElement;
  anyway: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/**
 * Does this connection look metered?
 *
 * `effectiveType` is the coarse signal ('2g', '3g') and `type` is the precise
 * one ('cellular'). A user on 4G who has not asked for data saving should not be
 * paused, so neither alone is enough: pause on cellular, on saveData, or on a
 * 2g link. Everything else is left alone.
 */
export function looksMetered(
  connection: (Navigator & { connection?: NetworkInformationLike })['connection'],
): boolean {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  if (connection.type === 'cellular') return true;
  return connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g';
}

interface NetworkInformationLike {
  saveData?: boolean;
  type?: string;
  effectiveType?: string;
  addEventListener?(type: string, handler: () => void): void;
}

/** Bytes and a rate, in the units a person reads. */
export function describeTransfer(
  done: number,
  total: number,
  bytesPerSecond: number | undefined,
): { detail: string; percent: number; eta: string } {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const doneText = `${(done / 1073741824).toFixed(1)} of ${(total / 1073741824).toFixed(1)} GB`;

  if (!bytesPerSecond || bytesPerSecond < 1 || done >= total) {
    return { detail: doneText, percent, eta: '' };
  }

  const mb = bytesPerSecond / 1048576;
  const speed = mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  const secondsLeft = (total - done) / bytesPerSecond;

  // An ETA of hours is the honest number and also the least useful one, so past
  // an hour it is stated as a duration rather than a clock time.
  const eta =
    secondsLeft >= 3600
      ? `about ${Math.round(secondsLeft / 3600)}h left`
      : `about ${Math.max(1, Math.round(secondsLeft / 60))} min left`;

  return { detail: `${doneText} at ${speed}, ${eta}`, percent, eta };
}

/** A human name for a weight id, for the chip and the notice. */
export function labelFor(id: string): string {
  return id.replace(/\.(q4_k_m|q4_0|q4_0\.\w+|gguf)$/i, '');
}

/**
 * Render one status into the chip.
 *
 * Pure, so the wording can be checked without a DOM.
 */
export function describe(status: ProvisionStatus): {
  visible: boolean;
  label: string;
  detail: string;
  reason: string;
  percent: number;
  showPause: boolean;
  showResume: boolean;
  showAnyway: boolean;
  showCancel: boolean;
} {
  const items = status.items;
  const running = items.find((item) => item.state === 'running');
  const paused = items.find((item) => item.state === 'paused');
  const finished = items.filter((item) => item.state === 'done');
  const skipped = items.filter((item) => item.state === 'skipped');
  const failed = items.filter((item) => item.state === 'failed');

  // Nothing to say: everything is either on disk or deliberately not wanted.
  if (!running && !paused && skipped.length === 0 && failed.length === 0) {
    return {
      visible: false,
      label: '',
      detail: '',
      reason: '',
      percent: 0,
      showPause: false,
      showResume: false,
      showAnyway: false,
      showCancel: false,
    };
  }

  const metered = status.pausedForMetered && !status.meterApproved;
  const base = {
    visible: true,
    showPause: false,
    showResume: false,
    showAnyway: false,
    showCancel: false,
  };

  if (running) {
    const { detail, percent } = describeTransfer(
      running.done,
      running.bytes,
      running.bytesPerSecond,
    );
    const queued = items.filter((item) => item.state === 'queued').length;
    const tail = queued > 0 ? ` — then ${queued} more` : '';
    return {
      ...base,
      visible: true,
      label: `Getting ${labelFor(running.id)} ready${tail}`,
      detail,
      reason: '',
      percent,
      showPause: true,
      showCancel: true,
    };
  }

  if (paused) {
    return {
      ...base,
      visible: true,
      label: `Paused${metered ? ' — this looks like a metered connection' : ''}`,
      detail: metered
        ? `${labelFor(paused.id)} needs ${(paused.bytes / 1073741824).toFixed(1)} GB.`
        : `${labelFor(paused.id)} is ${(paused.done / 1073741824).toFixed(1)} GB in. Pick up where it left off.`,
      reason: metered
        ? 'Nothing is downloading until you say so, and it resumes from where it stopped.'
        : '',
      percent: paused.bytes > 0 ? Math.round((paused.done / paused.bytes) * 100) : 0,
      // One click either way: on a metered link the button is the honest
      // override, and on a manual pause it is simply Resume.
      showResume: true,
      showAnyway: metered,
      showCancel: true,
    };
  }

  if (failed.length > 0) {
    const item = failed[0]!;
    return {
      ...base,
      visible: true,
      label: `Could not get ${labelFor(item.id)}`,
      detail: '',
      reason: `${item.reason ?? 'The transfer failed.'} You can retry it from the model picker.`,
      percent: item.bytes > 0 ? Math.round((item.done / item.bytes) * 100) : 0,
      showCancel: true,
    };
  }

  // Only skips and finished weights: say what is missing and why.
  const first = skipped[0];  return {
    ...base,
    visible: true,
    label:
      finished.length > 0
        ? `${finished.length} of ${items.length} weights ready`
        : 'Not downloading the remaining weights',
    detail: '',
    reason: first?.reason
      ? `${labelFor(first.id)}: ${first.reason}`
      : 'You chose not to download them. The model picker can fetch any of them later.',
    percent: 100,
    showCancel: false,
  };
}

/**
 * Wire the chip to the bridge.
 *
 * Returns a teardown that unsubscribes and detaches the handlers, so a renderer
 * teardown does not leave listeners pointing at a document that no longer exists.
 */
export function mountProvisionChip(
  bridge: ProvisionBridge | undefined,
  els: ProvisionElements,
  navigatorLike: Navigator = navigator,
): () => void {
  const apply = (status: ProvisionStatus): void => {
    const view = describe(status);
    els.chip.hidden = !view.visible;
    if (!view.visible) return;
    els.label.textContent = view.label;
    els.detail.textContent = view.detail;
    els.reason.textContent = view.reason;
    els.fill.style.width = `${view.percent}%`;
    els.pause.hidden = !view.showPause;
    els.resume.hidden = !view.showResume;
    els.anyway.hidden = !view.showAnyway;
    els.cancel.hidden = !view.showCancel;
    // The reason is the part that carries the information, so it is read out
    // rather than left as decoration.
    els.chip.setAttribute(
      'aria-label',
      [view.label, view.detail, view.reason].filter(Boolean).join('. '),
    );
  };

  if (!bridge?.status) {
    els.chip.hidden = true;
    return () => {};
  }

  const off: Array<() => void> = [];

  // Report the metered guess once, and again if the connection changes type.
  const connection = (
    navigatorLike as Navigator & { connection?: NetworkInformationLike }
  ).connection;
  const metered = looksMetered(connection);
  void bridge.reportMetered?.(metered);
  connection?.addEventListener?.('change', () => {
    void bridge.reportMetered?.(looksMetered(connection));
  });

  void bridge.status().then(apply);
  off.push(bridge.onStatus?.(apply) ?? (() => {}));

  const on = (
    element: HTMLButtonElement,
    handler: () => void,
  ): (() => void) => {
    element.addEventListener('click', handler);
    return () => element.removeEventListener('click', handler);
  };

  off.push(
    on(els.pause, () => void bridge.pause?.().then(apply)),
    on(els.resume, () => void bridge.resume?.().then(apply)),
    // The one-click metered override. Same call as Resume, with the flag that
    // stops the chip asking again on the next launch.
    on(els.anyway, () => void bridge.resume?.({ metered: true }).then(apply)),
    on(els.cancel, () => void bridge.cancel?.().then(apply)),
  );

  return () => {
    for (const offOne of off) offOne();
  };
}

/**
 * The "now using" notice.
 *
 * Short, once per weight, and it appears because a background download finished
 * -- which changes what Auto will pick. That is worth saying: the user watched
 * nothing happen and then got a different answer from the router.
 */
export function readyNotice(ids: string[]): string | null {
  if (ids.length === 0) return null;
  const names = ids.map(labelFor);
  if (names.length === 1) return `Now using ${names[0]}.`;
  return `Now using ${names.join(', ')}.`;
}
