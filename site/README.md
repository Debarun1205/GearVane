# Waypoint website

A static marketing site. No build step, no framework, no dependencies: it
deploys to any static host by copying this directory.

## Deploy

### GitHub Pages

One prerequisite, which is a repository setting rather than a code change:

1. Open **Settings → Pages**
2. Under **Build and deployment**, set **Source** to **GitHub Actions**

Until that is set, the `Deploy site` workflow fails at the
`actions/configure-pages` step. The site itself builds fine; only the upload
step needs the setting. Enabling it requires admin rights on the repository,
so it cannot be done from a fine-grained token.

After enabling, pushes to `master` publish `site/` automatically.

### Any other static host

```bash
# No build step: copy the directory
cp -r site/* /path/to/public/

# Netlify, Vercel, Cloudflare Pages, S3: publish directory is site/
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole page |
| `assets/styles.css` | Styles |
| `assets/demos.js` | Demo prompts plus tab behaviour |

## No builder on this site

Prompt-driven building needs a model call, and a static page has no backend
to make one from and no safe place to keep a credential. A token in browser
JavaScript is a token shipped to every visitor, so this site does not ask for
one and cannot hold one. Building lives in the desktop app and IDE, where a
key stays in the environment and files land on disk.

An earlier version of this page had a template form that downloaded a zip. It
was removed because forms are not vibe-coding: without a model behind them
they cannot respond to a prompt, and keeping them would imply the site builds
apps when it cannot.

## Keeping it honest

`tests/site.test.ts` asserts the site matches reality rather than intent:

- Every demo prompt is routed through the real classifier and must produce
  the tier the page claims. If routing changes, the page fails to build
  rather than quietly making a false claim.
- External links must carry `rel="noopener"`, and no third-party resources
  or analytics may be added.
- There must be no inline scripts, and the demo DOM must not use string
  interpolation for markup.
- The FAQ must keep answering the questions it does, and the maturity
  caveats (alpha, unevaluated learned classifier, no sandboxing) must stay
  on the page.
- The version history may only mention versions that were really tagged, and
  the about section must keep stating that the project is not production
  ready and not a sandbox.
- Nothing may claim the builds are signed. They are not.
- The canonical URL must point at the host that actually serves the site.

## Sections

| Anchor | Section |
|--------|---------|
| `#top` | Hero |
| `#how` | How it works: classify, run, escalate |
| `#tiers` | The three tiers and their relative cost |
| `#demos` | Worked routing decisions |
| `#download` | Per-platform downloads, plus install-from-source tabs |
| `#versions` | Version history: what shipped and what was still broken |
| `#about` | What the project is, why, how it is built, what it is not |
| `#faq` | Ten questions people actually ask |

## Download links

Each platform card links **straight at its artifact** on the versioned tag,
rather than at the generic releases page, so a visitor does not have to pick
the right file out of a list themselves.

That means the URLs are hard-coded and will go stale at the next version bump.
A test is the guard: `tests/site.test.ts` cross-checks every linked filename
against the assets actually published, and fails if the page links a file that
does not exist. When a release is cut, bump the tag in the links and the
version section together.

## Version history

The version history lists **only versions that were actually tagged**. v0.2.0 is
the first and only release; work before it was developed without tags, so the
page says so rather than inventing earlier versions. A test asserts that no
version number appears on the page which is not a real release, so the section
cannot quietly become fiction.

Each entry pairs what shipped with the known limitations of that version,
including the unsigned binaries and the unevaluated learned classifier. A
changelog that lists only the wins is marketing, not history.