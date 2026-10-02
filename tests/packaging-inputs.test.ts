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
  author?: string;
  devDependencies: { electron: string };
  build: {
    files: string[];
    electronVersion?: string;
    linux: { icon?: string };
    win: { icon?: string };
    directories: { buildResources: string };
  };
};

/**
 * Properties electron-builder accepts in its `build` block.
 *
 * Anything outside this set makes electron-builder abort with a
 * ValidationError before it downloads anything, which is how the first two
 * release runs failed on all three desktop targets.
 */
const VALID_BUILD_KEYS = new Set([
  'afterAllArtifactBuild', 'afterExtract', 'afterPack', 'afterSign', 'apk',
  'appId', 'appImage', 'appx', 'appxManifestCreated', 'appxPackageCreated',
  'artifactBuildCompleted', 'artifactBuildStarted', 'artifactName', 'asar',
  'asarUnpack', 'beforeBuild', 'beforePack', 'buildDependenciesFromSource',
  'buildNumber', 'buildVersion', 'compression', 'copyright',
  'cscKeyPassword', 'cscLink', 'deb', 'defaultArch', 'detectUpdateChannel',
  'directories', 'disableDefaultIgnoredFiles', 'disableSanityCheckAsar',
  'dmg', 'downloadAlternateFFmpeg', 'electronBranding', 'electronCompile',
  'electronDist', 'electronDownload', 'electronLanguages', 'electronUpdaterCompatibility',
  'electronVersion', 'executableName', 'extends', 'extraFiles',
  'extraMetadata', 'extraResources', 'fileAssociations', 'files', 'flatpak',
  'forceCodeSigning', 'framework', 'freebsd', 'generateUpdatesFilesForAllChannels',
  'icon', 'includePdb', 'includeSubNodeModules', 'launchUiVersion', 'linux',
  'mac', 'mas', 'masDev', 'masDevProvision', 'macs', 'minimumSystemVersion',
  'msi', 'nodeGypRebuild', 'nodeVersion', 'npmArgs', 'npmRebuild', 'nsis',
  'nsisWeb', 'nuget', 'opt', 'packagerOptions', 'portable', 'productName',
  'protocols', 'publish', 'releaseInfo', 'removePackageKeywords',
  'removePackageScripts', 'rpm', 'sign', 'signAndEditExecutable', 'signingHashAlgorithms',
  'snap', 'squirrelWindows', 'targets', 'usePackageJson', 'win', 'x64',
  'nsisWebOptions',
]);

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

describe('electron-builder configuration is valid', () => {
  it('uses only properties electron-builder accepts', () => {
    // Regression: build.android is a Capacitor concept, not an
    // electron-builder one, and its presence aborted every desktop
    // packaging job with a schema ValidationError before any work started.
    const unknown = Object.keys(manifest.build).filter(
      (key) => !VALID_BUILD_KEYS.has(key),
    );
    expect(unknown).toEqual([]);
  });

  it('does not declare an android target for electron-builder', () => {
    expect(Object.keys(manifest.build)).not.toContain('android');
  });

  it('declares an author at the top level, not inside build', () => {
    expect(manifest.author).toBeTruthy();
    expect(Object.keys(manifest.build)).not.toContain('author');
  });

  it('pins electronVersion so detection is not required', () => {
    // npm workspaces hoist electron to the repository root, where
    // electron-builder does not look, so version detection fails.
    expect(manifest.build.electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins electronVersion to what is actually installed', () => {
    const installed = JSON.parse(
      readFileSync(
        join(REPO, 'node_modules', 'electron', 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    expect(manifest.build.electronVersion).toBe(installed.version);
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