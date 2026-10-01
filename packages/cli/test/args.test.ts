import { describe, expect, it } from 'vitest';

import { flagBool, flagList, flagNumber, flagString, parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('reads the subcommand', () => {
    expect(parseArgs(['route', '--task', 'fix a typo']).command).toBe('route');
  });

  it('reads a flag with a separate value', () => {
    const args = parseArgs(['route', '--task', 'fix a typo']);
    expect(flagString(args, 'task')).toBe('fix a typo');
  });

  it('reads a flag written with an equals sign', () => {
    const args = parseArgs(['route', '--task=fix a typo']);
    expect(flagString(args, 'task')).toBe('fix a typo');
  });

  it('treats a flag with no value as boolean', () => {
    const args = parseArgs(['run', '--stream']);
    expect(flagBool(args, 'stream')).toBe(true);
    expect(flagString(args, 'stream')).toBeUndefined();
  });

  it('collects a repeated flag into a list', () => {
    const args = parseArgs(['route', '--files', 'a.ts', '--files', 'b.ts']);
    expect(flagList(args, 'files')).toEqual(['a.ts', 'b.ts']);
  });

  it('reads a space-separated list after one flag', () => {
    // argparse-style `--files a b c` collects the trailing positionals.
    const args = parseArgs(['route', '--files', 'a.ts', 'b.ts', 'c.ts']);
    expect(flagList(args, 'files')).toEqual(['a.ts']);
    expect(args.positionals).toEqual(['b.ts', 'c.ts']);
  });

  it('stops parsing flags after a double dash', () => {
    const args = parseArgs(['deploy', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });

  it('returns undefined for a missing flag', () => {
    const args = parseArgs(['route']);
    expect(flagString(args, 'task')).toBeUndefined();
    expect(flagList(args, 'files')).toEqual([]);
    expect(flagBool(args, 'json')).toBe(false);
  });

  it('parses numbers and rejects non-numeric values', () => {
    const args = parseArgs(['run', '--max-tokens', '512', '--temperature', 'warm']);
    expect(flagNumber(args, 'max-tokens')).toBe(512);
    expect(flagNumber(args, 'temperature')).toBeUndefined();
  });

  it('treats an explicit false as false', () => {
    const args = parseArgs(['route', '--json=false']);
    expect(flagBool(args, 'json')).toBe(false);
  });

  it('handles an empty argv', () => {
    const args = parseArgs([]);
    expect(args.command).toBeUndefined();
    expect(args.positionals).toEqual([]);
  });

  it('keeps a negative number as a value', () => {
    const args = parseArgs(['run', '--temperature', '-0.5']);
    expect(flagNumber(args, 'temperature')).toBeCloseTo(-0.5);
  });
});