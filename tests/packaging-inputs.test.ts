import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The icon and the packaging inputs are what electron-builder needs.
 *
 * A missing icon makes every desktop packaging job fail at the last step,
 * after the whole build has already run, so it is checked directly.
 */

const REPO = join(import.meta.dirname, '..');
const APP = join(REPO, 'apps', 'desktop');
const RESOURCES = join(APP, 'resources');

const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as {
  build: {
    files: string[];
    linux: { icon?: string };
    win: { icon?: string };
    directories: { buildResources: string };
  };
};

describe('application icon', () => {
  it('exists', () => {
    // Regression: the first release run failed on all three desktop targets
    // because package.json referenced resources/icon.png, which had never
    // been created.
    expect(existsSync(join(RESOURCES, 'icon.png'))).toBe(true);
  });

  it('is a real PNG', () => {
    const bytes = readFileSync(join(RESOURCES, 'icon.png'));
    // PNG magic number.
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('is large enough for macOS to derive an icns', () => {
    // electron-builder needs at least 512x512 to generate an .icns.
    const bytes = readFileSync(join(RESOURCES, 'icon.png'));

    // IHDR width and height are big-endian uint32 at offset 16 and 20.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(height).toBeGreaterThanOrEqual(512);
  });

  it('is not a placeholder-sized file', () => {
    expect(statSync(join(RESOURCES, 'icon.png')).size).toBeGreaterThan(1024);
  });

  it('can be regenerated from source', () => {
    // The icon is generated, so the generator must be tracked alongside it.
    const generator = join(REPO, 'tools', 'make_icon.py');
    expect(existsSync(generator)).toBe(true);

    const source = readFileSync(generator, 'utf8');
    expect(source).toContain('resources');
    expect(source).toContain('icon.png');
  });
});

describe('packaging inputs', () => {
  it('points buildResources at the directory holding the icon', () => {
    expect(manifest.build.directories.buildResources).toBe('resources');
  });

  it('references the icon for Linux', () => {
    expect(manifest.build.linux.icon).toBe('resources/icon.png');
  });

  it('references the icon for Windows', () => {
    expect(manifest.build.win.icon).toBe('resources/icon.png');
  });

  it('ships the compiled main process and the renderer', () => {
    expect(manifest.build.files).toContain('dist/**/*');
    expect(manifest.build.files).toContain('renderer/**/*');
  });

  it('does not list the icon as an application file', () => {
    // Icons belong to the build, not to the packaged app tree. Listing them
    // in files ships a stray PNG inside the bundle for no reason.
    expect(manifest.build.files).not.toContain('resources/icon.png');
  });
});