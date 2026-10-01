/**
 * Glob matching shared by the classifier and the loaders.
 *
 * Kept separate so the hot path stays tiny and dependency-free, since it
 * runs on every routing decision.
 */

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeForGlob(text: string): string {
  return text.replace(REGEX_SPECIALS, String.raw`\$&`);
}

/**
 * Translate a glob into an anchored regex source string.
 *
 * `*` matches across path separators so "*.rs" matches "src/main.rs",
 * which is what someone writing that pattern expects. Use `**` for
 * path-segment-bounded matching via {@link globToSegmentRegex}.
 */
export function globToRegexSource(glob: string): string {
  let out = '';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeForGlob(ch);
  }
  return out;
}

/** Glob where `*` stops at `/` and `**` spans directories. */
export function globToSegmentRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeForGlob(ch);
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
 * Compile a pattern, accepting either regex or glob syntax.
 *
 * A pattern that compiles as regex is used as-is; otherwise it is treated
 * as a glob. This is what lets config files use globs like "*.rs" without
 * the classifier throwing on every call.
 */
export function compilePattern(pattern: string): RegExp {
  const source = isValidRegex(pattern) ? pattern : globToRegexSource(pattern);
  return new RegExp(source);
}

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map(compilePattern);
}

/** Test a path against a glob or regex pattern. */
export function classifyGlob(path: string, pattern: string): boolean {
  return compilePattern(pattern).test(path);
}