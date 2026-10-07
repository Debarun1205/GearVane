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
  author?: { name?: string; email?: string } | string;
  homepage?: string;
  repository?: unknown;
  scripts: Record<string, string>;
  devDependencies: { electron: string };
  build: {
    files: string[];
    extraResources?: Array<{ from: string; to: string }>;
    electronVersion?: string;
    linux: { icon?: string };
    win: { icon?: string };
    directories: { buildResources: string };
  };
};

/** The catalog the fetch script and the installer both read. */
const catalog = JSON.parse(
  readFileSync(join(APP, 'src', 'models.json'), 'utf8'),
) as Array<{ id: string; file: string; bytes: number; bundled?: boolean }>;

const BUNDLED = catalog.filter((entry) => entry.bundled === true);

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
    expect(Object.keys(manifest.build)).not.toContain('author');
  });

  it('gives the author a name and an email', () => {
    // Regression: the deb target needs an email in the maintainer field and
    // fails with 'Please specify author email'. A bare author string was
    // enough for Windows and macOS, so only the Linux job surfaced it.
    const author = manifest.author as { name?: string; email?: string };
    expect(typeof author).toBe('object');
    expect(author.name).toBeTruthy();
    expect(author.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
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

  it('declares a homepage', () => {
    // Regression: without it electron-builder aborts the Linux build with
    // "Please specify project homepage". Windows and macOS did not need it,
    // so the Linux job failed alone and was easy to misread as a Linux
    // packaging problem.
    expect(manifest.homepage).toBeTruthy();
    expect(manifest.homepage).toMatch(/^https:\/\//);
  });

  it('declares a repository URL', () => {
    expect(manifest.repository).toBeTruthy();
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

/**
 * The installer's size is a release blocker, not a nicety: GitHub caps a
 * release asset at 2 GiB, and this app was measured building one at 9.7 GiB.
 */
describe('installer weight budget', () => {
  it('bundles exactly the two low-tier weights', () => {
    // Regression: extraResources pointed at the whole resources/models
    // directory. That directory is gitignored, so CI always starts empty and
    // always produces a correct installer -- while a developer's `npm run
    // dist` shipped every weight that machine happened to have, which is
    // where the 9.7 GiB came from. Naming each file removes the directory's
    // contents from the decision entirely.
    //
    // Two rather than one: R2 wants two low-tier models available offline at
    // first launch, and together they are 0.65 GiB -- well inside the 2 GiB
    // per-asset limit the release gate depends on.
    expect(BUNDLED).toHaveLength(2);
    expect(manifest.build.extraResources).toHaveLength(2);
  });

  it('keeps the installer payload under 1 GiB', () => {
    // The 2 GiB figure is GitHub's per-asset release cap; staying under 1 GiB
    // leaves room for the app itself. Derived from the catalog's real sizes so
    // it cannot drift from what actually ships.
    const bytes = BUNDLED.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(bytes).toBeLessThan(1024 * 1024 * 1024);
  });

  it('names each bundled file rather than the directory', () => {
    for (const resource of manifest.build.extraResources ?? []) {
      const from = resource.from ?? '';
      expect(from.startsWith('resources/models/')).toBe(true);
      // A trailing slash or a bare directory means "whatever is in here".
      expect(from.endsWith('/')).toBe(false);
    }
  });

  it('ships exactly the files the catalog flags as bundled', () => {
    // The filenames are duplicated in package.json because electron-builder's
    // config is static JSON. This is the guard against the two drifting, the
    // same way the site and README tables are guarded. Set comparison rather
    // than index-by-index, because order in a manifest is not a contract.
    const shipped = (manifest.build.extraResources ?? []).map((r) => r.from);
    expect(shipped.sort()).toEqual(
      BUNDLED.map((entry) => `resources/models/${entry.file}`).sort(),
    );
  });

  it('lands the weights where the app looks for them', () => {
    for (const resource of manifest.build.extraResources ?? []) {
      expect(resource.to).toBe('models');
    }
  });

  it('keeps the installer under the 2 GiB asset cap', () => {
    // The bundled model plus a generous allowance for Electron itself and the
    // compiled app. Generous on purpose: this is a tripwire for a second
    // weight creeping in, not a prediction of the exact artifact size.
    const budgetBytes = 2 * 1024 ** 3;
    expect(BUNDLED[0]?.bytes).toBeLessThan(budgetBytes / 2);
  });

  it('fetches the bundled model before packaging, locally and in CI', () => {
    // extraResources now names a file that has to exist, so a build that
    // skipped the fetch would fail late and confusingly. The release
    // workflow already fetched; the local scripts now match it.
    for (const script of ['dist', 'dist:linux', 'dist:win']) {
      expect(manifest.scripts[script]).toContain('models:fetch');
    }
    const workflow = readFileSync(
      join(REPO, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    // Match the commands, not the prose: the workflow's header comment names
    // electron-builder long before the packaging step, and matching that would
    // make this test pass for the wrong reason.
    const fetchAt = workflow.indexOf('run: npm run models:fetch');
    const packageAt = workflow.indexOf('npx electron-builder');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(packageAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(packageAt);
  });

  it('does not track downloaded weights in git', () => {
    // This is what let the directory drift without any test noticing: a
    // gitignored resources/models is empty in CI, so the packaging tests
    // could never see the problem.
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    expect(ignore).toContain('apps/desktop/resources/models/');
  });
});