import { describe, expect, it } from 'vitest';

import {
  emptyState,
  formatDuration,
  formatUsd,
  healthIcon,
  tierIcon,
  type SessionState,
} from '../src/session.js';

describe('icons', () => {
  it('maps each tier to an icon', () => {
    expect(tierIcon('local')).toBeTruthy();
    expect(tierIcon('mid')).toBeTruthy();
    expect(tierIcon('frontier')).toBeTruthy();
  });

  it('gives distinct icons per tier', () => {
    const icons = new Set([tierIcon('local'), tierIcon('mid'), tierIcon('frontier')]);
    expect(icons.size).toBe(3);
  });

  it('maps each health status to an icon', () => {
    expect(healthIcon('healthy')).toBeTruthy();
    expect(healthIcon('unhealthy')).toBeTruthy();
  });

  it('uses the unknown icon for an unrecognised value', () => {
    expect(healthIcon('nonsense')).toBe(healthIcon('unknown'));
    expect(tierIcon('nonsense')).toBe(healthIcon('unknown'));
  });

  it('gives distinct icons per health status', () => {
    const icons = new Set([
      healthIcon('healthy'),
      healthIcon('degraded'),
      healthIcon('unhealthy'),
      healthIcon('unknown'),
    ]);
    expect(icons.size).toBe(4);
  });
});

describe('formatUsd', () => {
  it('formats zero plainly', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats cents', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
  });

  it('shows more precision for tiny amounts', () => {
    // A frontier task can cost cents of a dollar; rounding to $0.00 would
    // hide real spend.
    expect(formatUsd(0.0004)).toBe('$0.0004');
  });
});

describe('formatDuration', () => {
  it('uses milliseconds below a second', () => {
    expect(formatDuration(120)).toBe('120ms');
  });

  it('uses seconds below a minute', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('uses minutes above a minute', () => {
    expect(formatDuration(90_000)).toBe('2m');
  });
});

describe('emptyState', () => {
  it('has no entries in every section', () => {
    const state = emptyState();
    expect(state.routing).toEqual([]);
    expect(state.spend).toEqual([]);
    expect(state.health).toEqual([]);
  });

  it('returns a fresh object each call', () => {
    expect(emptyState()).not.toBe(emptyState());
  });

  it('satisfies the SessionState shape', () => {
    const state: SessionState = emptyState();
    expect(Object.keys(state).sort()).toEqual(['health', 'routing', 'spend']);
  });
});