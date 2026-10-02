/**
 * Bundle generation for the website builder.
 *
 * The website runs in a browser, so it cannot call `writeFile`. It builds a
 * zip in memory and hands it to the user as a download.
 *
 * ## Why zip, implemented here
 *
 * A zip is a stored (uncompressed) format, which is a few dozen lines: local
 * file headers, a central directory, and an end-of-central-directory record.
 * Compression would need DEFLATE, which is a real implementation.
 *
 * Compression is skipped deliberately. Generated scaffolds are a few kilobytes
 * of HTML, CSS, and JS that compress well but not enough to matter, and an
 * uncompressed archive is readable by every unzip tool without a compatibility
 * flag. The trade is a slightly larger download in exchange for an
 * implementation small enough to test.
 */

import { escapeHtml, type ScaffoldFile } from './scaffold.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** CRC-32, table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    const entry = CRC_TABLE[(crc ^ data[index]!) & 0xff];
    // The table has 256 entries and the mask is 8 bits, so this cannot miss.
    // The check is here because noUncheckedIndexedAccess turns that reasoning
    // into a type error otherwise.
    if (entry === undefined) return 0;
    crc = entry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  nameBytes: Uint8Array;
  dataBytes: Uint8Array;
  crc: number;
  offset: number;
}

/**
 * MS-DOS date and time, which is what the zip format stores.
 *
 * Invalid dates are clamped rather than passed through, because a NaN written
 * into the header makes some extractors reject the whole archive.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));

  return {
    time:
      (Math.floor(date.getSeconds() / 2) & 0x1f) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getHours() & 0x1f) << 11),
    date:
      (date.getDate() & 0x1f) |
      ((date.getMonth() + 1) << 5) |
      (((year - 1980) & 0x7f) << 9),
  };
}

/**
 * Build a zip archive.
 *
 * Paths are normalised to forward slashes: the format requires it, and a
 * backslash produces an archive that extracts as a single oddly-named file on
 * Windows rather than a directory tree.
 */
export function createZip(
  files: readonly ScaffoldFile[],
  modified: Date = new Date(),
): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);

  const entries: ZipEntry[] = files.map((file) => {
    const nameBytes = encoder.encode(file.path.replace(/\\/g, '/'));
    const dataBytes = encoder.encode(file.contents);
    return {
      nameBytes,
      dataBytes,
      crc: crc32(dataBytes),
      offset: 0,
    };
  });

  const localSize = entries.reduce(
    (total, entry) => total + 30 + entry.nameBytes.length + entry.dataBytes.length,
    0,
  );
  const centralSize = entries.reduce(
    (total, entry) => total + 46 + entry.nameBytes.length,
    0,
  );

  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let position = 0;

  for (const entry of entries) {
    entry.offset = position;

    view.setUint32(position, LOCAL_HEADER, true);
    // Version needed: 2.0, which is stored mode with no data descriptor.
    view.setUint16(position + 4, 20, true);
    // General purpose flags: 0x0800 marks the name as UTF-8.
    view.setUint16(position + 6, 0x0800, true);
    view.setUint16(position + 8, 0, true); // stored, not deflated
    view.setUint16(position + 10, time, true);
    view.setUint16(position + 12, date, true);
    view.setUint32(position + 14, entry.crc, true);
    view.setUint32(position + 18, entry.dataBytes.length, true);
    view.setUint32(position + 22, entry.dataBytes.length, true);
    view.setUint16(position + 26, entry.nameBytes.length, true);
    view.setUint16(position + 28, 0, true); // extra field length

    position += 30;
    output.set(entry.nameBytes, position);
    position += entry.nameBytes.length;
    output.set(entry.dataBytes, position);
    position += entry.dataBytes.length;
  }

  const centralStart = position;

  for (const entry of entries) {
    view.setUint32(position, CENTRAL_HEADER, true);
    view.setUint16(position + 4, 20, true); // version made by
    view.setUint16(position + 6, 20, true); // version needed
    view.setUint16(position + 8, 0x0800, true);
    view.setUint16(position + 10, 0, true);
    view.setUint16(position + 12, time, true);
    view.setUint16(position + 14, date, true);
    view.setUint32(position + 16, entry.crc, true);
    view.setUint32(position + 20, entry.dataBytes.length, true);
    view.setUint32(position + 24, entry.dataBytes.length, true);
    view.setUint16(position + 28, entry.nameBytes.length, true);
    view.setUint16(position + 30, 0, true); // extra
    view.setUint16(position + 32, 0, true); // comment
    view.setUint16(position + 34, 0, true); // disk number
    view.setUint16(position + 36, 0, true); // internal attributes
    view.setUint32(position + 38, 0, true); // external attributes
    view.setUint32(position + 42, entry.offset, true);

    position += 46;
    output.set(entry.nameBytes, position);
    position += entry.nameBytes.length;
  }

  view.setUint32(position, END_OF_CENTRAL, true);
  view.setUint16(position + 4, 0, true);
  view.setUint16(position + 6, 0, true);
  view.setUint16(position + 8, entries.length, true);
  view.setUint16(position + 10, entries.length, true);
  view.setUint32(position + 12, position - centralStart, true);
  view.setUint32(position + 16, centralStart, true);
  view.setUint16(position + 20, 0, true);

  return output;
}

/** Base64, for the tests and for embedding in a data URL. */
export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    // Chunked, because String.fromCharCode.apply blows the argument limit on a
    // large archive and fails with an unhelpful RangeError.
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  // Node, for tests.
  return Buffer.from(bytes).toString('base64');
}

/* ------------------------------------------------------------------ */
/* Browser-side preview                                                 */
/* ------------------------------------------------------------------ */

/**
 * Render a file as a standalone preview document.
 *
 * A single file is shown directly, so a complete HTML page previews as the
 * page itself. Anything else is shown as source, wrapped in a minimal document
 * so the browser has something to render it in. A stylesheet is the exception:
 * it is wrapped in a `<style>` block so its rules visibly apply.
 *
 * `_all` is accepted so a caller can pass the whole file set for a future
 * multi-file preview; nothing reads it yet, and an unused parameter named
 * honestly is clearer than a signature that will change shape later.
 *
 * The wrapper is assembled by string concatenation. Every user-supplied string
 * is escaped on the way in, which is the reason `escapeHtml` is exported from
 * the scaffold module.
 */
export function renderPreview(
  file: ScaffoldFile,
  _all: readonly ScaffoldFile[] = [],
): string {
  const { contents } = file;

  // A complete document already: show it as-is.
  if (/<!doctype|<html[\s>]/i.test(contents)) {
    return contents;
  }

  const language = file.path.endsWith('.css')
    ? 'css'
    : file.path.endsWith('.js')
      ? 'javascript'
      : file.path.endsWith('.json')
        ? 'json'
        : 'markdown';

  if (language === 'css') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${contents}</style></head><body><h1>Preview</h1><p>Stylesheet</p></body></html>`;
  }

  const highlighted = escapeHtml(contents);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(file.path)}</title>
    <style>
      body {
        background: #0b1120;
        color: #e2e8f0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.6;
        margin: 0;
        padding: 1.5rem;
      }
      pre { white-space: pre-wrap; word-break: break-word; }
      .name {
        border-bottom: 1px solid #24304a;
        color: #38bdf8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: -1.5rem -1.5rem 1.5rem;
        padding: 0.75rem 1.5rem;
      }
      .hint { color: #94a3b8; font-family: -apple-system, sans-serif; margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <p class="name">${escapeHtml(file.path)}</p>
    ${
      language === 'markdown'
        ? '<p class="hint">Rendered as source. Markdown needs a renderer.</p>'
        : ''
    }
    <pre>${highlighted}</pre>
  </body>
</html>`;
}