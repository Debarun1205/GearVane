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
    ['faq', 'FAQ'],
  ])('has the %s section', (id, heading) => {
    expect(html).toMatch(new RegExp(`id="${id}"`));
    expect(html).toMatch(new RegExp(`>${heading}<`));
  });

  it('links every section from the header', () => {
    for (const anchor of ['#how', '#tiers', '#demos', '#download', '#faq']) {
      expect(html).toContain(`href="${anchor}"`);
    }
  });

  it('covers all three platforms', () => {
    expect(html).toMatch(/>Windows</);
    expect(html).toMatch(/>Linux</);
    expect(html).toMatch(/>macOS</);
    expect(html).toMatch(/>Android</);
  });
});

describe('downloads', () => {
  it('links every platform to the releases page', () => {
    const links = html.match(/href="https:\/\/github\.com\/[^"]*\/releases"/g) ?? [];
    // Four platform cards, each with a download link.
    expect(links.length).toBeGreaterThanOrEqual(4);
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
    expect(html).toMatch(/signing keys/i);
    expect(html).toMatch(/Gatekeeper|SmartScreen/);
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