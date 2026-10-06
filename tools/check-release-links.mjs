/**
 * Check every published download link against the real release.
 *
 *   node tools/check-release-links.mjs
 *
 * Reads the asset names GitHub actually has for the newest tag and compares
 * them with the names linked from README.md and site/index.html. Exits
 * non-zero on a mismatch.
 *
 * ## Why this cannot be a unit test
 *
 * The asset names are not derivable from the repository. v0.3.0 was built
 * before the Waypoint-to-GearVane rename, so its files still carry the old
 * product name, and the links had been written from package.json - which says
 * GearVane. That left seven of eight download buttons as 404s while the whole
 * test suite stayed green, because the test compared the links against a list
 * generated from the same wrong source.
 *
 * A test can pin the current names, which it now does, but only something
 * that asks GitHub can notice that the next release renamed them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_SLUG = 'Debarun1205/GearVane';

const LINK_SOURCES = ['README.md', join('site', 'index.html')];

const LINK_PATTERN = /releases\/download\/v[\d.]+\/([^"'\s)]+)/g;

// Failures set process.exitCode rather than calling process.exit: an
// abrupt exit tears the event loop down mid-flight, which crashes libuv
// on Windows and reports a signal death instead of a clean failure.
// A red run should mean 'the links are broken', nothing else.

/** Every release asset name GitHub currently holds, keyed by tag. */
async function publishedAssets() {
  const response = await fetch(
    `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=20`,
    {
      headers: {
        // Unauthenticated is enough for public release metadata and keeps this
        // runnable locally without a token. The rate limit is 60/hour per IP,
        // and this makes exactly one request.
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gearvane-link-check',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`releases API returned HTTP ${response.status}`);
  }

  const releases = await response.json();
  const byTag = new Map();
  for (const release of releases) {
    if (release.draft) continue;
    byTag.set(release.tag_name, new Set(release.assets.map((a) => a.name)));
  }
  return byTag;
}

/** Links grouped by the tag they point at. */
function linksByTag() {
  const byTag = new Map();
  for (const source of LINK_SOURCES) {
    const text = readFileSync(join(REPO, source), 'utf8');
    for (const match of text.matchAll(
      new RegExp(LINK_PATTERN.source, 'g'),
    )) {
      const whole = match[0];
      const name = match[1];
      const tag = whole.split('/')[whole.split('/').indexOf('download') + 1];
      const key = tag ?? '';
      const entries = byTag.get(key) ?? [];
      entries.push({ source, name });
      byTag.set(key, entries);
    }
  }
  return byTag;
}

async function main() {
  let published;
  try {
    published = await publishedAssets();
  } catch (error) {
    // A network failure is not evidence of a broken link, and failing the
    // scheduled run on it would train everyone to ignore this job.
    console.warn(`could not read the releases API: ${error.message}`);
    console.warn('skipping; run locally with network access to verify');
    return;
  }

  const links = linksByTag();
  if (links.size === 0) {
    console.error('no release download links found in README.md or site/index.html');
    process.exitCode = 1;
    return;
  }

  const problems = [];
  let checked = 0;

  for (const [tag, entries] of links) {
    const assets = published.get(tag);
    if (!assets) {
      problems.push(`${tag}: no such release, or it is a draft`);
      continue;
    }
    for (const { source, name } of entries) {
      checked += 1;
      if (!assets.has(name)) {
        problems.push(
          `${source} links ${tag}/${name}, which the release does not publish`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error('broken download links:\n  ' + problems.join('\n  '));
    console.error(
      '\nNote: an artifact built before a product rename keeps the old name in\n' +
        'its filename. Check the releases API before editing a link by hand.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `all ${checked} download link(s) across ${links.size} tag(s) resolve to ` +
      'published assets',
  );
}

await main();