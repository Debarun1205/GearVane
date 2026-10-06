/**
 * Paths that hold credentials, refused by default even inside the workspace.
 *
 * ## Why containment is not enough
 *
 * The workspace layer answers "is this path inside the project?" It has
 * nothing to say about whether the file is worth reading. A model that has
 * been asked to look around a repository will happily read `.env`,
 * `~/.aws/credentials`, or the Chrome profile that a stray `..` let it
 * reach, and the answer arrives in the context window and then in whatever
 * provider the run was routed to. Containment stops the path escaping the
 * project; it does not stop the project from containing a secret.
 *
 * Projects do contain secrets, routinely and accidentally: a `.env` checked
 * in before someone added `.gitignore`, a `service-account.json`, a
 * `server.key` from a tutorial. That is the whole case.
 *
 * ## What this is not
 *
 * It is not a scanner. It matches path shapes, not contents, so a secret
 * named `config.txt` sails through and a `.env.example` would be caught by a
 * naive glob. It is a default-deny list for the paths that are almost always
 * credentials, on the reasoning that the cost of a false positive is one
 * explicit override while the cost of a miss is a leaked key.
 *
 * ## Overriding
 *
 * Every denial can be granted per run through `ToolContext.allowSensitive`,
 * which the host populates from an explicit user decision. There is no
 * wildcard: granting `.env` does not grant `.env.production`.
 */

/** Why a path was refused, or null when it is fine. */
export type DenialReason =
  | 'dotenv'
  | 'credentials-dir'
  | 'git-config'
  | 'browser-profile'
  | 'private-key'
  | 'package-registry-auth'
  | 'generic-secret';

export interface Denial {
  reason: DenialReason;
  /** Plain-language explanation for the user and the model. */
  message: string;
}

/**
 * `.env` variants that are templates, not secrets.
 *
 * `.env.example` is checked into repositories specifically so a developer can
 * see which variables to set. Refusing it would make onboarding a new
 * contributor worse, for no security gain, so these are carved out. A file
 * named `.env.local` is not: that one holds real values by convention.
 */
const DOTENV_ALLOWLIST = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.defaults',
  '.env.schema.example',
]);

/** Directories whose contents are credentials by definition. */
const CREDENTIAL_DIRS: ReadonlyArray<{ segment: string; message: string }> = [
  { segment: '.ssh', message: 'SSH keys and authorized_keys' },
  { segment: '.aws', message: 'AWS credentials' },
  { segment: '.gnupg', message: 'GnuPG private keys' },
  { segment: '.kube', message: 'Kubernetes cluster credentials' },
  { segment: '.azure', message: 'Azure credentials' },
  { segment: '.gcloud', message: 'Google Cloud credentials' },
  { segment: '.docker', message: 'Docker registry credentials' },
  { segment: '.config/gcloud', message: 'Google Cloud credentials' },
];

/** Browser profile directories and the files inside them worth stealing. */
const BROWSER_SEGMENTS = new Set([
  'google/chrome',
  'google/chrome-beta',
  'microsoft/edge',
  'mozilla/firefox',
  'bravesoftware/brave-browser',
  'chromium',
  'opera',
  'vivaldi',
]);

/** Individually named browser stores: cookies, saved passwords, keys. */
const BROWSER_FILES = new Set([
  'cookies',
  'cookies.sqlite',
  'login data',
  'login data for websites',
  'logins.json',
  'key3.db',
  'key4.db',
  'places.sqlite',
  'web data',
]);

/** Private key and keystore extensions, matched on the final segment. */
const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.asc'];

/** Auth files for package registries and other tools. */
const REGISTRY_AUTH = new Set([
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.git-credentials',
  '.cargo/credentials',
  '.gem/credentials',
]);

/** Names that are credentials whatever they are called. */
const GENERIC_SECRETS = new Set([
  'credentials',
  'credentials.json',
  'service-account.json',
  'serviceaccount.json',
  'secrets.json',
  'secret.json',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'wallet.dat',
]);

/** Normalise a path for matching: forward slashes, no trailing slash. */
function normalise(path: string): string {
  const unified = path.replace(/[\\/]+/g, '/').replace(/^\.\//, '');
  return unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
}

/**
 * Classify a workspace-relative path.
 *
 * Takes the path as the caller expressed it, not an absolute one, so the same
 * file is classified the same way however it was reached. Callers that hold an
 * absolute path should pass it relative to the workspace root, since
 * containment has already proven the absolute form is inside.
 */
export function classifySensitive(path: string): Denial | null {
  const normalised = normalise(path);
  if (normalised === '') return null;

  const segments = normalised.split('/');
  const last = segments[segments.length - 1] as string;
  const lowerLast = last.toLowerCase();
  const dotPath = segments.map((s) => s.toLowerCase()).join('/');

  // .env, .env.local, .env.production — but not .env.example.
  if (lowerLast === '.env' || lowerLast.startsWith('.env.')) {
    if (DOTENV_ALLOWLIST.has(lowerLast)) return null;
    return {
      reason: 'dotenv',
      message:
        'environment files hold API keys and passwords. Read the committed ' +
        '.env.example for the variable names instead, or ask the user to ' +
        'confirm reading this one.',
    };
  }

  for (const dir of CREDENTIAL_DIRS) {
    if (dotPath === dir.segment || dotPath.startsWith(`${dir.segment}/`)) {
      return {
        reason: 'credentials-dir',
        message: `${dir.message} are refused by default.`,
      };
    }
  }

  // .git/config can carry credentials in a push URL. The rest of .git is
  // ordinary repository data and stays readable.
  if (dotPath === '.git/config' || dotPath.endsWith('/.git/config')) {
    return {
      reason: 'git-config',
      message:
        '.git/config can contain credentials embedded in a remote URL. Use ' +
        "'git remote -v' instead, which the user can review.",
    };
  }

  const prefix = segments.slice(0, -1).map((s) => s.toLowerCase()).join('/');
  for (const browser of BROWSER_SEGMENTS) {
    if (prefix === browser || prefix.startsWith(`${browser}/`)) {
      return {
        reason: 'browser-profile',
        message:
          'browser profile data holds cookies, saved passwords, and session ' +
          'keys. Ask the user what they need instead.',
      };
    }
  }

  if (BROWSER_FILES.has(lowerLast) || BROWSER_FILES.has(last)) {
    return {
      reason: 'browser-profile',
      message:
        'that file is a browser credential or history store. Ask the user ' +
        'what they need instead.',
    };
  }

  for (const ext of KEY_EXTENSIONS) {
    if (!lowerLast.endsWith(ext)) continue;
    // A file whose name says it is public is not a secret, and test fixtures
    // full of public keys are common enough that denying them would be noise.
    // Nobody names a private key "public", so this carve-out cannot be used to
    // smuggle one past the list.
    if (lowerLast.startsWith('public') || lowerLast.endsWith('.pub')) continue;
    return {
      reason: 'private-key',
      message: `${ext} files hold private keys and are refused by default.`,
    };
  }

  if (REGISTRY_AUTH.has(dotPath) || REGISTRY_AUTH.has(lowerLast)) {
    return {
      reason: 'package-registry-auth',
      message: 'that file stores registry or package-manager credentials.',
    };
  }

  if (GENERIC_SECRETS.has(lowerLast) || GENERIC_SECRETS.has(last)) {
    return {
      reason: 'generic-secret',
      message: 'that filename is conventionally a secret.',
    };
  }

  return null;
}

/** Whether a path is refused by default. */
export function isSensitive(path: string): boolean {
  return classifySensitive(path) !== null;
}

/**
 * Whether an explicit grant covers this path.
 *
 * Grants are matched against the same normalised form and must cover the
 * whole path, so granting `.env` does not open `.env.production`. A grant may
 * also be a prefix, written with a trailing slash, which is the only way to
 * open a directory such as `.ssh/`.
 */
export function granted(path: string, grants: readonly string[]): boolean {
  const normalised = normalise(path);
  return grants.some((raw) => {
    const grant = normalise(raw);
    if (grant === '') return false;
    if (normalise(`${grant}/`) === normalised) return true;
    return grant.endsWith('/') ? false : normalised.startsWith(`${grant}/`);
  });
}

/**
 * The final verdict for a read: denied unless explicitly granted.
 *
 * Returns null when the read may proceed. Grants are matched against the same
 * normalised form as the classification, so a grant written with the platform
 * separator matches a path written with a forward slash, which is what every
 * caller produces.
 */
export function readDenied(path: string, grants: readonly string[] = []): Denial | null {
  const normalised = normalise(path);
  if (granted(normalised, grants)) return null;
  return classifySensitive(normalised);
}