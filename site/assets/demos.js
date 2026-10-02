/**
 * Demo prompts shown on the site.
 *
 * Kept in a plain data module rather than inline in the HTML so the same list
 * can be reused by the app and asserted by a test. The site loads this file
 * directly; the app imports the equivalent from @waypoint/app-core.
 *
 * `tier` is the tier the shipped classifier produces. A test runs every prompt
 * through the real classifier and requires the tier to match, so the marketing
 * copy cannot drift from the engine.
 *
 * This file is served to the browser as-is. It must therefore be valid
 * JavaScript with no type annotations: browsers do not understand `: void`,
 * and a stray annotation fails to parse silently, leaving the section empty.
 * tests/site.test.ts imports this module, so a syntax error fails the build.
 */

export const DEMOS = [
  {
    id: 'readme-typo',
    tier: 'local',
    cost: 'free',
    prompt: 'Fix the typo in the second paragraph of README.md',
    reason: 'One small edit. A local coder model handles this for free.',
  },
  {
    id: 'rename-symbol',
    tier: 'local',
    cost: 'free',
    prompt: 'Rename the user_id variable to accountId across this file',
    reason: 'Mechanical rename with a clear scope.',
  },
  {
    id: 'format-code',
    tier: 'local',
    cost: 'free',
    prompt: 'Fix the lint warnings in this file and remove the unused imports',
    reason: 'Mechanical cleanup with no design decisions.',
  },
  {
    id: 'add-endpoint',
    tier: 'mid',
    cost: '~$0.002',
    prompt:
      'Add a paginated GET endpoint for listing user activity, wired to the existing router and tests',
    reason: 'Touches routing, a service, and tests, but the shape is known.',
  },
  {
    id: 'write-tests',
    tier: 'mid',
    cost: '~$0.001',
    prompt: 'Write unit tests for the parseConfig function covering malformed input',
    reason: 'Needs reasoning about edge cases without deep design work.',
  },
  {
    id: 'debug-race',
    tier: 'frontier',
    cost: '~$0.06',
    prompt:
      'Investigate an intermittent race condition between the cache writer and the flush timer under load',
    reason: 'Concurrency bugs need the strongest reasoning available.',
  },
  {
    id: 'design-architecture',
    tier: 'frontier',
    cost: '~$0.15',
    prompt:
      'Design the architecture for a multi-tenant billing system with per-tenant isolation and safe migrations',
    reason: 'Architecture decisions are expensive to get wrong.',
  },
  {
    id: 'optimize-query',
    tier: 'frontier',
    cost: '~$0.05',
    prompt:
      'This query takes 4 seconds on 2M rows. Optimize it and explain the trade-offs',
    reason: 'Performance work needs careful reasoning about access patterns.',
  },
];

const TIER_LABEL = {
  local: 'local',
  mid: 'mid',
  frontier: 'frontier',
};

function render() {
  const container = document.getElementById('demo-list');
  if (!container) return;

  const fragment = document.createDocumentFragment();

  for (const demo of DEMOS) {
    const item = document.createElement('article');
    item.className = `demo demo-${demo.tier}`;

    const prompt = document.createElement('p');
    prompt.className = 'demo-prompt';
    prompt.textContent = demo.prompt;

    const meta = document.createElement('div');
    meta.className = 'demo-meta';

    // Built with DOM APIs rather than string concatenation, so no value from
    // this file can inject markup.
    const badge = document.createElement('span');
    badge.className = `demo-tier demo-tier-${demo.tier}`;
    badge.textContent = TIER_LABEL[demo.tier];

    const cost = document.createElement('span');
    cost.className = 'demo-cost';
    cost.textContent = demo.cost;

    meta.append(badge, cost);

    const reason = document.createElement('p');
    reason.className = 'demo-reason';
    reason.textContent = demo.reason;

    item.append(prompt, meta, reason);
    fragment.appendChild(item);
  }

  container.appendChild(fragment);
}

/** Tabs for the install snippets. */
function wireTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  if (tabs.length === 0) return;

  const show = (tab) => {
    for (const other of tabs) {
      const isActive = other === tab;
      other.classList.toggle('is-active', isActive);
      other.setAttribute('aria-selected', String(isActive));

      const panel = document.getElementById(other.dataset.panel ?? '');
      if (panel) {
        panel.hidden = !isActive;
        panel.classList.toggle('is-active', isActive);
      }
    }
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();

      const index = tabs.indexOf(tab);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      next?.focus();
      show(next);
    });
  }
}

/**
 * Wire the page up, but only where there is a page.
 *
 * The guard keeps this module importable from Node, which is what lets the
 * test suite execute it and catch a syntax error. In a browser `document`
 * always exists and the behaviour is unchanged.
 */
if (typeof document !== 'undefined') {
  render();
  wireTabs();
}