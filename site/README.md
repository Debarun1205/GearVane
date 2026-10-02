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

## Download links

The download buttons point at the GitHub releases page rather than direct
file URLs, because artifact filenames change per version and a hard-coded
URL would rot silently. A release workflow publishes one artifact per
platform per tag.