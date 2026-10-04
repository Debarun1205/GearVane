/**
 * Argument parsing for the GearVane CLI.
 *
 * Hand-rolled rather than pulling in a parser library, so the CLI installs
 * nothing beyond the core. Kept separate from the command implementations
 * so parsing can be tested without spawning a process.
 */

export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/**
 * Parse argv.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, and repeated flags
 * (collected into an array). A `--` terminator stops flag parsing.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];

  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');

      if (equals !== -1) {
        const name = body.slice(0, equals);
        assign(flags, name, body.slice(equals + 1));
        index += 1;
        continue;
      }

      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        assign(flags, body, next);
        index += 2;
        continue;
      }

      assign(flags, body, true);
      index += 1;
      continue;
    }

    positionals.push(token);
    index += 1;
  }

  return {
    command: positionals[0],
    flags: flags as Record<string, string | boolean>,
    positionals: positionals.slice(1),
  };
}

function assign(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string | boolean,
): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }
  flags[name] = [String(existing), String(value)];
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || typeof value === 'boolean') return undefined;
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (value === undefined) return [];
  if (typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  if (typeof value === 'boolean') return value;
  if (value === 'false') return false;
  return value !== undefined;
}