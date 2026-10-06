import { describe, expect, it } from 'vitest';

import {
  capabilitySummary,
  describeCapabilities,
  isFullFeatured,
  type HostCapabilities,
} from '../src/capabilities.js';

/** A host with every bridge: the desktop app. */
const desktop: HostCapabilities = {
  terminal: {},
  builder: {},
  models: {},
  keys: {},
  hardware: {},
  modelsInstall: {},
};

/** No bridges at all: the Android webview. */
const webview: HostCapabilities = {};

const byId = (host: HostCapabilities, id: string) =>
  describeCapabilities(host).find((capability) => capability.id === id);

describe('describeCapabilities', () => {
  it('reports everything available on the desktop app', () => {
    for (const capability of describeCapabilities(desktop)) {
      expect(capability.available, `${capability.label} missing on desktop`).toBe(true);
    }
    expect(isFullFeatured(desktop)).toBe(true);
  });

  it('keeps chat and routing available with no bridges at all', () => {
    // The Ask agent runs through core's Orchestrator, which only needs fetch,
    // so a host with nothing else still routes and answers. Claiming otherwise
    // would hide the product's whole point on the platform it is most useful.
    expect(byId(webview, 'ask')?.available).toBe(true);
    expect(byId(webview, 'editor')?.available).toBe(true);
  });

  it('marks the terminal unavailable without a PTY bridge', () => {
    expect(byId(webview, 'terminal')?.available).toBe(false);
    expect(byId(webview, 'terminal')?.reason).toMatch(/no shell/i);
  });

  it('marks Build mode unavailable without a tool layer', () => {
    // This is the one that reads as a bug: the IDE mounts, the agent answers,
    // and then a Build request is refused with a reason about a tool layer.
    expect(byId(webview, 'build')?.available).toBe(false);
    expect(byId(webview, 'build')?.reason).toMatch(/Chat and routing work/);
  });

  it('marks the key vault unavailable without a secret store', () => {
    const capability = byId(webview, 'vault');
    expect(capability?.available).toBe(false);
    // Must say keys are not written to disk, which is the user's actual concern.
    expect(capability?.reason).toMatch(/never written to disk/);
  });

  it('omits the reason when a capability is available', () => {
    // An empty reason string reads as a truncated sentence rather than as
    // "nothing to add".
    for (const capability of describeCapabilities(desktop)) {
      expect(capability.reason, `${capability.id} has a reason but works`).toBeUndefined();
    }
  });

  it('gives every unavailable capability a reason', () => {
    for (const capability of describeCapabilities(webview)) {
      if (capability.available) continue;
      expect(capability.reason, `${capability.id} unavailable with no reason`).toBeTruthy();
    }
  });

  it('treats one bridge as enough for Build mode', () => {
    // Build mode needs the tool layer, which arrives with either bridge in
    // practice; requiring both would hide it on a host that can actually build.
    expect(byId({ builder: {} }, 'build')?.available).toBe(true);
    expect(byId({ terminal: {} }, 'build')?.available).toBe(true);
  });
});

describe('capabilitySummary', () => {
  it('says nothing on a full host', () => {
    // A banner reading "everything works" on the desktop app is noise.
    expect(capabilitySummary(desktop)).toBe('');
  });

  it('leads with what does work', () => {
    const summary = capabilitySummary(webview);
    expect(summary).toMatch(/^Chat, routing, the editor, and search all work here/);
  });

  it('lists only the absences', () => {
    const summary = capabilitySummary(webview);
    expect(summary).toMatch(/Not available:/);
    expect(summary).toMatch(/Terminal/);
    expect(summary).toMatch(/Build mode/);
    // Chat works, so it must not appear in the "not available" half.
    expect(summary).not.toMatch(/Not available:.*Chat/);
  });

  it('names the terminal as absent on a webview', () => {
    // The specific Android claim: no terminal, because a webview has no shell.
    expect(capabilitySummary(webview)).toMatch(/Terminal/);
  });
});

describe('isFullFeatured', () => {
  it('is false with even one bridge missing', () => {
    expect(isFullFeatured({ ...desktop, terminal: undefined })).toBe(false);
  });

  it('is false with no bridges', () => {
    expect(isFullFeatured(webview)).toBe(false);
  });
});