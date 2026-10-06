import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/defaults.js';
import { TierRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import {
  MAX_VERIFIER_DETAIL,
  retryPrompt,
  runVerifier,
  trimDetail,
  type VerificationResult,
} from '../src/verification.js';
import type { Completion, GearVaneConfig } from '../src/types.js';

/**
 * Verification-driven escalation: the claim the product is named for.
 *
 * Until this existed, execute() returned on the first completion that did not
 * throw. A confidently wrong answer from a cheap tier therefore ended the run
 * with success: true - a provider error was the only thing that could promote a
 * task, and a provider error says nothing about whether the answer was right.
 *
 * Each test below pins one specific way this could lie.
 */

const cfg = (): GearVaneConfig => {
  const base = defaultConfig();
  return {
    ...base,
    tiers: {
      local: {
        name: 'local',
        description: 'Local',
        providers: [{ name: 'ollama', models: ['llama3.2'], baseUrl: 'http://localhost:11434' }],
        maxRetries: 2,
        costPerToken: 0,
      },
      mid: {
        name: 'mid',
        description: 'Mid',
        providers: [{ name: 'openrouter', models: ['haiku'], baseUrl: 'https://openrouter.ai/api' }],
        maxRetries: 2,
        costPerToken: 0,
      },
      frontier: {
        name: 'frontier',
        description: 'Frontier',
        providers: [{ name: 'anthropic', models: ['claude'], baseUrl: 'https://api.anthropic.com' }],
        maxRetries: 3,
        costPerToken: 0,
      },
    },
    providers: { timeoutSeconds: 5, maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0 },
  };
};

const ok = (content = 'done'): Completion => ({
  content,
  model: 'm',
  usage: { tokensIn: 10, tokensOut: 20 },
  finishReason: 'stop',
  toolCalls: [],
});

class FakeClient {
  calls: Array<Record<string, unknown>> = [];

  constructor(private readonly answers: string[] = ['done']) {}

  async complete(prompt: string, options?: Record<string, unknown>): Promise<Completion> {
    this.calls.push({ prompt, ...options });
    return ok(this.answers.shift() ?? 'done');
  }
}

describe('execute with no verifier', () => {
  it('behaves exactly as before and claims nothing', async () => {
    // The honest default. A fresh install gains no verification it cannot back,
    // so the result must not carry a verdict at all - absent, not `pass`.
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient() });
    const result = await orch.execute('t1', 'fix a typo');

    expect(result.success).toBe(true);
    expect(result.verification).toBeUndefined();
    // And no attempt claims to have been checked.
    expect(result.history.every((a) => a.verified === undefined)).toBe(true);
  });
});

describe('execute with a verifier', () => {
  it('retries when the check fails and reports the retry, not the first answer', async () => {
    // The whole point. A wrong answer from the cheap tier must not end the run.
    // Note this is a retry first: the router promotes a tier after its
    // configured failure threshold, so the second attempt may still be local.
    // What matters here is that the failed answer is discarded, not returned.
    const client = new FakeClient(['wrong', 'right']);
    let calls = 0;
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => {
        calls += 1;
        return { outcome: calls === 1 ? 'fail' : 'pass' };
      },
    });

    expect(result.content).toBe('right');
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('routes a retry harder than the attempt that failed the check', async () => {
    // A failed check feeds the classifier's error-loop signal, so the retry is
    // scored as a harder task and lands on a stronger tier.
    //
    // Note this is NOT router.escalation, which is a separate mechanism keyed on
    // the configured failure threshold. The distinction matters: `escalated` on
    // the result stays false here because the tier moved by classification, and
    // asserting otherwise would describe the code inaccurately.
    const tiers: string[] = [];
    const client = new FakeClient(['a', 'b', 'c']);
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: (_content, context) => {
        tiers.push(context.tier);
        return { outcome: 'fail' };
      },
    });

    expect(tiers[0]).toBe('local');
    // Default maxEscalations is 2, so there are three attempts, and by the third
    // the accumulated error loops have promoted the classification.
    expect(tiers.length).toBe(3);
    expect(tiers[tiers.length - 1]).not.toBe('local');
    // The classifier moved it, so the router's escalation flag is not set.
    expect(result.escalated).toBe(false);
  });

  it('counts a failed check toward the router escalation threshold', async () => {
    // The other mechanism: reportFailure drives router.escalated once
    // maxAttemptsPerTier is reached. Verified directly on the router, because
    // proving it through execute() would need a classifier that stays put - and
    // a classifier that never escalates is not one worth shipping.
    // route() creates the task state on first call, so no explicit start.
    const router = new TierRouter(cfg());
    router.route('t1', {
      description: 'fix a typo',
      filesTouched: [],
      errorLoops: 0,
      testFailures: 0,
    });

    router.reportFailure('t1');
    expect(router.route('t1', {
      description: 'fix a typo',
      filesTouched: [],
      errorLoops: 0,
      testFailures: 0,
    }).escalated).toBe(false);

    router.reportFailure('t1');
    const second = router.route('t1', {
      description: 'fix a typo',
      filesTouched: [],
      errorLoops: 0,
      testFailures: 0,
    });
    expect(second.escalated).toBe(true);
    expect(second.tier).not.toBe('local');
  });

  it('does not escalate when the check passes', async () => {
    const client = new FakeClient(['right']);
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => ({ outcome: 'pass' }),
    });

    expect(result.attempts).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(result.verification?.outcome).toBe('pass');
    expect(result.history[0]?.verified).toBe(true);
  });

  it('feeds the failure detail into the retry prompt', async () => {
    // Without this, escalating is just the same question to a bigger model.
    const client = new FakeClient(['wrong', 'right']);
    let calls = 0;
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    await orch.execute('t1', 'fix a typo', {
      verify: () => {
        calls += 1;
        return calls === 1
          ? { outcome: 'fail' as const, detail: '3 tests failed: expected 2 got 3' }
          : { outcome: 'pass' as const };
      },
    });

    expect(client.calls).toHaveLength(2);
    const retry = String(client.calls[1]?.['prompt'] ?? '');
    expect(retry).toContain('3 tests failed: expected 2 got 3');
    expect(retry).toContain('fix a typo');
  });

  it('tells the retry which tier already failed', async () => {
    // So the stronger model knows the weaker one was tried, rather than
    // re-deriving it.
    const client = new FakeClient(['wrong', 'right']);
    let calls = 0;
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    await orch.execute('t1', 'fix a typo', {
      verify: () => {
        calls += 1;
        return calls === 1
          ? { outcome: 'fail' as const, detail: 'still wrong' }
          : { outcome: 'pass' as const };
      },
    });

    expect(String(client.calls[1]?.['prompt'] ?? '')).toMatch(/attempted on the \w+ tier/);
  });

  it('reports a failed check as a failed attempt, not a provider error', async () => {
    const client = new FakeClient(['wrong', 'right']);
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => ({ outcome: 'fail', detail: 'nope' }),
    });

    expect(result.history[0]?.success).toBe(false);
    // The error names the verification, so the reason is not a mystery.
    expect(result.history[0]?.error).toMatch(/verification failed/);
  });

  it('keeps the cost of a failed attempt', async () => {
    // Tokens were spent producing a wrong answer. Dropping them would understate
    // what a verification-driven run actually costs - and this is the whole
    // trade: you spend more to be more likely correct.
    let calls = 0;
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient(['wrong', 'right']) });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => {
        calls += 1;
        return { outcome: calls === 1 ? 'fail' : 'pass' };
      },
    });

    // Recorded per attempt, and summed into the run: 10 in for the wrong
    // answer plus 10 for the right one.
    expect(result.history[0]?.costUsd).toBeDefined();
    expect(result.tokensIn).toBe(20);
    expect(result.tokensOut).toBe(40);
  });

  it('fails the run when every attempt fails verification', async () => {
    const orch = new Orchestrator(cfg(), {
      createClient: () => new FakeClient(['a', 'b', 'c']),
    });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => ({ outcome: 'fail', detail: 'never right' }),
    });

    expect(result.success).toBe(false);
    // "All attempts failed" would hide the actual reason.
    expect(result.error).toMatch(/Verification failed/);
    expect(result.error).toContain('never right');
  });

  it('does not escalate on an unknown verdict', async () => {
    // A check that could not run has confirmed nothing. Escalating here would
    // burn a frontier model on a working answer, and marking it a pass would
    // claim verification that never happened.
    const client = new FakeClient(['probably-fine']);
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => ({ outcome: 'unknown', detail: 'no test runner in this environment' }),
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(result.verification?.outcome).toBe('unknown');
    // Explicitly not a pass.
    expect(result.history[0]?.verified).toBe(false);
  });

  it('treats a thrown verifier as unknown rather than a failure', async () => {
    // A bug in the check must not escalate every task and spend a frontier
    // model on correct answers.
    const client = new FakeClient(['answer']);
    const orch = new Orchestrator(cfg(), { createClient: () => client });
    const result = await orch.execute('t1', 'fix a typo', {
      verify: () => {
        throw new Error('verifier is broken');
      },
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.verification?.outcome).toBe('unknown');
    expect(result.verification?.detail).toMatch(/broken/);
  });

  it('passes the tier and model that produced the answer to the verifier', async () => {
    const seen: string[] = [];
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient() });
    await orch.execute('t1', 'fix a typo', {
      verify: (_content, context) => {
        seen.push(`${context.tier}/${context.model}`);
        return { outcome: 'pass' };
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^local\//);
  });

  it('verifies the content it is checking', async () => {
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient(['the answer']) });
    let checked = '';
    await orch.execute('t1', 'fix a typo', {
      verify: (content) => {
        checked = content;
        return { outcome: 'pass' };
      },
    });

    expect(checked).toBe('the answer');
  });

  it('checks each attempt, not just the first', async () => {
    let calls = 0;
    const orch = new Orchestrator(cfg(), { createClient: () => new FakeClient(['a', 'b']) });
    await orch.execute('t1', 'fix a typo', {
      verify: () => {
        calls += 1;
        return { outcome: calls === 1 ? 'fail' : 'pass' };
      },
    });

    expect(calls).toBe(2);
  });
});

describe('runVerifier', () => {
  const context = { taskId: 't', prompt: 'p', tier: 'local', model: 'm', attempt: 1 };

  it('passes through a valid verdict', async () => {
    const result: VerificationResult = { outcome: 'fail', detail: 'boom' };
    expect(await runVerifier(() => result, 'x', context)).toEqual(result);
  });

  it('converts a throw into unknown', async () => {
    const result = await runVerifier(() => {
      throw new Error('nope');
    }, 'x', context);
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toMatch(/nope/);
  });

  it('converts a missing verdict into unknown', async () => {
    const result = await runVerifier(() => undefined as never, 'x', context);
    expect(result.outcome).toBe('unknown');
  });

  it('rejects an invented outcome', async () => {
    // A verifier typo must not be read as anything in particular, least of all
    // a pass.
    const result = await runVerifier(
      () => ({ outcome: 'probably fine' }) as never,
      'x',
      context,
    );
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toMatch(/unrecognised/);
  });
});

describe('trimDetail', () => {
  it('keeps short output whole', () => {
    expect(trimDetail('short failure')).toBe('short failure');
  });

  it('drops empty and missing detail', () => {
    expect(trimDetail('   ')).toBeUndefined();
    expect(trimDetail(undefined)).toBeUndefined();
  });

  it('keeps the tail of a long failure', async () => {
    // A test runner's signal is at the end. Keeping the head would feed the
    // next model progress noise and cost more than the escalation saved.
    const long = `${'x'.repeat(MAX_VERIFIER_DETAIL * 2)}THE ACTUAL FAILURE`;
    const trimmed = trimDetail(long);
    expect(trimmed?.endsWith('THE ACTUAL FAILURE')).toBe(true);
    expect(trimmed!.length).toBeLessThanOrEqual(MAX_VERIFIER_DETAIL + 5);
  });
});

describe('retryPrompt', () => {
  it('adds nothing when nothing failed', () => {
    const base = 'fix a typo';
    expect(retryPrompt(base, {
      outcome: 'unknown',
      attempt: 1,
      tier: 'local',
      model: 'm',
    })).toBe(base);
  });

  it('says so when the check gave no detail', async () => {
    // Silently retrying with no reason is the failure mode this avoids, so the
    // absence of detail has to be stated rather than left blank.
    const prompt = retryPrompt('fix a typo', {
      outcome: 'fail',
      attempt: 1,
      tier: 'local',
      model: 'm',
    });
    expect(prompt).toMatch(/reported no detail/);
  });
});
