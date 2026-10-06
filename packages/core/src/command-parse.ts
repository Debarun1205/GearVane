/**
 * Command parsing for gate-bypass hardening.
 *
 * The shell gate has one job: the string that is checked must be the string
 * that runs. A command with shell metacharacters (`;`, `&&`, `||`, pipes,
 * `$(...)`, backticks, `$VAR`, redirections, globs, line continuations) is
 * executed by a shell that interprets them, so the gate can only check the
 * exact final string — and the allowlist must never apply to it, because a
 * prefix match lets `git status; rm -rf /` ride the `git status` entry.
 *
 * A command without those constructs is "simple": it parses to a fixed argv
 * that can be executed with no shell at all, so no second command can be
 * injected. Balanced quotes are argv syntax, not shell execution, so they
 * keep a command simple: `git commit -m "fix bug"` parses to
 * `['git', 'commit', '-m', 'fix bug']`.
 */

/**
 * Parse a command line into argv.
 *
 * Returns null when the command is not simple — it contains shell syntax
 * the gate cannot reason about. Callers must then run it through a shell
 * and check the exact final string.
 */
export function parseCommand(command: string): string[] | null {
  const argv: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < command.length) {
    const ch = command[i] as string;

    if (quote) {
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        // Inside double quotes a backslash escapes a few characters.
        const next = command[i + 1] as string;
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 2;
          continue;
        }
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      i += 1;
      continue;
    }

    // Only spaces and tabs separate arguments. A newline is a command
    // separator in a shell, never whitespace to skip.
    if (ch === ' ' || ch === '\t') {
      if (hasCurrent) {
        argv.push(current);
        current = '';
        hasCurrent = false;
      }
      i += 1;
      continue;
    }

    // Shell syntax: separators, expansions, redirections, globs, history
    // expansion, comments, line continuations. Any of these means the
    // command must go through a shell and the gate checks the exact string.
    // A newline is a command separator, never whitespace to skip.
    if (';&|<>(){}`$!*?[]~#\\'.includes(ch) || ch === '\n' || ch === '\r') return null;

    current += ch;
    hasCurrent = true;
    i += 1;
  }

  // An unbalanced quote is shell syntax too; let the shell handle it.
  if (quote) return null;
  if (hasCurrent) argv.push(current);
  return argv;
}

/** True when the command parses to a fixed argv with no shell syntax. */
export function isSimpleCommand(command: string): boolean {
  return parseCommand(command) !== null;
}

function argvEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === (b[index] as string));
}

/**
 * True when the command is simple and its argv exactly equals the
 * allowlisted entry's argv. Exact match, never prefix: `git status; ...`
 * and `git status --porcelain` are both not `git status`.
 */
export function matchesAllowlist(command: string, allowlist: readonly string[]): boolean {
  const argv = parseCommand(command);
  if (!argv) return false;
  for (const entry of allowlist) {
    const allowedArgv = parseCommand(entry);
    if (allowedArgv && argvEqual(argv, allowedArgv)) return true;
  }
  return false;
}

/**
 * Rejoin argv into a command string for the Windows shell fallback.
 *
 * Only used for simple commands, which contain no shell syntax, so plain
 * quoting is exact. Windows groups with double quotes; POSIX with single.
 */
export function rejoinArgv(argv: string[]): string {
  const quote = (arg: string): string => {
    if (arg !== '' && !/[\s"']/.test(arg)) return arg;
    if (process.platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  };
  return argv.map(quote).join(' ');
}
