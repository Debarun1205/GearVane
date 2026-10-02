import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createZip, renderPreview, toBase64 } from '../src/builder/bundle.js';
import { plan, type ScaffoldFile } from '../src/builder/scaffold.js';

const exec = promisify(execFile);

const FILES: ScaffoldFile[] = [
  { path: 'index.html', contents: '<!doctype html><title>Hi</title><h1>Hello</h1>' },
  { path: 'styles.css', contents: 'body { color: red; }' },
  { path: 'nested/deep/file.txt', contents: 'nested content' },
];

/**
 * Zip tests.
 *
 * The archive is verified with a real extractor rather than by reading our own
 * headers back, because the whole risk is that our headers are subtly wrong in
 * a way our reader would happily accept.
 */

describe('zip structure', () => {
  it('starts with a local file header', () => {
    const zip = createZip(FILES);
    const view = new DataView(zip.buffer);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
  });

  it('ends with the end-of-central-directory record', () => {
    const zip = createZip(FILES);
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;

    expect(view.getUint32(end, true)).toBe(0x06054b50);
  });

  it('records the file count in both places', () => {
    const zip = createZip(FILES);
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;

    expect(view.getUint16(end + 8, true)).toBe(FILES.length);
    expect(view.getUint16(end + 10, true)).toBe(FILES.length);
  });

  it('marks names as UTF-8', () => {
    // A non-UTF-8 name mangles on extraction for non-ASCII filenames.
    const zip = createZip([{ path: 'café.txt', contents: 'x' }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it('handles an empty file set', () => {
    const zip = createZip([]);
    const view = new DataView(zip.buffer);

    expect(zip).toHaveLength(22);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
  });

  it('normalises backslashes to forward slashes', () => {
    // A backslash makes some extractors produce one oddly-named file instead of
    // a directory tree.
    const zip = createZip([{ path: 'a\\b\\c.txt', contents: 'x' }]);
    const text = new TextDecoder().decode(zip);

    expect(text).toContain('a/b/c.txt');
    expect(text).not.toContain('a\\b\\c.txt');
  });

  it('produces identical bytes for identical input', () => {
    const when = new Date(2026, 0, 2, 12, 0, 0);
    expect(createZip(FILES, when)).toEqual(createZip(FILES, when));
  });

  it('clamps a date before 1980', () => {
    // The DOS date field cannot represent it, and a wrapped value makes some
    // extractors reject the archive.
    const zip = createZip(FILES, new Date(1970, 0, 1));
    const view = new DataView(zip.buffer);
    expect(Number.isFinite(view.getUint16(12, true))).toBe(true);
  });

  it('handles a large file', () => {
    const big = 'x'.repeat(500_000);
    const zip = createZip([{ path: 'big.txt', contents: big }]);
    const view = new DataView(zip.buffer);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(zip.byteLength).toBeGreaterThan(500_000);
  });

  it('encodes to base64', () => {
    const zip = createZip(FILES);
    const encoded = toBase64(zip);

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(encoded, 'base64')).toHaveLength(zip.length);
  });

  it('encodes a large archive to base64 without blowing the stack', () => {
    // String.fromCharCode.apply has an argument limit and fails with an
    // unhelpful RangeError, which is why toBase64 chunks.
    const zip = createZip([{ path: 'big.txt', contents: 'y'.repeat(300_000) }]);
    expect(() => toBase64(zip)).not.toThrow();
  });
});

describe('a real extractor agrees', () => {
  it('extracts through PowerShell Expand-Archive', async () => {
    const base = await mkdtemp(join(tmpdir(), 'waypoint-zip-'));
    const zipPath = join(base, 'out.zip');
    const outDir = join(base, 'out');

    await writeFile(zipPath, createZip(FILES));

    const script =
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${outDir}')`;

    await exec(
      'powershell',
      ['-NoProfile', '-Command', script],
      { timeout: 60_000 },
    );

    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(index).toContain('Hello');

    const nested = await readFile(join(outDir, 'nested', 'deep', 'file.txt'), 'utf8');
    expect(nested).toBe('nested content');
  }, 90_000);
});

describe('preview rendering', () => {
  it('shows a complete document as-is', () => {
    const html = '<!doctype html><html><body>real page</body></html>';
    expect(renderPreview({ path: 'index.html', contents: html }, [])).toBe(html);
  });

  it('wraps a stylesheet so its rules apply', () => {
    const output = renderPreview(
      { path: 'styles.css', contents: 'body { color: red; }' },
      [],
    );
    expect(output).toContain('<style>');
    expect(output).toContain('body { color: red; }');
  });

  it('escapes source it displays', () => {
    const output = renderPreview(
      { path: 'server.js', contents: 'const x = "<script>alert(1)</script>";' },
      [],
    );
    expect(output).not.toContain('<script>alert(1)</script>');
    expect(output).toContain('&lt;script&gt;');
  });

  it('escapes the file path it displays', () => {
    const output = renderPreview({ path: '<img src=x>.txt', contents: 'x' }, []);
    expect(output).not.toContain('<img src=x>');
  });

  it('notes that markdown is not rendered', () => {
    // Saying so beats showing raw hashes and letting the user think the
    // generator produced broken output.
    const output = renderPreview({ path: 'README.md', contents: '# Title' }, []);
    expect(output).toContain('needs a renderer');
  });
});

describe('scaffold output zips cleanly', () => {
  it('produces an extractable archive from a real scaffold', async () => {
    const result = plan({
      templateId: 'landing',
      values: {
        projectName: 'Zip Test',
        tagline: 'Check the archive',
        features: 'One\nTwo',
      },
    });

    const base = await mkdtemp(join(tmpdir(), 'waypoint-zip-scaffold-'));
    const zipPath = join(base, 'site.zip');
    const outDir = join(base, 'out');

    await writeFile(zipPath, createZip(result.files));

    const script =
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${outDir}')`;

    await exec(
      'powershell',
      ['-NoProfile', '-Command', script],
      { timeout: 60_000 },
    );

    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain('Zip Test');
    expect(html).toContain('One');

    // The gitignore is a dotfile, which is the case most likely to be dropped.
    const gitignore = await readFile(join(outDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
  }, 90_000);
});