import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TaskClassifier } from '@gearvane/core';

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
    ['harness', 'Inside the harness'],
    ['download', 'Download'],
    ['versions', 'Version history'],
    ['about', 'About GearVane'],
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
      '#harness',
      '#download',
      '#versions',
      '#about',
      '#faq',
    ]) {
      expect(html).toContain(`href="${anchor}"`);
    }
  });

  it('describes tiers as size bands, not a capability ranking', () => {
    // Regression: the page called 7-8B local weights "frontier" next to
    // Claude Opus, which is a marketing risk the owner asked to avoid. The
    // labels stay (they are the internal ids) but the page now says what
    // they mean and states that capability tiering is not measured yet.
    expect(prose).toMatch(/Read those names as size bands/);
    expect(prose).toMatch(/the heaviest weights/);
    expect(prose).toMatch(/not a hosted frontier model/);
    expect(prose).toMatch(/provisional/);
  });

  it('no longer bills the local tiers', () => {
    // The catalog tiers are all downloadable weights served locally, so
    // every one of them is free. Only hosted models can cost money, and
    // the page says so.
    const costs = html.match(/<span class="tier-cost">([^<]+)<\/span>/g) ?? [];
    expect(costs.length).toBe(3);
    for (const cost of costs) {
      expect(cost).toContain('free');
    }
    expect(prose).toMatch(/the only tier that can cost you money/);
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

    // Every version named on the page must have a matching GitHub release.
    // v0.2.0 and v0.3.0 are both tagged; nothing else may appear.
    expect([...mentioned].sort()).toEqual(['0.2.0', '0.3.0']);
  });

  it('explains why there is no entry before v0.2.0', () => {
    // Without this a short history reads as if entries were lost.
    expect(prose).toMatch(/no earlier version to install/i);
  });

  it('says escalation happens on an error, not a verified failure', () => {
    // The orchestrator retries and escalates when a model call errors or
    // returns nothing usable. It does not run the user's tests to decide an
    // answer is wrong, so a page implying it does is claiming a capability
    // that does not exist. The step names the work as future rather than
    // shipping the implication.
    expect(prose).toContain('Escalate when a cheap model cannot answer');
    expect(prose).toMatch(/escalation on an <em>error<\/em>, not on a verified/);
    expect(prose).toMatch(/does not yet run your tests/);
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

  it('links the release notes for every version it lists', () => {
    for (const version of ['0.2.0', '0.3.0']) {
      expect(html).toContain(
        `https://github.com/Debarun1205/GearVane/releases/tag/v${version}`,
      );
    }
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
      /href="https:\/\/github\.com\/Debarun1205\/GearVane\/releases\/download\/v[\d.]+\/[^"]+"/g,
    ) ?? [];

    expect(assetLinks.length).toBeGreaterThanOrEqual(4);
    for (const link of assetLinks) {
      // A link to a directory or the tag page is not a download.
      expect(link).toMatch(/\.(exe|AppImage|dmg|apk|deb|vsix)"/);
    }
  });

  it('covers every platform the release publishes', () => {
    // The exact asset names from the v0.3.0 release. If a future release
    // renames one of these, this test is what should notice.
    const published = [
      'GearVane.Setup.0.3.0.exe',
      'GearVane.0.3.0.exe',
      'GearVane-0.3.0.dmg',
      'GearVane-0.3.0-arm64.dmg',
      'GearVane-0.3.0.AppImage',
      'gearvane-app_0.3.0_amd64.deb',
      'gearvane-app_0.3.0_arm64.deb',
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
    // Regression: the canonical pointed at gearvane.dev, a domain this
    // project does not own. Search engines would have been told to index a
    // URL that is not the site being served.
    const canonical = html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
    expect(canonical).toBeDefined();
    expect(canonical).not.toMatch(/gearvane\.dev/);
    expect(canonical).toMatch(/^https:\/\/debarun1205\.github\.io\/GearVane\/?$/);
  });
});

describe('platform claims are scoped to what ships', () => {
  it('claims the IDE on Android, and names the two real gaps', () => {
    // Ground truth, from apps/desktop/src/web-backend.ts: the IDE does mount
    // in the webview over a device-local workspace. What is genuinely
    // missing is the terminal (no shell) and file-changing Build mode (the
    // tool layer imports node:*). The page used to claim a "full" IDE,
    // which overclaimed, and the v0.3.0 notes claimed no IDE at all, which
    // was simply false. Both now say this.
    expect(prose).toContain('the same IDE');
    expect(prose).toContain('device-local workspace');
    expect(prose).not.toContain('full IDE on desktop and Android alike');
    expect(prose).toMatch(/no terminal, because a webview has no shell/);
    expect(prose).toMatch(/no file-changing Build mode/);
  });

  it('describes the Android build as the webview it is', () => {
    // The download card is where a phone visitor decides; it has to say
    // what the APK does and does not carry.
    expect(prose).toMatch(/run in a webview/);
    expect(prose).toMatch(/Ask-mode agent/);
    expect(prose).toMatch(/stored on the device/);
    expect(prose).toMatch(
      /There is no terminal, because a webview has no shell/,
    );
  });

  it('lists the Android scope among the known limitations', () => {
    // Regression: this used to say "no IDE, files, or terminal", which was
    // false. The webview backend mounts the whole IDE over a device-local
    // workspace, so a limitation list that denies it misinforms anyone
    // deciding whether to install on a phone.
    expect(html).toMatch(
      /Android runs the IDE in a webview over a device-local workspace, but has no terminal and no file-changing Build mode/,
    );
    expect(prose).not.toMatch(/no IDE, files, or terminal/);
  });

  it('answers the Android IDE question in the FAQ', () => {
    // The question a phone visitor actually has. The answer is "most of it",
    // not the unqualified "Yes" it used to open with, and it gives both
    // causes: no shell for the terminal, no Node for the file-changing tools.
    expect(prose).toContain('Does the Android build include the IDE?');
    expect(prose).toMatch(/device-local workspace/);
    expect(prose).toMatch(/webview has no shell to run/);
    expect(prose).toMatch(/cannot load in a browser/);
    // The old answer opened with a bare affirmative that overstated it.
    expect(prose).not.toMatch(/Does the Android build include the IDE\?\s*Yes\./);
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

describe('harness feature claims', () => {
  // The "Inside the harness" grid advertises capabilities in marketing
  // language. Each card is pinned here to the identifier that implements
  // it, the same way the demo tiers are pinned to the real classifier:
  // a claim the code cannot back is a failing test, not a review comment.
  const source = (...parts: string[]): string => read(join(REPO, ...parts));

  const claims: Array<[claim: string, file: string, pattern: RegExp]> = [
    ['escalation is bounded by configuration', 'packages/core/src/config.ts', /max_escalations/],
    ['the agent reads and writes files', 'packages/harness/src/tools/fs.ts', /name: 'write_file'/],
    ['the agent runs commands', 'packages/harness/src/tools/shell.ts', /name: 'run_command'/],
    ['the agent searches the workspace', 'packages/harness/src/tools/search.ts', /name: 'search_files'/],
    ['building scaffolds from templates', 'packages/harness/src/builder/agent-tools.ts', /scaffold_project|list_templates/],
    ['context budgets are real', 'packages/harness/src/index.ts', /Token budget for the conversation/],
    ['the IDE shows a Problems tab', 'apps/desktop/src/ide/ide-view.ts', /ide-problem-name/],
    ['the IDE has Ask and Build modes', 'apps/desktop/src/ide/ide-view.ts', /=== 'ask' \? 'ask' : 'build'/],
    ['the IDE reviews changes as a side-by-side diff', 'apps/desktop/src/ide/ide-view.ts', /side-by-side diff/],
    ['ghost text is registered', 'apps/desktop/src/ide/ide-view.ts', /registerGhostText/],
    ['the CLI can scaffold a project', 'packages/cli/src/harness-commands.ts', /gearvane build/],
    ['the CLI gates operations behind approval', 'packages/cli/src/bin.ts', /case 'approve'/],
    ['the CLI probes model health', 'packages/cli/src/bin.ts', /case 'health'/],
    ['the app surfaces health too', 'apps/desktop/src/renderer.ts', /showHealth/],
    ['the learned classifier trains from recorded feedback', 'packages/core/src/defaults.ts', /learned_model\.json/],
    ['training runs from recorded feedback', 'gearvane/learned_classifier.py', /train_from_feedback/],
    ['the app wires first-run onboarding', 'apps/desktop/src/renderer.ts', /openAppearance\('onboarding'\)/],
    ['the look is stored on the device', 'apps/desktop/src/renderer.ts', /appearanceStorage/],
  ];

  it.each(claims)('%s', (_claim, file, pattern) => {
    expect(source(...file.split('/'))).toMatch(pattern);
  });

  it('ships the five themes the page advertises', () => {
    const theme = source('apps', 'desktop', 'src', 'theme.ts');
    for (const id of ['midnight', 'aurora', 'nebula', 'ember', 'verdant']) {
      expect(theme).toContain(`id: '${id}'`);
    }
    const swatches = theme.match(/swatch: \[/g) ?? [];
    expect(swatches.length).toBeGreaterThanOrEqual(5);
  });

  it('runs the same renderer on Android', () => {
    // The page claims four surfaces running the same code. The Android
    // build is proof: Capacitor wraps this renderer directory verbatim.
    const capacitor = source('apps', 'desktop', 'capacitor.config.ts');
    expect(capacitor).toMatch(/webDir:\s*'renderer'/);
    expect(existsSync(join(REPO, 'apps', 'vscode-extension', 'package.json'))).toBe(true);
    expect(existsSync(join(REPO, 'packages', 'cli', 'src', 'bin.ts'))).toBe(true);
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

  it('does not claim the app learns from outcomes', () => {
    // Ground truth: recordRunFeedback is called from the CLI
    // (packages/cli/src/bin.ts) and nowhere in apps/, so the desktop app a
    // visitor downloads never learns anything. The card used to advertise
    // the capability outright.
    expect(html).not.toContain('Learns from outcomes');
    expect(prose).toMatch(/does not yet record outcomes, so it does not learn/);
    expect(prose).toMatch(/always routes on the heuristic/);
    // The capability that does ship is still claimed.
    expect(html).toContain('Reasons, not verdicts');
  });

  it('describes key storage the way the app now works', () => {
    // Regression: the FAQ said the vault "lives only on that device, in its
    // own storage", which described the old localStorage vault. It is now
    // encrypted by the OS secret store, and the page had to stop implying
    // plaintext is fine.
    expect(prose).toMatch(/encrypted by your operating system secret store/);
    expect(prose).toMatch(/DPAPI on Windows, Keychain on macOS/);
    expect(prose).toMatch(
      /the keys stay in memory for that session only/,
    );
    expect(prose).not.toContain('in its own storage;');
  });

  it('scopes spend ceilings to hosted models', () => {
    // Spend limits were removed for local models because they cost nothing.
    // Promising per-task/session/day ceilings without saying which tier they
    // apply to implies a cap on local runs that does not exist.
    expect(prose).toMatch(/a dollar ceiling on them would be meaningless/);
    expect(prose).toMatch(/Hosted models are the ones that bill you/);
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