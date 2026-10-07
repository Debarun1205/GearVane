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
    expect(existsSync(join(ASSETS, 'catalog.js'))).toBe(true);
    expect(existsSync(join(ASSETS, 'catalog-data.js'))).toBe(true);
    expect(existsSync(join(ASSETS, 'playground.js'))).toBe(true);
    expect(existsSync(join(ASSETS, 'engine.js'))).toBe(true);
  });

  it('links the stylesheet and script', () => {
    expect(html).toMatch(/href="\.\/assets\/styles\.css"/);
    expect(html).toMatch(/src="\.\/assets\/demos\.js"/);
    expect(html).toMatch(/src="\.\/assets\/catalog\.js"/);
    expect(html).toMatch(/src="\.\/assets\/playground\.js"/);
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
    ['playground', 'Ask the router yourself'],
    ['models', 'Every model, in full'],
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
      '#playground',
      '#models',
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

  it('claims verification with its actual limits', () => {
    // This flipped when verification shipped: the page used to promise nothing
    // and then disclaim it. It now claims the capability, and the limits are
    // asserted individually - opt-in, per run, CLI-only, unknown reported as
    // unknown - because a visitor deciding whether to trust the tool is exactly
    // the audience those qualifications are for.
    expect(prose).toContain('Check the answer, not just the request');
    expect(prose).toMatch(/retried on a stronger tier, with the failure\s+output handed to the next attempt/);
    expect(prose).toMatch(/--verify "npm test"/);

    // The limits, named rather than implied.
    expect(prose).toMatch(/Verification is opt-in and per run/);
    expect(prose).toMatch(/only the CLI offers it/);
    // `prose` is the HTML with whitespace collapsed, not tag-stripped, so the
    // inline <code> sits between the words it wraps.
    expect(prose).toMatch(
      /<code>unknown<\/code>\s+rather than being counted as a pass or a\s+failure/,
    );
    expect(prose).toMatch(/same safety gate/);

    // And the older signal still exists, so the page does not imply the error
    // path was replaced rather than added to.
    expect(prose).toMatch(/Errors and timeouts still escalate on their own/);
    expect(prose).not.toMatch(/does not yet run your tests/);
    expect(prose).not.toMatch(/escalation on an <em>error<\/em>, not on a verified/);
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
  // The asset names published on the v0.3.0 tag, read from the releases API.
  //
  // They say Waypoint because v0.3.0 was built before the rename: the
  // productName in package.json changed afterwards, but these artifacts were
  // already cut, so the filenames still carry the old name. The previous
  // version of this list was written from package.json instead of from the
  // release, which meant it asserted GearVane-* assets that never existed -
  // and every download button but the APK was a 404, with this test green
  // throughout. Do not "correct" these back to the product name.
  const published = [
    'Waypoint.Setup.0.3.0.exe',
    'Waypoint.0.3.0.exe',
    'Waypoint-0.3.0.dmg',
    'Waypoint-0.3.0-arm64.dmg',
    'Waypoint-0.3.0.AppImage',
    'waypoint-app_0.3.0_amd64.deb',
    'waypoint-app_0.3.0_arm64.deb',
    'app-debug.apk',
  ];

  function linkedAssets(): string[] {
    return [
      ...html.matchAll(/\/releases\/download\/v[\d.]+\/([^"]+)"/g),
    ].map((match) => match[1] ?? '');
  }

  it('links every platform straight to a real release asset', () => {
    // Regression: these pointed at the generic releases page, so a visitor
    // had to find the right file themselves. Now each card resolves to an
    // actual artifact on a versioned tag.
    const links = linkedAssets();

    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const name of links) {
      // A link to a directory or the tag page is not a download.
      expect(name).toMatch(/\.(exe|AppImage|dmg|apk|deb|vsix)$/);
      // The guard that was missing: the filename must be one the tag actually
      // publishes, not merely one that looks right.
      expect(published, `link to unpublished asset: ${name}`).toContain(name);
    }
  });

  it('covers every platform the release publishes', () => {
    const linked = new Set(linkedAssets());

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

  it('never links a product name the tag does not publish', () => {
    // The specific failure, pinned so the next rename cannot reintroduce it:
    // a link built from the current productName, against artifacts cut before
    // the rename, is a 404 that a filename-shaped test will happily accept.
    const links = linkedAssets();
    const renamed = links.filter((name) => /^gearvane[-._]/i.test(name));
    expect(renamed).toEqual([]);
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
    // The app itself now states the limitation on its first screen, so the
    // user is not left inferring it from a missing button.
    expect(prose).toMatch(
      /app says so on its first screen rather than leaving you to work out why a button is missing/,
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

describe('the router playground', () => {
  // The whole point of the box is that it is the real engine, so the claims
  // pinned here are about provenance rather than appearance.
  it('runs the shipped classifier, not a reimplementation', async () => {
    const entry = await import('../site/assets/engine-entry.js');
    const { TaskClassifier } = await import('@gearvane/core');

    const cases = [
      { prompt: 'Fix the typo in the second paragraph of README.md', files: [] },
      { prompt: 'Investigate an intermittent race condition in the cache writer', files: [] },
      { prompt: 'Design the architecture for a multi-tenant billing system', files: ['billing.ts'] },
      { prompt: 'do something', files: [] },
    ];

    const classifier = new TaskClassifier();
    for (const testCase of cases) {
      const expected = classifier.classify({
        description: testCase.prompt,
        filesTouched: testCase.files,
        errorLoops: 0,
        testFailures: 0,
      });
      const actual = entry.route({
        prompt: testCase.prompt,
        filesTouched: testCase.files,
        errorLoops: 0,
        testFailures: 0,
      });

      // Same tier, same confidence, same reasons: the playground is a view,
      // not a second implementation that might drift from the first.
      expect(actual.tier, testCase.prompt).toBe(expected.tier);
      expect(actual.confidence, testCase.prompt).toBe(expected.confidence);
      expect(actual.reasons, testCase.prompt).toEqual(expected.reasons);
    }
  });

  it('ships an engine bundle that matches the source', async () => {
    const { execFileSync } = await import('node:child_process');
    // A playground running a stale classifier would demonstrate decisions the
    // app no longer makes, which is worse than having no playground.
    expect(() =>
      execFileSync('node', [join(REPO, 'tools', 'build-site-engine.mjs'), '--check'], {
        cwd: REPO,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('keeps the engine small enough to be honest about being tiny', () => {
    // Claiming a dependency-free engine and shipping a megabyte of it would
    // make the claim hollow. 8 KiB is the whole classifier and its defaults.
    const bytes = readFileSync(join(ASSETS, 'engine.js')).length;
    expect(bytes).toBeLessThan(64 * 1024);
  });

  it('makes no network request', () => {
    // The page promises nothing you type leaves it. Routing needs no I/O, so
    // any fetch here would contradict that.
    const playground = read(ASSETS, 'playground.js');
    expect(playground).not.toMatch(/\bfetch\s*\(/);
    expect(playground).not.toMatch(/XMLHttpRequest/);
    expect(playground).not.toMatch(/EventSource|navigator\.sendBeacon/);
  });

  it('says it routes rather than runs a model', () => {
    // A visitor could reasonably read a live box as "it does the work here".
    expect(prose).toMatch(/It routes; it does not run a model/);
    expect(prose).toMatch(/a token in browser JavaScript is a token shipped to every visitor/);
  });

  it('promises nothing is sent away', () => {
    expect(prose).toMatch(/Nothing you type leaves the page/);
  });

  it('carries no TypeScript-only syntax in the browser-served module', () => {
    // playground.js is served to the browser as-is, untranspiled, unlike
    // engine.js which esbuild compiles.
    const code = read(ASSETS, 'playground.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/:\s*(void|string|number|boolean)\b/);
    expect(code).not.toMatch(/\bas\s+[A-Z][A-Za-z]*\b/);
    expect(code).not.toMatch(/<[A-Z][A-Za-z]*>/);
  });

  it('shows the reasoning rather than only the verdict', () => {
    // "Reasons, not verdicts" is the claim; the panel has to match it.
    expect(html).toContain('play-output');
    expect(read(ASSETS, 'playground.js')).toMatch(/play-reasons/);
    expect(read(ASSETS, 'playground.js')).toMatch(/play-score/);
  });

  it('announces its output politely to assistive tech', () => {
    // The panel updates on every keystroke, so it must not interrupt a
    // screen reader mid-sentence.
    expect(html).toMatch(/id="play-output"[^>]*aria-live="polite"/);
  });

  it('labels both inputs', () => {
    expect(html).toMatch(/<label class="play-label" for="play-prompt">/);
    expect(html).toMatch(/<label class="play-label" for="play-files">/);
  });
});

describe('the model explorer', () => {
  // The table is generated from the app's catalog, so the guard against drift
  // is mechanical: same file, same bytes. A hand-typed fifty-row table would
  // silently go stale the first time someone added a model.
  it('ships catalog data that matches apps/desktop/src/models.json', async () => {
    const catalog = JSON.parse(
      readFileSync(join(REPO, 'apps', 'desktop', 'src', 'models.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    const generated = await import('../site/assets/catalog-data.js');

    expect(generated.MODELS).toHaveLength(catalog.length);

    const byId = new Map(catalog.map((entry) => [entry['id'] as string, entry]));
    for (const row of generated.MODELS) {
      const source = byId.get(row.id);
      expect(source, `catalog has no ${row.id}`).toBeDefined();
      expect(row.bytes).toBe(source?.['bytes']);
      expect(row.use).toBe(source?.['use']);
      expect(row.bundled).toBe(source?.['bundled'] === true);
      expect(row.license).toBe(source?.['license']);
      expect(row.licenseUrl).toBe(source?.['licenseUrl']);
    }
  });

  it('regenerates byte-identically, so --check can gate CI', async () => {
    const { execFileSync } = await import('node:child_process');
    // The generator exits non-zero when the committed file is stale, which is
    // the whole point of committing generated output into a no-build site.
    expect(() =>
      execFileSync('node', [join(REPO, 'tools', 'gen-site-catalog.mjs'), '--check'], {
        cwd: REPO,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('shows a licence for every row and links it', () => {
    const explorer = read(ASSETS, 'catalog.js');
    expect(explorer).toMatch(/licenseUrl/);
    expect(explorer).toMatch(/link\.href = row\.licenseUrl/);
    // External links from generated DOM need the same protection as the
    // hand-written ones.
    expect(explorer).toMatch(/link\.rel = 'noopener'/);
  });

  it('marks installed models with a word, not only a colour', () => {
    // Colour alone is not an accessible signal: it fails a monochrome
    // display and a screen reader equally.
    expect(html).toContain('in the installer');
    expect(read(ASSETS, 'catalog.js')).toMatch(/textContent = ' in the installer'/);
  });

  it('flags the RAM figures as prose rather than measurements', () => {
    // Two ways to be wrong here, both of which the earlier draft managed.
    //
    // Claiming RAM is absent would be false: 18 of the 50 "Good for" strings
    // carry a gigabyte figure. Presenting those figures as requirements would
    // also be false, and demonstrably so - qwen3-8b at 4.7 GiB claims 16 GB
    // while yi-1.5-34b at 19.2 GiB claims 32, which cannot both be true. So
    // the page names the inconsistency rather than hiding the column or
    // laundering the numbers.
    //
    // Both figures are re-derived from models.json here, so the disclosure
    // cannot go on citing a weight the catalog no longer carries.
    expect(prose).toMatch(/What this table does not tell you/);
    expect(prose).toMatch(/hand-written guidance,\s+not a computed requirement/);

    // The disclosure's example is derived from the live catalog, so replacing a
    // weight cannot leave the page quoting a model that is no longer offered.
    const catalog = JSON.parse(read(REPO, 'apps', 'desktop', 'src', 'models.json')) as Array<{
      id: string;
      bytes: number;
      use: string;
    }>;
    const claims = catalog
      .map((entry) => {
        const match = /(\d+(?:\.\d+)?)\s*(?:GB|GiB)\b/i.exec(entry.use);
        return match
          ? { id: entry.id, gib: entry.bytes / 1073741824, claim: Number(match[1]) }
          : null;
      })
      .filter((row): row is { id: string; gib: number; claim: number } => row !== null);
    expect(claims.length).toBeGreaterThan(0);

    // The worst ratio against file size, and the best among the large files.
    const worst = claims.reduce((a, b) => (a.claim / a.gib > b.claim / b.gib ? a : b));
    const big = claims.filter((row) => row.gib > 15);
    expect(big.length).toBeGreaterThan(0);
    const bestBig = big.reduce((a, b) => (a.claim / a.gib < b.claim / b.gib ? a : b));

    const size = (gib: number) => `${gib < 10 ? gib.toFixed(1) : Math.round(gib)} GB`;
    expect(prose).toContain(
      `a ${size(worst.gib)} weight claims ${worst.claim} GB of RAM while a ` +
        `${size(bestBig.gib)} one claims ${bestBig.claim}.`,
    );

    expect(prose).toMatch(/Tokens per second is absent entirely/);
    expect(prose).not.toMatch(/RAM\s+requirements and tokens per second are absent/);
    // The app measures rather than reading the column. Claiming it does not
    // would be the reverse error: hardware detection now exists, so the page
    // would be describing a superseded app.
    expect(prose).toMatch(/does not decide anything from those numbers/);
    expect(prose).toMatch(/memory-mapped/);
    expect(prose).toMatch(/1\.3x overhead factor/);
    expect(prose).not.toMatch(/hardware manager lands/);
    // No invented columns in the data either.
    expect(read(ASSETS, 'catalog.js')).not.toMatch(/tokensPerSecond|estimatedRam|minRam/);
  });

  it('builds the table without innerHTML', () => {
    // Same rule as the demo list: ids, use strings, and URLs all come from a
    // JSON file, so none of them may reach the DOM as markup. Comments are
    // stripped first, because this file explains at length that it does not
    // use innerHTML, and the word legitimately appears there.
    const explorer = read(ASSETS, 'catalog.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(explorer).not.toMatch(/innerHTML/);
    expect(explorer).toMatch(/textContent/);
  });

  it('carries no TypeScript-only syntax in the explorer modules', () => {
    for (const file of ['catalog.js', 'catalog-data.js']) {
      const code = read(ASSETS, file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/:\s*(void|string|number|boolean)\b/);
      expect(code).not.toMatch(/\bas\s+[A-Z][A-Za-z]*\b/);
      expect(code).not.toMatch(/^\s*(export\s+)?type\s+\w+\s*=/m);
    }
  });

  it('does not derive a tier from the file size', async () => {
    // Regression: the first version of the explorer computed each tier from
    // the download size, on the assumption that was how GearVane tiers. It is
    // not - qwen3-8b is in frontier at 4.7 GB and eleven sub-2 GB weights are
    // in mid - so that approach disagreed with the app on 13 of the 36 routed
    // models. The tier is read from the config instead, and the guard is
    // tests/catalog-tiers.test.ts.
    const explorer = await import('../site/assets/catalog.js');
    expect((explorer as Record<string, unknown>)['tierForBytes']).toBeUndefined();
    const source = read(ASSETS, 'catalog.js');
    expect(source).not.toMatch(/function tierForBytes/);
    expect(source).toMatch(/tier: entry\.tier \?\? null/);
  });

  it('marks a weight no tier names as on request', async () => {
    // 14 of the 50 catalog weights are downloadable but absent from the
    // shipped tier lists. Calling them "on request" is honest; assigning them
    // a tier would be a classification the app does not perform.
    const explorer = await import('../site/assets/catalog.js');
    const rows = explorer.buildRows([
      { id: 'routed', bytes: 1e9, use: 'x', bundled: false, license: 'MIT', licenseUrl: 'https://e.com', tier: 'local' },
      { id: 'loner', bytes: 2e9, use: 'y', bundled: false, license: 'MIT', licenseUrl: 'https://e.com', tier: null },
    ]);
    const loner = rows.find((r: { id: string }) => r.id === 'loner');
    expect(loner?.tier).toBeNull();
  });

  it('shows real sizes rather than a placeholder', async () => {
    const explorer = await import('../site/assets/catalog.js');
    expect(explorer.formatGiB(428730240)).toBe('0.4 GiB');
    // Above 10 GB the decimal is noise.
    expect(explorer.formatGiB(72131051520)).toBe('67 GiB');
  });

  it('summarises the catalog from the data, not a typed sentence', async () => {
    const explorer = await import('../site/assets/catalog.js');
    const rows = explorer.buildRows([
      { id: 'a', bytes: 1073741824, use: 'x', bundled: true, license: 'MIT', licenseUrl: 'https://e.com', tier: 'local' },
      { id: 'b', bytes: 2147483648, use: 'y', bundled: false, license: 'Apache-2.0', licenseUrl: 'https://e.com', tier: null },
    ]);
    const summary = explorer.summaryLine(rows);
    expect(summary).toContain('2 weights');
    expect(summary).toContain('1 ship in the installer');
    // Both counts are derived, so the sentence cannot drift from the table.
    expect(summary).toContain('1 are in the default tiers');
    expect(summary).toContain('1 are downloadable and selectable on request');
  });

  it('sorts bundled weights first, then by size', async () => {
    const explorer = await import('../site/assets/catalog.js');
    const rows = explorer.buildRows([
      { id: 'frontier-big', bytes: 9e9, use: 'x', bundled: false, license: 'MIT', licenseUrl: 'https://e.com', tier: 'frontier' },
      { id: 'local-small', bytes: 1e9, use: 'x', bundled: false, license: 'MIT', licenseUrl: 'https://e.com', tier: 'local' },
      { id: 'bundled', bytes: 5e9, use: 'x', bundled: true, license: 'MIT', licenseUrl: 'https://e.com', tier: 'mid' },
      { id: 'loner', bytes: 2e9, use: 'x', bundled: false, license: 'MIT', licenseUrl: 'https://e.com', tier: null },
    ]);
    // Bundled first, then by tier, then by size; an untiered weight sinks to
    // the bottom rather than being interleaved as if it were local.
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      'bundled',
      'local-small',
      'frontier-big',
      'loner',
    ]);
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

  it('does not overclaim what the desktop app does with its feedback', () => {
    // Ground truth: the desktop app now records outcomes
    // (apps/desktop/src/feedback-host.ts), so the old "does not yet record
    // outcomes" apology was false. But only packages/cli/src/bin.ts calls
    // loadLearnedModel, so the app still routes on the heuristic. The page has
    // to say both halves: it collects, and it does not yet act.
    expect(html).not.toContain('Learns from outcomes');
    expect(html).not.toContain('does not yet record outcomes');
    expect(html).not.toContain('does not record');
    expect(prose).toMatch(/records every finished run/);
    // The limit is stated as plainly as the capability.
    expect(prose).toMatch(/Training and loading the learned model are still CLI-only/);
    expect(prose).toMatch(/routing stays on the heuristic/);
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