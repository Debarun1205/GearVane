/**
 * What this host can actually do, stated as one object.
 *
 * The same renderer bundle runs in the Electron renderer and, unchanged, inside
 * the Android webview. The difference is not a build flag: it is which host
 * bridges happen to exist. So rather than testing for "am I Electron", the UI
 * derives what is available from the bridges and labels what is missing.
 *
 * This matters because the omission is otherwise invisible. On Android the IDE
 * mounts, the file tree works, search works, and the Ask agent answers - so it
 * looks like the desktop app with a few buttons missing. Nothing says why Build
 * mode and the terminal are absent, and a user reasonably concludes a bug. The
 * honest position is that a webview has no shell and cannot load the tool
 * layer, and that belongs on screen rather than in a comment.
 */

/** A capability the product has, and whether this host provides it. */
export interface Capability {
  id: string;
  /** What the user would call it. */
  label: string;
  available: boolean;
  /**
   * Why not, in one sentence.
   *
   * Absent when available: "everything works here" needs no explanation, and an
   * empty explanation reads as a truncated one.
   */
  reason?: string;
}

/** Which bridges exist. Absent bridge means the capability is unavailable. */
export interface HostCapabilities {
  /** node-pty. A webview has no shell to give a PTY. */
  terminal?: unknown;
  /** The builder's filesystem writes and folder picker. */
  builder?: unknown;
  /** Local model serving from the app bundle. */
  models?: unknown;
  /** The OS-encrypted key vault. */
  keys?: unknown;
  /** Memory and disk measurement. */
  hardware?: unknown;
  /** Model installation. */
  modelsInstall?: unknown;
}

/**
 * A capability, with its reason attached only when it is actually missing.
 *
 * Keeping the reason inside this helper is what stops it leaking: a capability
 * written as a literal carries its explanation whether or not it applies, which
 * is how "Unavailable here: ..." ended up attached to a Build mode that works
 * on desktop.
 */
function unavailable(
  id: string,
  label: string,
  available: boolean,
  reason: string,
): Capability {
  return available ? { id, label, available: true } : { id, label, available, reason };
}

/**
 * Describe this host.
 *
 * Kept as a pure function so the mapping from bridges to claims is unit
 * testable. Getting a capability list wrong here means the app either hides
 * something that works or promises something that does not, and both are worse
 * than an honest omission.
 */
export function describeCapabilities(host: HostCapabilities): Capability[] {
  return [
    {
      id: 'ask',
      label: 'Chat and routing',
      // Always available: the Ask agent runs through @gearvane/core's
      // Orchestrator, which only needs fetch. A host with no bridges at all
      // still routes and answers, which is the whole point of the fallback.
      available: true,
    },
    {
      id: 'editor',
      label: 'Editor, files, and search',
      // The IDE mounts over either a real filesystem bridge or the device-local
      // one, so it works in both. Stated positively because on Android it does.
      available: true,
    },
    unavailable(
      'build',
      'Build mode (agent edits files)',
      // Either bridge in practice; requiring both would hide it on a host that
      // can actually build.
      host.builder !== undefined || host.terminal !== undefined,
      'Build mode edits files through a tool layer that cannot load in this ' +
        'environment. Chat and routing work.',
    ),
    unavailable(
      'terminal',
      'Terminal',
      host.terminal !== undefined,
      'There is no shell to attach a terminal to.',
    ),
    unavailable(
      'builder',
      'Website builder',
      host.builder !== undefined,
      'Writing files to a folder you choose needs a filesystem the page ' +
        'cannot reach.',
    ),
    unavailable(
      'vault',
      'Encrypted key storage',
      host.keys !== undefined,
      'No system secret store, so keys stay in memory for this session and ' +
        'are never written to disk.',
    ),
    unavailable(
      'hardware',
      'Memory and disk checks',
      host.hardware !== undefined,
      'There is no filesystem to measure.',
    ),
    unavailable(
      'install',
      'Install models from the catalog',
      host.modelsInstall !== undefined,
      'Weights are downloaded to a folder this host cannot write to. Point ' +
        'GearVane at a local server instead.',
    ),
  ];
}

/** True where nothing at all is missing. */
export function isFullFeatured(host: HostCapabilities): boolean {
  return describeCapabilities(host).every((capability) => capability.available);
}

/**
 * One line for a banner: what works, and what is missing.
 *
 * Returns an empty string on a full host, because a banner reading "everything
 * works" on the desktop app would be noise.
 */
export function capabilitySummary(host: HostCapabilities): string {
  const missing = describeCapabilities(host).filter((capability) => !capability.available);
  if (missing.length === 0) return '';
  return `Chat, routing, the editor, and search all work here. Not available: ${missing
    .map((capability) => capability.label)
    .join(', ')}.`;
}