import { describe, expect, it } from 'vitest';

import { matchesAllowlist, parseCommand } from '../src/command-parse.js';

/**
 * Gate-bypass regression table.
 *
 * Every construct that gives a shell parsing power beyond "run this argv"
 * must make the command non-simple, so it can never ride the allowlist and
 * must instead go through full classification with the exact final string
 * checked. Quotes are the one exception: they are argv syntax, not shell
 * execution, so a quoted command stays simple.
 */
describe('parseCommand', () => {
  it('parses a plain command to argv', () => {
    expect(parseCommand('git status')).toEqual(['git', 'status']);
    expect(parseCommand('  git   status  ')).toEqual(['git', 'status']);
    expect(parseCommand('pytest -q tests/')).toEqual(['pytest', '-q', 'tests/']);
  });

  it('treats balanced quotes as argv syntax, not shell execution', () => {
    expect(parseCommand('git commit -m "fix bug"')).toEqual(['git', 'commit', '-m', 'fix bug']);
    expect(parseCommand("git commit -m 'fix bug'")).toEqual(['git', 'commit', '-m', 'fix bug']);
    expect(parseCommand('echo ""')).toEqual(['echo', '']);
  });

  const notSimple: Array<[string, string]> = [
    ['semicolon', 'git status; rm -rf /'],
    ['double ampersand', 'git status && git push'],
    ['single ampersand', 'git status &'],
    ['double pipe', 'git status || git push'],
    ['pipe', 'cat file | grep x'],
    ['command substitution', 'echo $(whoami)'],
    ['braced substitution', 'echo ${HOME}'],
    ['env var', 'echo $HOME'],
    ['backticks', 'echo `whoami`'],
    ['line continuation', 'git status \\\n  && git push'],
    ['newline separator', 'git status\ngit push'],
    ['redirect out', 'git status > out.txt'],
    ['redirect in', 'grep x < file'],
    ['append', 'echo x >> log'],
    ['comment', 'git status # push later'],
    ['glob', 'rm *.txt'],
    ['tilde', 'ls ~'],
    ['history expansion', 'echo !'],
    ['subshell', '(git status)'],
    ['brace expansion', 'echo {a,b}'],
    ['unbalanced quote', 'git commit -m "fix bug'],
    ['escaped space', 'git commit -m fix\\ bug'],
  ];

  it.each(notSimple)('rejects %s as non-simple', (_label, command) => {
    expect(parseCommand(command)).toBeNull();
  });

  it('rejects a Unicode look-alike of a metacharacter only when it is one', () => {
    // A fullwidth semicolon is not a shell metacharacter, so the command
    // stays simple — but its argv no longer matches the allowlist entry,
    // which is what actually keeps it from riding the allowlist.
    const argv = parseCommand('git status； rm -rf /');
    expect(argv).not.toBeNull();
    expect(matchesAllowlist('git status； rm -rf /', ['git status'])).toBe(false);
  });
});

describe('matchesAllowlist', () => {
  const allowlist = ['git status', 'git log', 'ls', 'cat'];

  it('matches an allowlisted command exactly', () => {
    expect(matchesAllowlist('git status', allowlist)).toBe(true);
    expect(matchesAllowlist('  git status  ', allowlist)).toBe(true);
  });

  it('does not match a prefix of a longer command', () => {
    // The bypass this prevents: `git status; rm -rf /` starts with an
    // allowlisted command but is not it.
    expect(matchesAllowlist('git status; rm -rf /', allowlist)).toBe(false);
    expect(matchesAllowlist('git status && git push', allowlist)).toBe(false);
    expect(matchesAllowlist('git status | cat', allowlist)).toBe(false);
  });

  it('does not match an allowlisted command with extra arguments', () => {
    expect(matchesAllowlist('git status --porcelain', allowlist)).toBe(false);
    expect(matchesAllowlist('ls -la', allowlist)).toBe(false);
  });

  it('does not match a Unicode look-alike of an allowlisted command', () => {
    // Fullwidth `ｓ` is not `s`: the argv differs, so no match.
    expect(matchesAllowlist('git ｓtatus', allowlist)).toBe(false);
  });

  it('does not match a nested interpreter riding an allowlisted name', () => {
    expect(matchesAllowlist('bash -c "git status"', allowlist)).toBe(false);
    expect(matchesAllowlist('cmd /c git status', allowlist)).toBe(false);
  });
});
