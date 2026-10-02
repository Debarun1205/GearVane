# Waypoint website

A static marketing site. No build step, no framework, no dependencies: it
deploys to any static host by copying this directory.

## Deploy

```bash
# Any static host
cp -r site/* /path/to/public/

# GitHub Pages
gh-pages -d site

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