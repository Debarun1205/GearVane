/**
 * Core updater logic for GearVane desktop.
 *
 * Checks GitHub Releases for newer versions, resolves platform-specific
 * installation assets, and downloads update files.
 *
 * Kept free of Electron imports so that pure semver and asset resolution logic
 * can be tested directly in Vitest without Electron runtime stubs.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, createWriteStream } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GITHUB_REPO = 'Debarun1205/GearVane';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export interface GitHubAsset {
  name: string;
  browser_download_url?: string;
  url?: string;
  size?: number;
  content_type?: string;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  html_url?: string;
  body?: string;
  assets?: GitHubAsset[];
}

export interface UpdateAsset {
  name: string;
  downloadUrl: string;
  size: number;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseUrl: string;
  releaseNotes?: string;
  asset?: UpdateAsset | null;
}

export interface DownloadProgress {
  done: number;
  total: number;
  percent: number;
}

/**
 * Parse a semver string like '0.4.2' or 'v0.4.3'.
 */
export function parseSemver(v: string): Semver | null {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Compare two semver strings.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * Check if the latest tag is newer than current version.
 */
export function isNewerVersion(latestTag: string, currentVersion: string): boolean {
  return compareSemver(latestTag, currentVersion) > 0;
}

/**
 * Pick the right binary or installer asset for the current OS.
 */
export function findPlatformAsset(
  assets: GitHubAsset[],
  targetPlatform: NodeJS.Platform = platform(),
): UpdateAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const valid = assets.filter(
    (a) => a && typeof a.name === 'string' && (a.browser_download_url || a.url),
  );

  if (targetPlatform === 'win32') {
    // Windows: Prefer Setup installer (.Setup.<version>.exe or -Setup-)
    const setup = valid.find(
      (a) => a.name.toLowerCase().endsWith('.exe') && a.name.toLowerCase().includes('setup'),
    );
    if (setup) {
      return {
        name: setup.name,
        downloadUrl: setup.browser_download_url ?? setup.url ?? '',
        size: setup.size ?? 0,
      };
    }
    // Fallback to standalone .exe
    const exe = valid.find((a) => a.name.toLowerCase().endsWith('.exe'));
    if (exe) {
      return {
        name: exe.name,
        downloadUrl: exe.browser_download_url ?? exe.url ?? '',
        size: exe.size ?? 0,
      };
    }
  } else if (targetPlatform === 'darwin') {
    // macOS: prefer DMG
    const dmg = valid.find((a) => a.name.toLowerCase().endsWith('.dmg'));
    if (dmg) {
      return {
        name: dmg.name,
        downloadUrl: dmg.browser_download_url ?? dmg.url ?? '',
        size: dmg.size ?? 0,
      };
    }
  } else if (targetPlatform === 'linux') {
    // Linux: prefer AppImage
    const appImage = valid.find((a) => a.name.toLowerCase().endsWith('.appimage'));
    if (appImage) {
      return {
        name: appImage.name,
        downloadUrl: appImage.browser_download_url ?? appImage.url ?? '',
        size: appImage.size ?? 0,
      };
    }
    // Fallback to deb
    const deb = valid.find((a) => a.name.toLowerCase().endsWith('.deb'));
    if (deb) {
      return {
        name: deb.name,
        downloadUrl: deb.browser_download_url ?? deb.url ?? '',
        size: deb.size ?? 0,
      };
    }
  }

  return null;
}

/**
 * Fetch latest release metadata from GitHub API.
 */
export async function fetchLatestRelease(
  repo: string = GITHUB_REPO,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'GearVane-Desktop-App',
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as GitHubRelease;
  } catch {
    return null;
  }
}

/**
 * Check whether an update is available compared to the current version.
 */
export async function checkUpdate(
  currentVersion: string,
  options?: {
    repo?: string;
    fetchImpl?: typeof fetch;
    platform?: NodeJS.Platform;
  },
): Promise<UpdateInfo | null> {
  const release = await fetchLatestRelease(options?.repo ?? GITHUB_REPO, options?.fetchImpl);
  if (!release || !release.tag_name) return null;

  if (!isNewerVersion(release.tag_name, currentVersion)) {
    return null;
  }

  const latestVersion = release.tag_name.replace(/^v/i, '');
  const asset = findPlatformAsset(release.assets ?? [], options?.platform);

  return {
    currentVersion,
    latestVersion,
    releaseName: release.name ?? release.tag_name,
    releaseUrl: release.html_url ?? `https://github.com/${options?.repo ?? GITHUB_REPO}/releases/latest`,
    releaseNotes: release.body,
    asset,
  };
}

/**
 * Stream-download an update file to destDir with progress reporting.
 */
export async function downloadUpdateFile(
  downloadUrl: string,
  fileName: string,
  destDir: string,
  options?: {
    fetchImpl?: typeof fetch;
    onProgress?: (progress: DownloadProgress) => void;
  },
): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const targetPath = join(destDir, fileName);
  const partPath = `${targetPath}.part`;

  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(downloadUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const contentLength = Number(res.headers.get('content-length') ?? 0);
  let done = 0;

  const fileStream = createWriteStream(partPath);
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);

  source.on('data', (chunk: Buffer) => {
    done += chunk.length;
    if (contentLength > 0 && options?.onProgress) {
      const percent = Math.min(100, Math.round((done / contentLength) * 100));
      options.onProgress({ done, total: contentLength, percent });
    }
  });

  await pipeline(source, fileStream);

  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
  renameSync(partPath, targetPath);

  return targetPath;
}
