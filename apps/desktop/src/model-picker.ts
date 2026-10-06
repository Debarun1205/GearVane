/**
 * Model picker: the dropdown that chooses what drives the next run.
 *
 * One component serves the chat header and the IDE agent pane. It lists
 * "Auto" first — the original routing idea: classify the request and pick the
 * cheapest tier that can do the job — then the selectable models grouped by
 * tier, with a search box over fifty of them.
 *
 * Weights already on disk are marked as installed. A green dot alone is not
 * an accessible signal, so the mark is a dot *and* a word.
 *
 * Download gating lives here so both hosts behave the same: weights under
 * 500 MB install without a dialog, larger ones ask first. "Without a dialog"
 * means without a prompt, not without feedback — a silent install still shows
 * a progress chip with a cancel button, because a transfer the user cannot see
 * or stop is the opposite of frictionless.
 *
 * The component never downloads anything itself; it asks the host, which owns
 * the model directory.
 */

/** Anything a user can pick. */
export interface ModelPickerEntry {
  /** Value handed back when chosen. Empty means Auto. */
  id: string;
  /** Main label. */
  label: string;
  /** Right-hand detail: size, tier, or key state. */
  detail?: string;
  /** Group heading, so fifty rows stay navigable. */
  group?: string;
  /** The weight is already on disk and ready to serve. */
  present?: boolean;
  /** Set when the row can be downloaded; absent means it cannot. */
  download?: { bytes: number };
  /** Catalog id to install, when the row id is qualified (provider/model). */
  downloadId?: string;
  /** License the weights ship under, when known. */
  license?: string;
  /** Where to read the license. */
  licenseUrl?: string;
}

/** A transfer in progress, for the progress chip. */
export interface InstallProgress {
  done: number;
  total: number;
}

export interface ModelPickerHandlers {
  /** Install a weight; resolves true once it is on disk. */
  install(entry: ModelPickerEntry): Promise<boolean>;
  /** Ask permission to install a large weight; resolves true to proceed. */
  confirmInstall(entry: ModelPickerEntry): Promise<boolean>;
  /**
   * Stop a transfer in progress.
   *
   * Absent means no cancel button is shown rather than a button that does
   * nothing: a control that appears to work and does not is worse than no
   * control.
   */
  cancel?(entry: ModelPickerEntry): Promise<boolean> | boolean;
  /**
   * Transfer ticks for one weight, returning the unsubscribe function.
   *
   * A subscription rather than a shared callback, because ticks are per
   * transfer: a single handler would put the second model's bytes on the first
   * model's chip. Absent means the host has no progress to offer, and the chip
   * falls back to an indeterminate bar.
   */
  subscribe?(
    entry: ModelPickerEntry,
    onProgress: (progress: InstallProgress) => void,
  ): () => void;
}

/**
 * Below this size a missing weight installs without a dialog. The threshold
 * keeps small models frictionless while multi-gigabyte downloads stay a
 * deliberate act.
 */
export const AUTO_INSTALL_LIMIT = 500 * 1048576;

/**
 * What the picker should do for a selection, decided purely so the gating
 * rules can be unit tested without a DOM.
 */
export interface SelectionPlan {
  /** Install the weight before selecting. */
  install: boolean;
  /** Select the entry once the plan completes. */
  select: boolean;
}

/**
 * Plan a selection.
 *
 * On-disk and non-downloadable rows (Auto, hosted models) select immediately.
 * Missing weights under the auto-install limit install without asking; larger
 * ones install only if the user confirms.
 */
export async function planSelection(
  entry: ModelPickerEntry,
  confirm: () => Promise<boolean>,
): Promise<SelectionPlan> {
  if (entry.present || !entry.download) {
    return { install: false, select: true };
  }
  if (entry.download.bytes < AUTO_INSTALL_LIMIT) {
    return { install: true, select: true };
  }
  const allowed = await confirm();
  return { install: allowed, select: allowed };
}

/**
 * Whether a row survives the search box.
 *
 * Matches the label and the detail, case-insensitively, and treats every run
 * of spaces as one so a stray double space cannot hide a row the user can
 * plainly see.
 */
export function matchesQuery(entry: ModelPickerEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = `${entry.label} ${entry.detail ?? ''} ${entry.license ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ');
  // Every whitespace-separated term must appear, so "qwen coder" narrows
  // rather than widening the way a substring match on the whole string would.
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}

/** Group rows for display, preserving order and dropping empty groups. */
export function groupEntries(entries: ModelPickerEntry[]): Array<{
  group: string;
  entries: ModelPickerEntry[];
}> {
  const groups: Array<{ group: string; entries: ModelPickerEntry[] }> = [];
  for (const entry of entries) {
    const name = entry.group ?? '';
    const last = groups[groups.length - 1];
    if (last && last.group === name) last.entries.push(entry);
    else groups.push({ group: name, entries: [entry] });
  }
  return groups;
}

/** Progress text for the chip. */
export function progressLabel(label: string, progress: InstallProgress): string {
  const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;
  // No total means the server sent no content-length; a percentage of
  // nothing would read as "0%", which is a lie rather than an unknown.
  if (progress.total <= 0) return `Installing ${label} — ${mb(progress.done)} so far`;
  const pct = Math.min(100, Math.round((progress.done / progress.total) * 100));
  return `Installing ${label} — ${mb(progress.done)} of ${mb(progress.total)} (${pct}%)`;
}

export interface ModelPicker {
  root: HTMLElement;
  /** Update the active row and the button label. */
  select(id: string): void;
  /** Stop listening for outside clicks. */
  destroy(): void;
}

export function createModelPicker(options: {
  entries: ModelPickerEntry[];
  selected: string;
  autoLabel: string;
  handlers: ModelPickerHandlers;
  /** Notified on every selection, including Auto. */
  onSelect(id: string): void;
}): ModelPicker {
  const root = document.createElement('div');
  root.className = 'model-picker';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'model-picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  root.append(button);

  const panel = document.createElement('div');
  panel.className = 'model-picker-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  // Search box. Fifty rows in a scrolling panel is a list to filter, not to
  // scan, and it is the difference between finding a model in two seconds and
  // scrolling past forty-nine others.
  const searchWrap = document.createElement('div');
  searchWrap.className = 'model-picker-search';
  const searchLabel = document.createElement('label');
  searchLabel.className = 'visually-hidden';
  searchLabel.htmlFor = 'model-picker-search-input';
  searchLabel.textContent = 'Search models';
  const search = document.createElement('input');
  search.id = 'model-picker-search-input';
  search.type = 'search';
  search.className = 'model-picker-search-input';
  search.placeholder = 'Search models';
  search.autocomplete = 'off';
  search.spellcheck = false;
  searchWrap.append(searchLabel, search);
  panel.append(searchWrap);

  const rowsHost = document.createElement('div');
  rowsHost.className = 'model-picker-rows';
  panel.append(rowsHost);

  root.append(panel);

  const rows = new Map<string, HTMLElement>();
  let choosing: Promise<void> | undefined;

  // The chip lives outside the panel so a transfer stays visible after the
  // menu closes, which is when a user most wants to know it is still running.
  const chip = document.createElement('div');
  chip.className = 'model-picker-chip';
  chip.setAttribute('role', 'status');
  chip.hidden = true;
  root.append(chip);

  const close = (): void => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };

  const select = (id: string): void => {
    rows.forEach((row, key) => {
      row.classList.toggle('selected', key === id);
      row.setAttribute('aria-selected', String(key === id));
    });
    const label =
      id === ''
        ? options.autoLabel
        : (options.entries.find((entry) => entry.id === id)?.label ?? id);
    button.textContent = label;
    button.title =
      id === ''
        ? 'Auto: GearVane classifies the request and picks the tier'
        : label;
    options.onSelect(id);
  };

  const markInstalled = (entry: ModelPickerEntry): void => {
    entry.present = true;
    const row = rows.get(entry.id);
    if (!row) return;
    const dot = row.querySelector('.model-dot');
    if (dot instanceof HTMLElement) {
      dot.classList.add('present');
      dot.title = 'Installed on this device';
    }
    // The word, not just the colour: a green dot is invisible to a screen
    // reader and to a monochrome display, and it is the only thing telling
    // the user this weight is ready.
    const mark = row.querySelector('.model-installed-mark');
    if (mark) mark.textContent = 'installed';
  };

  const choose = async (entry: ModelPickerEntry): Promise<void> => {
    const plan = await planSelection(entry, () =>
      options.handlers.confirmInstall(entry),
    );

    if (plan.install) {
      // "Silently" means no dialog, not no feedback: a multi-hundred-megabyte
      // transfer the user cannot see or stop is the opposite of frictionless.
      // The chip sits outside the panel so it stays visible once the menu
      // closes, which is when a user most wants to know it is still running.
      const total = entry.download?.bytes ?? 0;
      chip.hidden = false;
      setChip(entry, { done: 0, total });

      const unsubscribe = options.handlers.subscribe?.(entry, (progress) => {
        setChip(entry, progress);
      });

      let installed: boolean;
      try {
        installed = await options.handlers.install(entry);
      } finally {
        // Always detach: leaving the listener attached leaks a subscription
        // per install and keeps a hidden chip's closure alive.
        unsubscribe?.();
        chip.hidden = true;
      }

      if (!installed) {
        // Cancelled, or failed. Either way the weight is not on disk, so the
        // selection must not move to a model that cannot run.
        close();
        return;
      }
      markInstalled(entry);
    }

    close();
    if (plan.select) select(entry.id);
  };

  function setChip(entry: ModelPickerEntry, progress: InstallProgress): void {
    chip.textContent = '';

    const text = document.createElement('span');
    text.className = 'model-picker-chip-text';
    text.textContent = progressLabel(entry.label, progress);
    chip.append(text);

    if (options.handlers.cancel) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'model-picker-chip-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        void options.handlers.cancel?.(entry);
        chip.hidden = true;
      });
      chip.append(cancel);
    }
  }

  const addRow = (entry: ModelPickerEntry): void => {
    const row = document.createElement('div');
    row.className = 'model-picker-row';
    row.setAttribute('role', 'option');
    row.dataset.modelId = entry.id;

    const dot = document.createElement('span');
    dot.className = 'model-dot' + (entry.present ? ' present' : '');
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'model-picker-label';
    text.textContent = entry.label;

    row.append(dot, text);

    if (entry.present) {
      const mark = document.createElement('span');
      mark.className = 'model-installed-mark';
      mark.textContent = 'installed';
      row.append(mark);
    }

    if (entry.detail) {
      const detail = document.createElement('span');
      detail.className = 'model-picker-detail';
      detail.textContent = entry.detail;
      row.append(detail);
    }

    if (entry.license) {
      // A licence badge, so choosing a weight under custom terms is visible
      // before the download rather than only in the confirm dialog.
      const licence = document.createElement('span');
      const permissive = entry.license === 'Apache-2.0' || entry.license === 'MIT';
      licence.className =
        'model-picker-licence' + (permissive ? '' : ' model-picker-licence-custom');
      licence.textContent = permissive ? entry.license : 'custom licence';
      if (entry.licenseUrl) licence.title = `Licence: ${entry.license}`;
      row.append(licence);
    }

    row.addEventListener('click', () => {
      // Serialise choices so a fast double-click cannot start two downloads
      // for the same weight.
      choosing = (choosing ?? Promise.resolve()).then(() => choose(entry));
    });
    rowsHost.append(row);
    rows.set(entry.id, row);
  };

  // Grouped on first render, filtered on every keystroke.
  const render = (query: string): void => {
    rowsHost.textContent = '';
    const visible = options.entries.filter((entry) => matchesQuery(entry, query));
    for (const group of groupEntries(visible)) {
      if (group.group !== '') {
        const heading = document.createElement('div');
        heading.className = 'model-picker-group';
        heading.textContent = group.group;
        rowsHost.append(heading);
      }
      for (const entry of group.entries) addRow(entry);
    }
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = 'No model matches that.';
      rowsHost.append(empty);
    }
    // Re-apply the selection: rebuilding the rows drops the marked state.
    select(options.selected);
  };

  search.addEventListener('input', () => render(search.value));
  render('');

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) search.focus();
  });

  const onDocumentClick = (event: MouseEvent): void => {
    if (!panel.hidden && !root.contains(event.target as Node)) close();
  };
  document.addEventListener('click', onDocumentClick);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !panel.hidden) close();
  };
  document.addEventListener('keydown', onKeyDown);

  return {
    root,
    select,
    destroy() {
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}