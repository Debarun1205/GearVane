/**
 * Model picker: the dropdown that chooses what drives the next run.
 *
 * One component serves the chat header and the IDE agent pane. It
 * lists "Auto" first — the original routing idea: classify the
 * request and pick the cheapest tier that can do the job — followed
 * by every selectable model. Weights that are already on disk get a
 * green marker; choosing one that is missing downloads it first, so
 * the selection is always runnable.
 *
 * Download gating lives here so both hosts behave the same: small
 * weights (under 500 MB) install silently, larger ones ask first.
 * The component never downloads anything itself; it asks the host,
 * which owns the model directory.
 */

/** Anything a user can pick. */
export interface ModelPickerEntry {
  /** Value handed back when chosen. Empty means Auto. */
  id: string;
  /** Main label. */
  label: string;
  /** Right-hand detail: size, tier, or key state. */
  detail?: string;
  /** The weight is already on disk and ready to serve. */
  present?: boolean;
  /** Set when the row can be downloaded; absent means it cannot. */
  download?: { bytes: number };
}

/** Host-supplied actions the picker needs to run a selection. */
export interface ModelPickerHandlers {
  /** Install a weight; resolves true once it is on disk. */
  install(entry: ModelPickerEntry): Promise<boolean>;
  /** Ask permission to install a large weight; resolves true to proceed. */
  confirmInstall(entry: ModelPickerEntry): Promise<boolean>;
}

/**
 * Below this size a missing weight installs without asking. The
 * threshold keeps small models friction-free while multi-gigabyte
 * downloads stay a deliberate act.
 */
export const AUTO_INSTALL_LIMIT = 500 * 1048576;

/**
 * What the picker should do for a selection, decided purely so the
 * gating rules can be unit tested without a DOM.
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
 * On-disk and non-downloadable rows (Auto, hosted models) select
 * immediately. Missing weights under the auto-install limit install
 * without asking; larger ones install only if the user confirms.
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
  root.append(panel);

  const rows = new Map<string, HTMLElement>();
  let choosing: Promise<void> | undefined;

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
  };

  const choose = async (entry: ModelPickerEntry): Promise<void> => {
    const plan = await planSelection(entry, () =>
      options.handlers.confirmInstall(entry),
    );

    if (plan.install) {
      const installed = await options.handlers.install(entry);
      if (!installed) {
        close();
        return;
      }
      entry.present = true;
      panel
        .querySelector(`[data-model-id="${CSS.escape(entry.id)}"] .model-dot`)
        ?.classList.add('present');
    }

    close();
    if (plan.select) select(entry.id);
  };

  const addRow = (entry: ModelPickerEntry): void => {
    const row = document.createElement('div');
    row.className = 'model-picker-row';
    row.setAttribute('role', 'option');
    row.dataset.modelId = entry.id;

    const dot = document.createElement('span');
    dot.className = 'model-dot' + (entry.present ? ' present' : '');
    dot.title = entry.present ? 'Installed on this device' : 'Not installed';

    const text = document.createElement('span');
    text.className = 'model-picker-label';
    text.textContent = entry.label;

    row.append(dot, text);

    if (entry.detail) {
      const detail = document.createElement('span');
      detail.className = 'model-picker-detail';
      detail.textContent = entry.detail;
      row.append(detail);
    }

    row.addEventListener('click', () => {
      // Serialise choices so a fast double-click cannot start two
      // downloads for the same weight.
      choosing = (choosing ?? Promise.resolve()).then(() => choose(entry));
    });
    panel.append(row);
    rows.set(entry.id, row);
  };

  for (const entry of options.entries) addRow(entry);
  select(options.selected);

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
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
