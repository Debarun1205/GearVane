import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checkUpdate,
  compareSemver,
  downloadUpdateFile,
  findPlatformAsset,
  isNewerVersion,
  parseSemver,
  type GitHubAsset,
  type GitHubRelease,
} from '../src/updater.js';

describe('semver parsing & comparison', () => {
  it('parses valid semver strings with or without leading v', () => {
    expect(parseSemver('0.4.2')).toEqual({ major: 0, minor: 4, patch: 2 });
    expect(parseSemver('v0.4.3')).toEqual({ major: 0, minor: 4, patch: 3 });
    expect(parseSemver('v1.12.5-alpha')).toEqual({ major: 1, minor: 12, patch: 5 });
  });

  it('rejects invalid or non-semver strings', () => {
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver(null as unknown as string)).toBeNull();
  });

  it('correctly compares version numbers', () => {
    expect(compareSemver('0.4.3', '0.4.2')).toBeGreaterThan(0);
    expect(compareSemver('0.5.0', '0.4.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.4.2', '0.4.2')).toBe(0);
    expect(compareSemver('v0.4.2', '0.4.2')).toBe(0);
    expect(compareSemver('0.4.1', '0.4.2')).toBeLessThan(0);
  });

  it('identifies when an update is available', () => {
    expect(isNewerVersion('v0.4.3', '0.4.2')).toBe(true);
    expect(isNewerVersion('v0.4.2', '0.4.2')).toBe(false);
    expect(isNewerVersion('v0.4.1', '0.4.2')).toBe(false);
  });
});

describe('platform asset resolution', () => {
  const sampleAssets: GitHubAsset[] = [
    {
      name: 'GearVane.Setup.0.4.3.exe',
      browser_download_url: 'https://github.com/Debarun1205/GearVane/releases/download/v0.4.3/GearVane.Setup.0.4.3.exe',
      size: 1000000,
    },
    {
      name: 'GearVane.0.4.3.exe',
      browser_download_url: 'https://github.com/Debarun1205/GearVane/releases/download/v0.4.3/GearVane.0.4.3.exe',
      size: 1000000,
    },
    {
      name: 'GearVane-0.4.3-arm64.dmg',
      browser_download_url: 'https://github.com/Debarun1205/GearVane/releases/download/v0.4.3/GearVane-0.4.3-arm64.dmg',
      size: 900000,
    },
    {
      name: 'GearVane-0.4.3.AppImage',
      browser_download_url: 'https://github.com/Debarun1205/GearVane/releases/download/v0.4.3/GearVane-0.4.3.AppImage',
      size: 800000,
    },
    {
      name: 'gearvane-app_0.4.3_amd64.deb',
      browser_download_url: 'https://github.com/Debarun1205/GearVane/releases/download/v0.4.3/gearvane-app_0.4.3_amd64.deb',
      size: 800000,
    },
  ];

  it('resolves Setup.exe for win32', () => {
    const asset = findPlatformAsset(sampleAssets, 'win32');
    expect(asset).toBeDefined();
    expect(asset?.name).toBe('GearVane.Setup.0.4.3.exe');
    expect(asset?.downloadUrl).toContain('GearVane.Setup.0.4.3.exe');
  });

  it('resolves DMG for darwin', () => {
    const asset = findPlatformAsset(sampleAssets, 'darwin');
    expect(asset).toBeDefined();
    expect(asset?.name).toBe('GearVane-0.4.3-arm64.dmg');
  });

  it('resolves AppImage for linux', () => {
    const asset = findPlatformAsset(sampleAssets, 'linux');
    expect(asset).toBeDefined();
    expect(asset?.name).toBe('GearVane-0.4.3.AppImage');
  });

  it('falls back to deb if AppImage is absent on linux', () => {
    const withoutAppImage = sampleAssets.filter((a) => !a.name.endsWith('.AppImage'));
    const asset = findPlatformAsset(withoutAppImage, 'linux');
    expect(asset).toBeDefined();
    expect(asset?.name).toBe('gearvane-app_0.4.3_amd64.deb');
  });

  it('returns null when no matching asset exists', () => {
    expect(findPlatformAsset([], 'win32')).toBeNull();
  });
});

describe('checkUpdate', () => {
  it('returns update info when release is newer', async () => {
    const mockRelease: GitHubRelease = {
      tag_name: 'v0.4.3',
      name: 'GearVane v0.4.3',
      html_url: 'https://github.com/Debarun1205/GearVane/releases/tag/v0.4.3',
      body: 'Bug fixes and performance improvements.',
      assets: [
        {
          name: 'GearVane.Setup.0.4.3.exe',
          browser_download_url: 'https://github.com/Debarun1205/GearVane/releases/download/v0.4.3/GearVane.Setup.0.4.3.exe',
          size: 1024,
        },
      ],
    };

    const mockFetch: typeof fetch = (async () =>
      new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const info = await checkUpdate('0.4.2', {
      fetchImpl: mockFetch,
      platform: 'win32',
    });

    expect(info).not.toBeNull();
    expect(info?.latestVersion).toBe('0.4.3');
    expect(info?.currentVersion).toBe('0.4.2');
    expect(info?.asset?.name).toBe('GearVane.Setup.0.4.3.exe');
  });

  it('returns null when current version is equal or newer', async () => {
    const mockRelease: GitHubRelease = {
      tag_name: 'v0.4.2',
      name: 'GearVane v0.4.2',
    };

    const mockFetch: typeof fetch = (async () =>
      new Response(JSON.stringify(mockRelease), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const info = await checkUpdate('0.4.2', { fetchImpl: mockFetch });
    expect(info).toBeNull();
  });

  it('handles network failure gracefully', async () => {
    const failingFetch: typeof fetch = (async () => {
      throw new Error('Network offline');
    }) as typeof fetch;

    const info = await checkUpdate('0.4.2', { fetchImpl: failingFetch });
    expect(info).toBeNull();
  });
});

describe('downloadUpdateFile', () => {
  it('streams file download and reports progress', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gearvane-update-test-'));
    const content = 'installer-binary-payload-data';

    const mockFetch: typeof fetch = (async () =>
      new Response(content, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(content.length),
        },
      })) as typeof fetch;

    let reportedPercent = 0;
    const filePath = await downloadUpdateFile(
      'https://example.com/installer.exe',
      'installer.exe',
      tempDir,
      {
        fetchImpl: mockFetch,
        onProgress: (p) => {
          reportedPercent = p.percent;
        },
      },
    );

    expect(filePath).toBe(join(tempDir, 'installer.exe'));
    expect(readFileSync(filePath, 'utf8')).toBe(content);
    expect(reportedPercent).toBe(100);
  });
});
