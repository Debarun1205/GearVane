/**
 * Deployment targets.
 *
 * ## Why this is an interface
 *
 * Publishing a site needs a credential, and a credential in browser JavaScript
 * is a credential handed to every visitor. So the browser builder can scaffold
 * and export, but it cannot publish. Publishing happens in the desktop app or
 * the CLI, where a token can live in the environment or the OS keychain.
 *
 * That constraint is why this is an interface with a narrow surface rather than
 * three hardcoded HTTP clients. It also makes the whole layer testable without a
 * network: `FakeDeployer` records what it was asked to do.
 *
 * Nothing here has been exercised against a real provider. The interface and
 * the fake are tested; live publishing is not, and no adapter in this file
 * claims to have published anything.
 */

/** A file to publish. */
export interface DeployFile {
  path: string;
  contents: string;
}

export interface DeployRequest {
  /** Site name, used for the project slug and for provider project names. */
  name: string;
  files: DeployFile[];
  /** Provider-specific destination, e.g. a Pages project name. */
  target?: string;
}

export interface DeployResult {
  ok: boolean;
  /** Where the site can be viewed, when the provider returns one. */
  url?: string;
  /** Human-readable summary, safe to show a user. */
  message: string;
  /** Populated when ok is false. */
  error?: string;
  /** True when this result came from a dry run rather than a real publish. */
  dryRun?: boolean;
}

/**
 * Something that can publish a set of files.
 *
 * Deliberately small: deploy and nothing else. Anything that needs to query
 * provider state belongs outside this interface, because the harness core has
 * no business holding provider credentials.
 */
export interface Deployer {
  /** Stable identifier, shown in the UI. */
  readonly id: string;
  readonly name: string;

  /**
   * Whether a credential is configured.
   *
   * Checked before offering the target, so the UI can explain why rather than
   * failing after the user has filled in a form.
   */
  isConfigured(): boolean;

  /** What the user needs to set up, in plain language. */
  requirements(): string;

  deploy(request: DeployRequest): Promise<DeployResult>;

  /**
   * Validate without publishing.
   *
   * A real dry run needs the provider, so the default refuses rather than
   * pretending to have checked.
   */
  dryRun?(request: DeployRequest): Promise<DeployResult>;
}

/**
 * Records requests instead of publishing.
 *
 * This is what makes the interface testable: the fake is the reference for what
 * a correct deploy looks like, and the interface has one honest assertion
 * about live publishing — that nothing in this repository has done it.
 */
export class FakeDeployer implements Deployer {
  readonly id = 'fake';
  readonly name = 'Local folder (no upload)';

  readonly requests: DeployRequest[] = [];
  configured: boolean;

  constructor(configured = true) {
    this.configured = configured;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  requirements(): string {
    return 'Nothing. Writes the site to a local directory instead.';
  }

  async deploy(request: DeployRequest): Promise<DeployResult> {
    this.requests.push(request);

    return {
      ok: true,
      message: `Recorded ${request.files.length} file(s) for "${request.name}". Nothing was uploaded.`,
      dryRun: true,
    };
  }

  async dryRun(request: DeployRequest): Promise<DeployResult> {
    return {
      ok: true,
      message: `Would publish ${request.files.length} file(s) for "${request.name}".`,
      dryRun: true,
    };
  }
}

/**
 * Writes the site to a directory. Does not upload anything.
 *
 * This is the only deployer that is complete rather than a stub, and it is the
 * one the desktop app can offer without asking anyone for a token.
 */
export class LocalDeployer implements Deployer {
  readonly id = 'local';
  readonly name = 'Write to a folder';

  constructor(
    private readonly write: (
      directory: string,
      files: DeployFile[],
    ) => Promise<{ written: string[]; failed: Array<{ path: string; reason: string }> }>,
    private readonly chooseDirectory: () => Promise<string | null>,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  requirements(): string {
    return 'A folder you choose. Nothing leaves your machine.';
  }

  async deploy(request: DeployRequest): Promise<DeployResult> {
    const directory = await this.chooseDirectory();
    if (!directory) {
      return { ok: false, message: 'No folder selected.', error: 'cancelled' };
    }

    const outcome = await this.write(directory, request.files);

    if (outcome.failed.length > 0) {
      return {
        ok: false,
        message: `Wrote ${outcome.written.length} file(s), ${outcome.failed.length} failed.`,
        error: outcome.failed.map((f) => `${f.path}: ${f.reason}`).join('; '),
      };
    }

    return {
      ok: true,
      message: `Wrote ${outcome.written.length} file(s) to ${directory}.`,
    };
  }
}

/**
 * Placeholder for a hosted provider.
 *
 * Exists so the UI can show what a Cloudflare or Netlify target would need,
 * and so the shape of one is written down. It refuses rather than pretending,
 * because a deploy button that silently does nothing is worse than no button.
 */
export class UnconfiguredDeployer implements Deployer {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly setup: string,
  ) {}

  isConfigured(): boolean {
    return false;
  }

  requirements(): string {
    return this.setup;
  }

  async deploy(): Promise<DeployResult> {
    return {
      ok: false,
      message: `${this.name} is not wired up in this build.`,
      error: 'not implemented',
    };
  }
}

/** The targets the builder offers, in the order the UI should show them. */
export function defaultDeployers(): Deployer[] {
  return [
    // The two callbacks are supplied by the host: the desktop app passes
    // functions that show a folder picker and write through a Workspace, the
    // website passes ones that refuse, because it has no filesystem.
    new LocalDeployer(
      async (_directory: string, _files: DeployFile[]) => ({
        written: [],
        failed: [],
      }),
      async () => null,
    ),
    new UnconfiguredDeployer(
      'cloudflare',
      'Cloudflare Pages',
      'A Cloudflare API token with Pages edit permission, set as CLOUDFLARE_API_TOKEN.',
    ),
    new UnconfiguredDeployer(
      'netlify',
      'Netlify',
      'A Netlify personal access token, set as NETLIFY_AUTH_TOKEN.',
    ),
    new UnconfiguredDeployer(
      'vercel',
      'Vercel',
      'A Vercel token, set as VERCEL_TOKEN. The CLI can also publish without one after login.',
    ),
  ];
}