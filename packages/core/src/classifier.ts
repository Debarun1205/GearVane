import type { ClassificationResult, TaskContext, Tier } from './types.js';

/**
 * Classifies a task into a tier using transparent heuristics.
 *
 * Deliberately simple and inspectable: a user should be able to read the
 * reasons and disagree with them. The learned classifier refines this
 * rather than replacing it.
 */
export const DEFAULT_SIMPLE_KEYWORDS = [
  'typo',
  'spelling',
  'whitespace',
  'formatting',
  'lint',
  'rename',
  'comment',
  'readme',
  'documentation',
  'boilerplate',
  'template',
  'simple',
  'small',
  'fix',
] as const;

export const DEFAULT_COMPLEX_KEYWORDS = [
  'architecture',
  'refactor',
  'optimize',
  'performance',
  'bottleneck',
  'security',
  'concurrency',
  'race condition',
  'deadlock',
  'memory leak',
  'distributed',
  'migration',
  'redesign',
  'scale',
  'debug',
  'investigate',
  'complex',
] as const;

/** Valid regex patterns, used when no config supplies its own. */
export const DEFAULT_COMPLEX_FILE_PATTERNS = [
  String.raw`\.rs$`,
  String.raw`\.go$`,
  String.raw`\.cpp$`,
  String.raw`\.c$`,
  String.raw`_test\.`,
  String.raw`tests?/`,
  String.raw`src/core/`,
  String.raw`src/engine/`,
  String.raw`migrations?`,
  'deploy',
  'infra',
] as const;

const ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Translate a glob into a regex.
 *
 * Config files naturally use globs ("*.rs"), which are not valid regex.
 * `*` is allowed to match across path separators so that "*.rs" matches
 * "src/main.rs", which is what someone writing that pattern expects.
 */
export function globToRegex(glob: string): string {
  let out = '';
  for (const ch of glob) {
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else {
      out += ch.replace(ESCAPE_PATTERN, String.raw`\$&`);
    }
  }
  return out;
}

function isValidRegex(pattern: string): boolean {
  try {
     
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile config patterns, accepting both glob and regex syntax.
 *
 * A pattern is treated as regex when it compiles as regex, and as a glob
 * otherwise. This is what lets the shipped config use globs without
 * crashing the classifier.
 */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => {
    const source = isValidRegex(pattern) ? pattern : globToRegex(pattern);
    return new RegExp(source);
  });
}

export interface TaskClassifierOptions {
  simpleKeywords?: readonly string[];
  complexKeywords?: readonly string[];
  complexFilePatterns?: readonly string[];
  minFilesForComplex?: number;
}

export class TaskClassifier {
  private readonly simpleKeywords: readonly string[];
  private readonly complexKeywords: readonly string[];
  private readonly complexFilePatterns: readonly RegExp[];
  private readonly minFilesForComplex: number;

  constructor(options: TaskClassifierOptions = {}) {
    this.simpleKeywords = options.simpleKeywords ?? DEFAULT_SIMPLE_KEYWORDS;
    this.complexKeywords = options.complexKeywords ?? DEFAULT_COMPLEX_KEYWORDS;
    this.complexFilePatterns = compilePatterns(
      options.complexFilePatterns ?? DEFAULT_COMPLEX_FILE_PATTERNS,
    );
    this.minFilesForComplex = options.minFilesForComplex ?? 3;
  }

  classify(context: TaskContext): ClassificationResult {
    const scores: Record<Tier, number> = { local: 0, mid: 0, frontier: 0 };
    const reasons: string[] = [];

    const description = context.description.toLowerCase();

    const simpleMatches = this.simpleKeywords.filter((keyword) =>
      description.includes(keyword.toLowerCase()),
    ).length;
    const complexMatches = this.complexKeywords.filter((keyword) =>
      description.includes(keyword.toLowerCase()),
    ).length;

    scores.local += simpleMatches * 0.3;
    scores.frontier += complexMatches * 0.3;

    if (simpleMatches > 0) {
      reasons.push(`Found ${simpleMatches} simple-task keywords`);
    }
    if (complexMatches > 0) {
      reasons.push(`Found ${complexMatches} complex-task keywords`);
    }

    const complexFiles = context.filesTouched.filter((file) =>
      this.complexFilePatterns.some((pattern) => pattern.test(file)),
    ).length;

    if (complexFiles > 0) {
      scores.frontier += complexFiles * 0.2;
      reasons.push(`${complexFiles} complex file patterns matched`);
    }

    if (context.filesTouched.length >= this.minFilesForComplex) {
      scores.frontier += 0.3;
      reasons.push(`Many files touched (${context.filesTouched.length})`);
    }

    if (context.errorLoops > 0) {
      scores.frontier += context.errorLoops * 0.4;
      reasons.push(`${context.errorLoops} error loops detected`);
    }

    if (context.testFailures > 0) {
      scores.frontier += context.testFailures * 0.3;
      reasons.push(`${context.testFailures} test failures`);
    }

    // A task that has already failed at a tier is promoted on retry.
    if (context.previousTier === 'local' && (context.previousAttempts ?? 0) >= 2) {
      scores.mid += 0.5;
      reasons.push('Escalating from local after repeated failures');
    } else if (
      context.previousTier === 'mid' &&
      (context.previousAttempts ?? 0) >= 2
    ) {
      scores.frontier += 0.5;
      reasons.push('Escalating from mid after repeated failures');
    }

    const maxScore = Math.max(scores.local, scores.mid, scores.frontier);
    if (maxScore === 0) {
      return {
        tier: 'mid',
        confidence: 0.5,
        reasons: ['No strong signals, defaulting to mid tier'],
        scores,
      };
    }

    const winner = (Object.keys(scores) as Tier[]).reduce((best, tier) =>
      scores[tier] > scores[best] ? tier : best,
    );

    const sorted = Object.values(scores).sort((a, b) => b - a);
    const margin = (sorted[0] ?? 0) - (sorted[1] ?? 0);
    const confidence = Math.min(0.5 + margin * 0.3, 1);

    return {
      tier: winner,
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      scores,
    };
  }
}