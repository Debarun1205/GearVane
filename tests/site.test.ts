import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TaskClassifier } from '@waypoint/core';

const REPO = join(import.meta.dirname, '..');
const SITE = join(REPO, 'site');
const ASSETS = join(SITE, 'assets');

const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const html = read(SITE, 'index.html');
const demos = read(ASSETS, 'demos.js');
const css = read(ASSETS, 'styles.css');

/**
 * The HTML with runs of whitespace collapsed to single spaces.
 *
 * Source prose is wrapped across lines for readability, so a phrase like
 * "not production-ready" can straddle a line break in the markup. Assertions
 * about wording should match what a reader sees, not how the file happens to
 * be formatted, so they run against this rather than the raw source.
 */
const prose = html.replace(/\s+/g, ' ');

describe('site structure', () => {
  it('has an entry point, stylesheet, and script', () => {
    expect(existsSync(join(SITE, 'index.html'))).toBe(true);
    expect(existsSync(join(ASSETS, 'styles.css'))).toBe(true);
    expect(existsSync(join(ASSETS, 'demos.js'))).toBe(true);
  });

  it('links the stylesheet and script', () => {
    expect(html).toMatch(/href="\.\/assets\/styles\.css"/);
    expect(html).toMatch(/src="\.\/assets\/demos\.js"/);
  });

  it('needs no build step', () => {
    // A static site deploys to any host and has no toolchain to keep current.
    expect(existsSync(join(SITE, 'package.json'))).toBe(false);
    expect(existsSync(join(SITE, 'node_modules'))).toBe(false);
  });

  it('has a title and meta description', () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/name="description"/);
  });

  it('declares a viewport for phones', () => {
    expect(html).toMatch(/name="viewport"[^>]*width=device-width/);
  });

  it('has a skip link and a main landmark', () => {
    expect(html).toMatch(/class="skip-link"/);
    expect(html).toMatch(/<main id="main">/);
  });
});

describe('sections', () => {
  it.each([
    ['how', 'How it works'],
    ['tiers', 'Tiers'],
    ['demos', 'See it decide'],
    ['download', 'Download'],
    ['versions', 'Version history'],
    ['about', 'About Waypoint'],
    ['faq', 'FAQ'],
  ])('has the %s section', (id, heading) => {
    expect(html).toMatch(new RegExp(`id="${id}"`));
    expect(html).toMatch(new RegExp(`>${heading}<`));
  });

  it('links every section from the header', () => {
    for (const anchor of [
      '#how',
      '#tiers',
      '#demos',
      '#download',
      '#versions',
      '#about',
      '#faq',
    ]) {
      expect(html).toContain(`href="${anchor}"`);
    }
  });

  it('covers all four platforms', () => {
    expect(html).toMatch(/>Windows</);
    expect(html).toMatch(/>Linux</);
    expect(html).toMatch(/>macOS</);
    expect(html).toMatch(/>Android</);
  });
});

describe('version history', () => {
  it('lists only versions that were actually released', () => {
    // The versions named on the page must exist as GitHub releases. A history
    // entry for a version that was never tagged would be fiction.
    const mentioned = new Set(
      [...html.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((match) => match[1] ?? ''),
    );

    // v0.2.0 is the only tagged release; see tests/site.test.ts notes.
    expect([...mentioned].sort()).toEqual(['0.2.0']);
  });

  it('states plainly that this is the first release', () => {
    // Without this a single-entry history reads as if entries were lost.
    expect(prose).toMatch(/only tagged release so far/i);
  });

  it('pairs each version with what shipped and what was broken', () => {
    expect(html).toMatch(/In this release/);
    expect(html).toMatch(/Known limitations/);
  });

  it('repeats the unsigned and debug-signed caveats in the history', () => {
    // A changelog that omits the caveats is marketing, not history.
    expect(html).toMatch(/<strong>unsigned<\/strong>/i);
    expect(prose).toMatch(/debug-signed/i);
    expect(prose).toMatch(/unevaluated against production traffic/i);
  });

  it('links the release notes for the version it lists', () => {
    expect(html).toContain(
      'https://github.com/Debarun1205/Waypoint/releases/tag/v0.2.0',
    );
  });

  it('uses a machine-readable date', () => {
    expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}"/);
  });
});

describe('about', () => {
  it('says what the project is, why, how, and what it is not', () => {
    for (const heading of [
      'What it is',
      'Why it exists',
      'How it is built',
      'What it is not',
    ]) {
      expect(html).toMatch(new RegExp(`>${heading}<`));
    }
  });

  it('states the license', () => {
    expect(html).toMatch(/<dt>License<\/dt>\s*<dd>MIT<\/dd>/);
  });

  it('does not overstate readiness', () => {
    // The about section is where a reader decides whether to trust the
    // project, so an unqualified "production ready" here would be the most
    // damaging possible claim.
    expect(prose).toMatch(/not production-ready/i);
    expect(prose).not.toMatch(/production[- ]ready\.(?!It is not)/i);
  });

  it('admits it is not a sandbox', () => {
    expect(prose).toMatch(/not a sandbox/i);
  });
});

describe('downloads', () => {
  it('links every platform straight to a real release asset', () => {
    // Regression: these pointed at the generic releases page, so a visitor
    // had to find the right file themselves. Now each card resolves to an
    // actual artifact on a versioned tag.
    const assetLinks = html.match(
      /href="https:\/\/github\.com\/Debarun1205\/Waypoint\/releases\/download\/v[\d.]+\/[^"]+"/g,
    ) ?? [];

    expect(assetLinks.length).toBeGreaterThanOrEqual(4);
    for (const link of assetLinks) {
      // A link to a directory or the tag page is not a download.
      expect(link).toMatch(/\.(exe|AppImage|dmg|apk|deb|vsix)"/);
    }
  });

  it('covers every platform the release publishes', () => {
    // The exact asset names from the v0.2.0 release. If a future release
    // renames one of these, this test is what should notice.
    const published = [
      'Waypoint.Setup.0.2.0.exe',
      'Waypoint.0.2.0.exe',
      'Waypoint-0.2.0.dmg',
      'Waypoint-0.2.0-arm64.dmg',
      'Waypoint-0.2.0.AppImage',
      'waypoint-app_0.2.0_amd64.deb',
      'waypoint-app_0.2.0_arm64.deb',
      'app-debug.apk',
    ];

    const linked = new Set(
      [...html.matchAll(/\/releases\/download\/v[\d.]+\/([^"]+)"/g)].map(
        (match) => match[1] ?? '',
      ),
    );

    // Every platform gets a link; not every artifact needs its own button,
    // but nothing may be linked that was never published.
    for (const asset of linked) {
      expect(published).toContain(asset);
    }

    expect(linked.size).toBeGreaterThanOrEqual(4);
    for (const platform of ['.exe', '.AppImage', '.dmg', '.apk']) {
      expect([...linked].some((asset) => asset.endsWith(platform))).toBe(true);
    }
  });

  it('opens external links safely', () => {
    // Match whole anchor tags so the rel check applies to each one.
    const anchors = html.match(/<a\b[^>]*href="https:\/\/[^"]*"[^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);

    for (const anchor of anchors) {
      expect(anchor).toMatch(/rel="noopener"/);
      expect(anchor).not.toMatch(/target="_blank"(?![^>]*rel="noopener")/);
    }
  });

  it('states that binaries are unsigned', () => {
    // A download button that quietly ships an unsigned binary sets the wrong
    // expectation; the caveat has to be on the page.
    expect(html).toMatch(/not code signed/i);
    expect(html).toMatch(/Gatekeeper|SmartScreen/);
    expect(html).toMatch(/debug-signed/i);
  });

  it('never claims the builds are signed', () => {
    // Regression: the page asserted 'Signed installers are produced by CI on
    // each release tag', which was false. No signing certificate exists in
    // this project, so any claim of signed artifacts is a lie.
    expect(html).not.toMatch(/signed installers are produced/i);
    expect(html).not.toMatch(/code[- ]signed builds? (are|is) available/i);
    expect(html).not.toMatch(/fully signed/i);
  });

  it('does not describe the macOS build as universal', () => {
    // There is no universal binary; Intel and Apple Silicon ship separately.
    expect(prose).not.toMatch(/universal\s+\.dmg/i);
  });

  it('does not claim a canonical URL the project does not control', () => {
    // Regression: the canonical pointed at waypoint.dev, a domain this
    // project does not own. Search engines would have been told to index a
    // URL that is not the site being served.
    const canonical = html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
    expect(canonical).toBeDefined();
    expect(canonical).not.toMatch(/waypoint\.dev/);
    expect(canonical).toMatch(/^https:\/\/debarun1205\.github\.io\/Waypoint\/?$/);
  });
});

describe('faq', () => {
  it('has at least eight questions', () => {
    const items = html.match(/<details class="faq-item">/g) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(8);
  });

  it('answers the questions people actually ask', () => {
    const summaries = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map(
      (match) => (match[1] ?? '').toLowerCase(),
    );

    for (const topic of [
      'api key',
      'stored',
      'offline',
      'accurate',
      'fails',
      'cost',
      'push code',
      'providers',
    ]) {
      expect(summaries.some((text) => text.includes(topic))).toBe(true);
    }
  });

  it('does not overstate the project', () => {
    // Honest maturity claims matter more than flattering ones.
    expect(html).toMatch(/alpha/i);
    expect(html).toMatch(/not been evaluated against real/i);
  });

  it('says the app does not sandbox execution', () => {
    expect(html).toMatch(/does not sandbox/i);
  });
});

describe('demo prompts', () => {
  it('includes a prompt for every tier', () => {
    for (const tier of ['local', 'mid', 'frontier']) {
      expect(demos).toMatch(new RegExp(`tier: '${tier}'`));
    }
  });

  it('includes at least eight demos', () => {
    const ids = [...demos.matchAll(/id: '([a-z-]+)'/g)];
    expect(ids.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every demo a prompt and a reason', () => {
    const prompts = [...demos.matchAll(/prompt:\s*'([^']*)'/g)].map((m) => m[1]);
    const reasons = [...demos.matchAll(/reason: '([^']*)'/g)].map((m) => m[1]);

    expect(prompts.length).toBeGreaterThanOrEqual(8);
    expect(reasons.length).toBeGreaterThanOrEqual(8);
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(10);
  });

  it('routes each demo to the tier the site claims', () => {
    // The page advertises specific routing outcomes. If the engine disagrees,
    // the marketing copy is wrong. Note the field order: tier precedes prompt.
    const classifier = new TaskClassifier();
    const entries = [...demos.matchAll(
      /tier: '([a-z]+)',[\s\S]*?prompt:\s*\n?\s*'([^']*)'/g,
    )];

    expect(entries.length).toBeGreaterThanOrEqual(8);

    const mismatches: string[] = [];
    for (const [, tier, prompt] of entries) {
      const result = classifier.classify({
        description: prompt ?? '',
        filesTouched: [],
        errorLoops: 0,
        testFailures: 0,
      });
      if (result.tier !== tier) {
        mismatches.push(`site says ${tier}, engine says ${result.tier}: ${prompt}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('builds the demo DOM without innerHTML', () => {
    // Text from the demo file must never be interpolated into markup.
    expect(demos).not.toMatch(/innerHTML/);
    expect(demos).toMatch(/textContent/);
  });
});

describe('files served to the browser', () => {
  it('parses demos.js as JavaScript', async () => {
    // Regression: demos.js shipped with TypeScript annotations (`: void`,
    // `<HTMLButtonElement>`, `as X`). Browsers cannot parse those, so the
    // module threw a SyntaxError and the "See it decide" section rendered
    // empty on the live site. Every other demo assertion read the file as
    // text, so nothing noticed: eight prompts were in the file and none were
    // ever displayed.
    //
    // Importing it is what makes that class of bug fail the build.
    const module = await import('../site/assets/demos.js');

    expect(Array.isArray(module.DEMOS)).toBe(true);
    expect(module.DEMOS.length).toBeGreaterThanOrEqual(8);
  });

  it('carries no TypeScript-only syntax in browser-served JavaScript', () => {
    // A belt-and-braces guard that does not depend on the bundler used by the
    // test runner. These are the constructs that have actually appeared here.
    const code = demos
      // Comments are documentation, not code, and mention the syntax.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/:\s*void\b/);
    expect(code).not.toMatch(/\bas\s+[A-Z][A-Za-z]*\b/);
    expect(code).not.toMatch(/<[A-Z][A-Za-z]*>\(/);
    expect(code).not.toMatch(/\binterface\s+\w+/);
    expect(code).not.toMatch(/^\s*(export\s+)?type\s+\w+\s*=/m);
  });
});

describe('accessibility', () => {
  it('labels the install tabs as a tablist', () => {
    expect(html).toMatch(/role="tablist"/);
    expect(html).toMatch(/role="tab"/);
    expect(html).toMatch(/role="tabpanel"/);
  });

  it('marks exactly one tab selected initially', () => {
    const selected = html.match(/aria-selected="true"/g) ?? [];
    expect(selected.length).toBe(1);
  });

  it('hides the inactive panels', () => {
    const hidden = html.match(/role="tabpanel"[^>]*hidden/g) ?? [];
    expect(hidden.length).toBeGreaterThanOrEqual(2);
  });

  it('gives every navigation a label', () => {
    const navs = html.match(/<nav[^>]*>/g) ?? [];
    expect(navs.length).toBeGreaterThanOrEqual(2);
    for (const nav of navs) {
      expect(nav).toMatch(/aria-label="/);
    }
  });
});

describe('security and hygiene', () => {
  it('uses no inline scripts', () => {
    expect(html).not.toMatch(/<script>[^<]/);
    expect(html).not.toMatch(/on(click|load|error)=/i);
  });

  it('loads no third-party resources', () => {
    // No analytics, no CDN fonts: the page must work offline and must not
    // phone home.
    expect(html).not.toMatch(/googletagmanager|google-analytics|plausible/);
    expect(html).not.toMatch(/https:\/\/fonts\./);
    expect(css).not.toMatch(/@import url\(/);
  });

  it('embeds no credential', () => {
    for (const text of [html, demos, css]) {
      expect(text).not.toMatch(/sk-ant-/);
      expect(text).not.toMatch(/ghp_/);
      expect(text).not.toMatch(/github_pat_/);
    }
  });

  it('leaves no placeholder text', () => {
    for (const text of [html, demos, css]) {
      expect(text).not.toMatch(/TODO|FIXME|Lorem ipsum|XXX/);
    }
  });
});

describe('styling', () => {
  it('respects reduced-motion preferences', () => {
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it('defines a visible focus style', () => {
    expect(css).toMatch(/:focus-visible/);
  });

  it('adapts to narrow viewports', () => {
    expect(css).toMatch(/@media \(max-width/);
  });

  it('is ASCII-safe so it renders in any console', () => {
    for (const text of [html, demos, css]) {
      const offenders = [...text].filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
      expect(offenders).toEqual([]);
    }
  });
});