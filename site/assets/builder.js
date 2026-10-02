/**
 * Builder page.
 *
 * Runs entirely in the browser and has no network calls. That is not a
 * limitation worked around, it is the design: this page is served from GitHub
 * Pages, there is no backend, and a deploy credential in this file would be a
 * credential shipped to every visitor.
 *
 * The template engine lives in @waypoint/harness and is bundled from source, so
 * the website and the desktop app produce byte-identical output. Only the
 * transport differs: a download here, a folder write there.
 */

import {
  TEMPLATES,
  createZip,
  plan,
  renderPreview,
  slugify,
} from '../../packages/harness/src/builder/index.js';

/** Current selection and collected values. */
let selected = null;
let values = {};

/** Last built file set, kept so download does not rebuild. */
let built = [];

const dom = {
  templates: document.getElementById('templates'),
  formSection: document.getElementById('form-section'),
  fields: document.getElementById('fields'),
  preview: document.getElementById('preview'),
  download: document.getElementById('download'),
  message: document.getElementById('message'),
  previewSection: document.getElementById('preview-section'),
  fileList: document.getElementById('file-list'),
  frame: document.getElementById('preview-frame'),
};

function say(message) {
  dom.message.textContent = message;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/* ------------------------------------------------------------------ */
/* Template picker                                                     */
/* ------------------------------------------------------------------ */

function renderTemplates() {
  dom.templates.textContent = '';

  for (const template of TEMPLATES) {
    const card = element('button', 'builder-template');
    card.type = 'button';
    card.setAttribute('aria-pressed', 'false');

    card.append(
      element('span', 'builder-template-name', template.name),
      element('span', 'builder-template-desc', template.description),
    );

    card.addEventListener('click', () => select(template));
    dom.templates.append(card);
  }
}

function select(template) {
  selected = template;
  values = {};

  // Seed with declared defaults so the form shows something sensible rather
  // than blanks the user has to guess at.
  for (const param of template.params) {
    if (param.default !== undefined) values[param.key] = param.default;
  }

  for (const card of dom.templates.querySelectorAll('.builder-template')) {
    card.setAttribute(
      'aria-pressed',
      String(card.querySelector('.builder-template-name')?.textContent === template.name),
    );
  }

  dom.formSection.hidden = false;
  dom.previewSection.hidden = true;
  renderFields();
  say('');
}

function renderFields() {
  dom.fields.textContent = '';
  if (!selected) return;

  dom.fields.append(element('p', 'section-lede', selected.description));

  for (const param of selected.params) {
    dom.fields.append(renderField(param));
  }
}

function renderField(param) {
  const wrapper = element('div', 'builder-field');
  const id = `field-${param.key}`;

  const label = element('label', 'builder-label', param.label);
  label.setAttribute('for', id);

  let input;

  if (param.type === 'boolean') {
    input = element('input', 'builder-input');
    input.type = 'checkbox';
    input.checked = values[param.key] !== false;
  } else if (param.type === 'textarea') {
    input = element('textarea', 'builder-input');
    input.rows = 4;
    input.value = String(values[param.key] ?? '');
  } else {
    input = element('input', 'builder-input');
    input.type = param.type === 'color' ? 'color' : 'text';
    input.value = String(values[param.key] ?? param.default ?? '');
  }

  input.id = id;
  if (param.placeholder && input.tagName === 'INPUT') {
    input.placeholder = param.placeholder;
  }

  const read = () => {
    if (param.type === 'boolean') {
      values[param.key] = input.checked;
      return;
    }
    values[param.key] = input.value;
  };

  input.addEventListener('input', read);
  input.addEventListener('change', read);

  wrapper.append(label, input);

  if (param.help) wrapper.append(element('p', 'builder-help', param.help));

  return wrapper;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

function build() {
  if (!selected) return null;

  try {
    return plan({ templateId: selected.id, values });
  } catch (error) {
    say(`Cannot build: ${error.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function showPreview() {
  const result = build();
  if (!result) return;

  built = result.files;
  dom.previewSection.hidden = false;

  dom.fileList.textContent = '';
  for (const file of built) {
    dom.fileList.append(element('li', undefined, file.path));
  }

  const entry = built.find((file) => file.path === 'index.html') ?? built[0];
  if (!entry) return;

  // sandbox="" on the iframe: no scripts, no forms, no same-origin access. The
  // generated HTML is untrusted output as far as this page is concerned, even
  // though this page produced it.
  dom.frame.srcdoc = renderPreview(entry, built);

  say(`${built.length} file(s) ready.`);
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

function download() {
  const result = build();
  if (!result) return;

  built = result.files;

  const bytes = createZip(built);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  const name =
    slugify(String(values['projectName'] ?? 'waypoint-site')) || 'waypoint-site';

  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.zip`;
  document.body.append(link);
  link.click();
  link.remove();

  // Released on the next turn rather than immediately, because revoking
  // synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  say(`Downloaded ${built.length} file(s) as ${name}.zip. Unzip it, then deploy the folder anywhere.`);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

renderTemplates();
dom.preview.addEventListener('click', showPreview);
dom.download.addEventListener('click', download);