/**
 * Sample prompts shown in the app and on the website.
 *
 * Each one demonstrates a routing decision rather than a generic "hello
 * world", so a new user can see why the tier changed. Kept here so the app,
 * the site, and the tests all read the same list and cannot drift.
 */

export interface SamplePrompt {
  id: string;
  title: string;
  prompt: string;
  /** Tier the classifier is expected to choose, used by a test. */
  expectedTier: 'local' | 'mid' | 'frontier';
  /** One line on why that tier is expected. */
  why: string;
}

export const SAMPLE_PROMPTS: readonly SamplePrompt[] = [
  {
    id: 'readme-typo',
    title: 'Fix a typo',
    prompt: 'Fix the typo in the second paragraph of README.md',
    expectedTier: 'local',
    why: 'One small edit. A local coder model handles this for free.',
  },
  {
    id: 'rename-symbol',
    title: 'Rename a symbol',
    prompt: 'Rename the user_id variable to accountId across this file',
    expectedTier: 'local',
    why: 'Mechanical rename with a clear scope.',
  },
  {
    id: 'add-endpoint',
    title: 'Add an API endpoint',
    prompt:
      'Add a paginated GET endpoint for listing user activity, wired to the existing router and tests',
    expectedTier: 'mid',
    why: 'Touches routing, a service, and tests, but the shape is known.',
  },
  {
    id: 'write-tests',
    title: 'Write tests for a function',
    prompt: 'Write unit tests for the parseConfig function covering malformed input',
    expectedTier: 'mid',
    why: 'Needs reasoning about edge cases without deep design work.',
  },
  {
    id: 'debug-race',
    title: 'Debug a race condition',
    prompt:
      'Investigate an intermittent race condition between the cache writer and the flush timer under load',
    expectedTier: 'frontier',
    why: 'Concurrency bugs need the strongest reasoning available.',
  },
  {
    id: 'design-architecture',
    title: 'Design an architecture',
    prompt:
      'Design the architecture for a multi-tenant billing system with per-tenant isolation and safe migrations',
    expectedTier: 'frontier',
    why: 'Architecture decisions are expensive to get wrong.',
  },
  {
    id: 'optimize-query',
    title: 'Optimize a slow query',
    prompt:
      'This query takes 4 seconds on 2M rows. Optimize it and explain the trade-offs',
    expectedTier: 'frontier',
    why: 'Performance work needs careful reasoning about access patterns.',
  },
  {
    id: 'format-code',
    title: 'Format and tidy',
    prompt: 'Fix the lint warnings in this file and remove the unused imports',
    expectedTier: 'local',
    why: 'Mechanical cleanup with no design decisions.',
  },
];

export function sampleById(id: string): SamplePrompt | undefined {
  return SAMPLE_PROMPTS.find((sample) => sample.id === id);
}

/** Samples grouped by the tier they are meant to demonstrate. */
export function samplesByTier(): Record<'local' | 'mid' | 'frontier', SamplePrompt[]> {
  const grouped: Record<'local' | 'mid' | 'frontier', SamplePrompt[]> = {
    local: [],
    mid: [],
    frontier: [],
  };
  for (const sample of SAMPLE_PROMPTS) grouped[sample.expectedTier].push(sample);
  return grouped;
}