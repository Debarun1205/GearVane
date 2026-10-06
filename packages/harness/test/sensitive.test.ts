import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifySensitive,
  granted,
  isSensitive,
  readDenied,
  type DenialReason,
} from '../src/workspace/sensitive.js';
import { readFileTool, DEFAULT_MAX_READ_BYTES } from '../src/tools/fs.js';
import { searchFilesTool } from '../src/tools/search.js';
import { Workspace } from '../src/workspace/containment.js';
import { validateArgs, type ToolContext } from '../src/tools/types.js';

/**
 * Default-deny for credential-shaped paths.
 *
 * The table is the specification of what counts as a secret by name. It has to
 * be narrow enough that ordinary work is unaffected and broad enough to catch
 * the paths that actually hold keys, because the failure modes are very
 * different: a false positive costs one explicit override, a miss puts a live
 * credential in a context window on its way to a provider.
 */

const denied: Array<[string, DenialReason]> = [
  ['.env', 'dotenv'],
  ['.env.local', 'dotenv'],
  ['.env.production', 'dotenv'],
  ['config/.env', 'dotenv'],
  ['apps/api/.env', 'dotenv'],
  ['.ssh/config', 'credentials-dir'],
  ['.ssh/known_hosts', 'credentials-dir'],
  ['.aws/credentials', 'credentials-dir'],
  ['.gnupg/secring.gpg', 'credentials-dir'],
  ['.kube/config', 'credentials-dir'],
  ['.docker/config.json', 'credentials-dir'],
  ['.git/config', 'git-config'],
  ['server.pem', 'private-key'],
  ['certs/private.key', 'private-key'],
  ['bundle.p12', 'private-key'],
  ['keystore.jks', 'private-key'],
  ['id_ed25519', 'generic-secret'],
  ['.ssh/id_rsa', 'credentials-dir'],
  ['credentials.json', 'generic-secret'],
  ['service-account.json', 'generic-secret'],
  ['secrets.json', 'generic-secret'],
  ['.htpasswd', 'generic-secret'],
  ['wallet.dat', 'generic-secret'],
  ['.npmrc', 'package-registry-auth'],
  ['.netrc', 'package-registry-auth'],
  ['.pypirc', 'package-registry-auth'],
  ['.git-credentials', 'package-registry-auth'],
  ['AppData/Local/Google/Chrome/User Data/Default/Login Data', 'browser-profile'],
  ['.mozilla/firefox/abc.default/key4.db', 'browser-profile'],
  ['Library/Application Support/Google/Chrome/cookies.sqlite', 'browser-profile'],
];

describe('classifySensitive', () => {
  it.each(denied)('denies %s', (path, reason) => {
    expect(classifySensitive(path)?.reason).toBe(reason);
    expect(isSensitive(path)).toBe(true);
  });

  const allowed: Array<[string, string]> = [
    ['.env.example', 'a committed template, not a secret'],
    ['.env.sample', 'same'],
    ['.env.template', 'same'],
    ['.env.schema.example', 'same'],
    ['src/index.ts', 'source code'],
    ['package.json', 'project manifest'],
    ['README.md', 'documentation'],
    ['src/environment.ts', 'a source file that merely sounds like .env'],
    ['test/keys.test.ts', 'a test about key handling'],
    ['config/database.yml', 'configuration, no credentials named'],
    ['app/keyboard.py', 'a module named after a keyboard'],
    ['.gitignore', 'the ignore file itself'],
    ['docs/licences.md', 'documentation'],
    ['fixtures/public.key', 'a PUBLIC key is not a secret'],
    ['', 'the root itself'],
  ];

  it.each(allowed)('allows %s (%s)', (path) => {
    expect(classifySensitive(path)).toBeNull();
    expect(isSensitive(path)).toBe(false);
  });

  it('ignores path shape tricks', () => {
    // Trailing slashes and ./ prefixes must not change the verdict, or a
    // model bypasses the list with punctuation alone.
    expect(isSensitive('.env/')).toBe(true);
    expect(isSensitive('./.env')).toBe(true);
    expect(isSensitive('.ssh/')).toBe(true);
    expect(isSensitive('a/b/../.env')).toBe(true);
    expect(isSensitive('.\\.env')).toBe(true);
  });

  it('classifies the same file however it is spelled', () => {
    // toRelative hands back the native separator; a POSIX-spelled path from a
    // model must classify identically on Windows.
    expect(classifySensitive('config/.env')?.reason).toBe(
      classifySensitive('config\\.env')?.reason,
    );
  });
});

describe('granted', () => {
  it('matches one path exactly', () => {
    expect(granted('.env', ['.env'])).toBe(true);
    expect(granted('.env.local', ['.env'])).toBe(false);
  });

  it('matches a directory prefix', () => {
    expect(granted('.ssh/id_rsa', ['.ssh'])).toBe(true);
    expect(granted('.ssh/nested/deep/key', ['.ssh'])).toBe(true);
    expect(granted('.sshx/id_rsa', ['.ssh'])).toBe(false);
  });

  it('matches an exact directory entry', () => {
    expect(granted('.ssh', ['.ssh'])).toBe(true);
  });
});

describe('readDenied', () => {
  it('denies by default', () => {
    expect(readDenied('.env')?.reason).toBe('dotenv');
  });

  it('allows an explicit grant', () => {
    expect(readDenied('.env', ['.env'])).toBeNull();
  });

  it('does not let a grant leak to a sibling', () => {
    // Granting .env must not open .env.production, or one approval would
    // silently cover every other environment file in the project.
    expect(readDenied('.env.production', ['.env'])).not.toBeNull();
  });
});

describe('the read tools', () => {
  let root: string;

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'gearvane-secret-')), 'project');
    await mkdir(root, { recursive: true });
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-real-looking-secret\n');
    await writeFile(join(root, 'config', 'app.pem'), '-----BEGIN PRIVATE KEY-----\n');
    await writeFile(join(root, 'src.ts'), 'const key = "sk-real-looking-secret";\n');
  });

  function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      workspace: new Workspace(root),
      maxReadBytes: DEFAULT_MAX_READ_BYTES,
      ...overrides,
    };
  }

  async function read(path: string, overrides: Partial<ToolContext> = {}) {
    const tool = readFileTool;
    const args = validateArgs(tool.schema, { path });
    return tool.execute(args, ctx(overrides));
  }

  it('refuses to read .env and never returns its content', async () => {
    const result = await read('.env');
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain('sk-real-looking-secret');
    // The refusal must not distinguish "exists" from "missing", or it becomes
    // an existence oracle.
    const missing = await read('.env.absent');
    expect(missing.ok).toBe(false);
    expect(result.content).toContain('.env');
  });

  it('reads normally once the user grants the path', async () => {
    const result = await read('.env', { allowSensitive: ['.env'] });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('sk-real-looking-secret');
  });

  it('still reads ordinary files', async () => {
    const result = await read('src.ts');
    expect(result.ok).toBe(true);
    expect(result.content).toContain('sk-real-looking-secret');
  });

  it('refuses a sensitive path reached with a traversal', async () => {
    // src/../.env resolves inside the workspace, so containment allows it.
    // The deny-list must classify the resolved form, not the literal one.
    const result = await read('config/../.env');
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain('sk-real-looking-secret');
  });

  it('withholds a sensitive file from search rather than returning it', async () => {
    const args = validateArgs(searchFilesTool.schema, { query: 'sk-real-looking-secret' });
    const result = await searchFilesTool.execute(args, ctx());
    expect(result.content).not.toContain('.env:');
    // src.ts is found; the .env is not, and the difference is stated.
    expect(result.content).toContain('src.ts');
    expect(result.content).toContain('withheld');
  });

  it('searches a sensitive file once granted', async () => {
    const args = validateArgs(searchFilesTool.schema, { query: 'sk-real-looking-secret' });
    const result = await searchFilesTool.execute(args, ctx({ allowSensitive: ['.env'] }));
    expect(result.content).toContain('.env:');
  });
});