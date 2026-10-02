/**
 * Builder view for the renderer.
 *
 * Kept separate from renderer.ts so the builder can be read, and tested, on
 * its own. The renderer is sandboxed, so this module talks to the filesystem
 * only through the preload bridge.
 *
 * Every value that reaches innerHTML goes through textContent or a created
 * element. The template engine escapes what it generates, but the panel also
 * displays file names and error text that come from elsewhere, and a renderer
 * that concatenates strings is how a scaffold becomes a script injection.
 */

import type { TemplateParam } from '@waypoint/harness';

export interface BuilderBridge {
  templates(): Promise<TemplateSummary[]>;
  preview(
    templateId: string,
    values: Record<string, string | boolean>,
  ): Promise<PreviewResult>;
  chooseFolder(): Promise<string | null>;
  write(
    templateId: string,
    values: Record<string, string | boolean>,
    directory: string | null,
  ): Promise<WriteResult>;
  deployers(): Promise<DeployerSummary[]>;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  params: TemplateParam[];
}

export interface PreviewResult {
  ok: boolean;
  files?: Array<{ path: string; contents: string }>;
  error?: string;
}

export interface WriteResult {
  ok: boolean;
  directory?: string;
  written: string[];
  refused: Array<{ path: string; reason: string }>;
  error?: string;
}

export interface DeployerSummary {
  id: string;
  name: string;
  configured: boolean;
  requirements: string;
}

/** Values collected from the form, keyed by param. */
export type BuilderValues = Record<string, string | boolean>;

export class BuilderView {
  private templates: TemplateSummary[] = [];
  private selected: TemplateSummary | null = null;
  private values: BuilderValues = {};
  private directory: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly bridge: BuilderBridge,
  ) {}

  async start(): Promise<void> {
    this.templates = await this.bridge.templates();
    this.render();
  }

  /** Current values, exposed so a caller can restore them. */
  get currentValues(): BuilderValues {
    return { ...this.values };
  }

  private render(): void {
    this.root.textContent = '';

    this.root.append(
      heading('Builder', 'h2'),
      text(
        'Pick a template, fill in the fields, then write it to a folder. ' +
          'Everything runs on your machine; nothing is uploaded.',
        'note',
      ),
    );

    this.root.append(this.renderTemplatePicker());

    if (this.selected) {
      this.root.append(this.renderFields());
      this.root.append(this.renderActions());
    }

    this.root.append(this.renderHistory());
  }

  private renderTemplatePicker(): HTMLElement {
    const container = element('div', 'builder-templates');

    for (const template of this.templates) {
      const card = element('button', 'builder-template');
      card.type = 'button';
      card.setAttribute('aria-pressed', String(template.id === this.selected?.id));

      card.append(
        element('span', 'builder-template-name', template.name),
        text(template.description, 'builder-template-desc'),
      );

      card.addEventListener('click', () => {
        this.select(template);
      });

      container.append(card);
    }

    return container;
  }

  private renderFields(): HTMLElement {
    const form = element('div', 'builder-fields');
    const template = this.selected;
    if (!template) return form;

    form.append(heading(template.description, 'h3'));

    for (const param of template.params) {
      form.append(this.renderField(param));
    }

    return form;
  }

  private renderField(param: TemplateParam): HTMLElement {
    const wrapper = element('div', 'builder-field');
    const id = `builder-${param.key}`;

    const label = element('label', 'builder-label', param.label);
    label.setAttribute('for', id);

    let input: HTMLElement;

    if (param.type === 'boolean') {
      input = element('input');
      (input as HTMLInputElement).type = 'checkbox';
      (input as HTMLInputElement).checked = this.values[param.key] !== false;
    } else if (param.type === 'textarea') {
      input = element('textarea', 'builder-input');
      (input as HTMLTextAreaElement).value = String(this.values[param.key] ?? '');
      (input as HTMLTextAreaElement).rows = 4;
    } else if (param.type === 'select') {
      input = element('select', 'builder-input');
      for (const option of param.options ?? []) {
        const node = element('option', undefined, option.label);
        (node as HTMLOptionElement).value = option.value;
        input.append(node);
      }
      (input as HTMLSelectElement).value = String(this.values[param.key] ?? '');
    } else {
      input = element('input', 'builder-input');
      const field = input as HTMLInputElement;
      field.type = param.type === 'color' ? 'color' : 'text';
      field.value = String(this.values[param.key] ?? param.default ?? '');
      if (param.placeholder) field.placeholder = param.placeholder;
    }

    input.id = id;

    const read = (): void => {
      if (param.type === 'boolean') {
        this.values[param.key] = (input as HTMLInputElement).checked;
        return;
      }
      if (param.type === 'select') {
        this.values[param.key] = (input as HTMLSelectElement).value;
        return;
      }
      this.values[param.key] =
        param.type === 'textarea'
          ? (input as HTMLTextAreaElement).value
          : (input as HTMLInputElement).value;
    };

    input.addEventListener('input', read);
    input.addEventListener('change', read);

    wrapper.append(label, input);

    if (param.help) wrapper.append(text(param.help, 'builder-help'));

    return wrapper;
  }

  private renderActions(): HTMLElement {
    const actions = element('div', 'builder-actions');

    const preview = element('button', 'builder-button', 'Preview');
    preview.type = 'button';
    preview.addEventListener('click', () => {
      void this.preview();
    });

    const folder = element('button', 'builder-button', 'Choose folder');
    folder.type = 'button';
    folder.addEventListener('click', () => {
      void this.chooseFolder();
    });

    const write = element('button', 'builder-button builder-button-primary', 'Write site');
    write.type = 'button';
    write.addEventListener('click', () => {
      void this.write();
    });

    actions.append(preview, folder, write);

    if (this.directory) {
      actions.append(text(`Folder: ${this.directory}`, 'builder-folder'));
    }

    return actions;
  }

  private renderHistory(): HTMLElement {
    const container = element('div', 'builder-history');
    if (this.lastMessage) {
      container.append(text(this.lastMessage, 'builder-message'));
    }
    return container;
  }

  private lastMessage = '';

  private select(template: TemplateSummary): void {
    this.selected = template;
    this.values = {};

    // Seed with defaults so the form shows something sensible rather than
    // blanks the user has to guess at.
    for (const param of template.params) {
      if (param.default !== undefined) this.values[param.key] = param.default;
    }

    this.render();
  }

  private async preview(): Promise<void> {
    if (!this.selected) return;

    const result = await this.bridge.preview(this.selected.id, this.values);

    this.lastMessage = result.ok
      ? `${result.files?.length ?? 0} file(s) ready to write.`
      : `Cannot build: ${result.error ?? 'unknown problem'}`;

    this.render();
  }

  private async chooseFolder(): Promise<void> {
    this.directory = await this.bridge.chooseFolder();
    this.lastMessage = this.directory ? '' : 'No folder selected.';
    this.render();
  }

  private async write(): Promise<void> {
    if (!this.selected) return;

    let directory = this.directory;
    if (!directory) {
      directory = await this.bridge.chooseFolder();
      if (!directory) {
        this.lastMessage = 'No folder selected.';
        this.render();
        return;
      }
      this.directory = directory;
    }

    const result = await this.bridge.write(this.selected.id, this.values, directory);

    this.lastMessage = describeWrite(result);
    this.render();
  }
}

/**
 * Describe a write outcome in one line.
 *
 * A refusal is stated rather than hidden: silently writing four of five files
 * leaves the user believing they have a working site.
 */
export function describeWrite(result: WriteResult): string {
  if (!result.ok) {
    return `Failed: ${result.error ?? 'unknown problem'}`;
  }

  const parts = [`Wrote ${result.written.length} file(s)`];
  if (result.directory) parts.push(`to ${result.directory}`);

  if (result.refused.length > 0) {
    const first = result.refused[0];
    parts.push(
      `, ${result.refused.length} refused` +
        (first ? ` (${first.path}: ${first.reason})` : ''),
    );
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                    */
/* ------------------------------------------------------------------ */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function heading(content: string, tag: 'h2' | 'h3' | 'h4'): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}

function text(content: string, className?: string): HTMLElement {
  const node = document.createElement('p');
  // textContent, never innerHTML. These strings include file names and error
  // messages that did not come from the escaping template.
  node.textContent = content;
  if (className) node.className = className;
  return node;
}