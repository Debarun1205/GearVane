import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KeyVault, clearVault, readVault, writeVault, type VaultStorage } from '../src/keys-host.js';

/**
 * A fake secret store: reversible "encryption" with a marker byte, so the
 * tests can assert the file on disk is not plaintext without needing the
 * real platform keystore.
 */
function fakeStorage(available = true): VaultStorage & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => {
      seen.push(plain);
      return Buffer.concat([Buffer.from([0xfe]), Buffer.from(plain, 'utf8')]);
    },
    decryptString: (cipher: Buffer) => {
      if (cipher[0] !== 0xfe) throw new Error('not our ciphertext');
      return cipher.subarray(1).toString('utf8');
    },
  };
}

function vaultFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gearvane-vault-')), 'keys.vault');
}

describe('readVault', () => {
  it('reads an encrypted vault back', () => {
    const path = vaultFile();
    const storage = fakeStorage();
    writeVault(path, { OPENAI_API_KEY: 'sk-x' }, storage);
    expect(readVault(path, storage)).toEqual({
      keys: { OPENAI_API_KEY: 'sk-x' },
      persistent: true,
    });
  });

  it('hands the plaintext to the platform and writes only its output', () => {
    // The fake is not real encryption, so asserting "no plaintext on disk"
    // would only test the fake. What must hold is that this module never
    // assembles the file itself: the bytes come from the secret store, and
    // the keys it serialised reached that store.
    const path = vaultFile();
    const storage = fakeStorage();
    writeVault(path, { OPENAI_API_KEY: 'sk-secret-value' }, storage);
    expect(storage.seen).toEqual([JSON.stringify({ OPENAI_API_KEY: 'sk-secret-value' })]);
    expect(readFileSync(path).equals(Buffer.concat([
      Buffer.from([0xfe]),
      Buffer.from(JSON.stringify({ OPENAI_API_KEY: 'sk-secret-value' }), 'utf8'),
    ]))).toBe(true);
  });

  it('sanitizes what it hands back', () => {
    const path = vaultFile();
    const storage = fakeStorage();
    // A vault file edited on another machine, or by an older build, tries to
    // smuggle PATH and LD_PRELOAD past the allowlist.
    const planted = JSON.stringify({
      OPENAI_API_KEY: 'sk-x',
      PATH: '/bin',
      LD_PRELOAD: 'evil.so',
    });
    writeFileSync(path, Buffer.concat([Buffer.from([0xfe]), Buffer.from(planted, 'utf8')]));
    expect(readVault(path, storage).keys).toEqual({ OPENAI_API_KEY: 'sk-x' });
  });

  it('reads a missing file as empty', () => {
    expect(readVault(join(vaultFile(), 'absent'), fakeStorage()).keys).toEqual({});
  });

  it('reads an undecryptable file as empty rather than throwing', () => {
    // A different login, a re-imaged machine, a truncated write: the user is
    // asked again, which is recoverable.
    const path = vaultFile();
    writeFileSync(path, 'not ciphertext');
    expect(readVault(path, fakeStorage()).keys).toEqual({});
  });
});

describe('writeVault', () => {
  it('keeps keys in memory when the platform has no secret store', () => {
    const path = vaultFile();
    const state = writeVault(path, { OPENAI_API_KEY: 'sk-x' }, fakeStorage(false));
    expect(state).toEqual({ keys: { OPENAI_API_KEY: 'sk-x' }, persistent: false });
    // No plaintext on disk either: the platform cannot encrypt, so nothing is
    // written at all.
    expect(() => readFileSync(path)).toThrow();
  });
});

describe('clearVault', () => {
  it('removes the file', () => {
    const path = vaultFile();
    writeVault(path, { OPENAI_API_KEY: 'sk-x' }, fakeStorage());
    clearVault(path);
    expect(readVault(path, fakeStorage()).keys).toEqual({});
  });
});

describe('KeyVault', () => {
  it('round-trips through the encrypted file', () => {
    const path = vaultFile();
    const storage = fakeStorage();
    writeVault(path, { ANTHROPIC_API_KEY: 'sk-ant' }, storage);
    const vault = new KeyVault(() => path, storage);
    expect(vault.keys()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(vault.persistent()).toBe(true);
  });

  it('drops everything outside the allowlist on save', () => {
    const vault = new KeyVault(() => vaultFile(), fakeStorage());
    const saved = vault.save({ OPENAI_API_KEY: 'sk-x', PATH: '/bin', LD_PRELOAD: 'x.so' });
    expect(saved).toEqual({ OPENAI_API_KEY: 'sk-x' });
    expect(vault.keys()).toEqual({ OPENAI_API_KEY: 'sk-x' });
  });

  it('forgets everything on clear', () => {
    const path = vaultFile();
    const storage = fakeStorage();
    const vault = new KeyVault(() => path, storage);
    vault.save({ OPENAI_API_KEY: 'sk-x' });
    vault.clear();
    expect(vault.keys()).toEqual({});
    expect(readVault(path, storage).keys).toEqual({});
  });

  it('layers vault keys over the shell environment', () => {
    const vault = new KeyVault(() => vaultFile(), fakeStorage());
    vault.save({ OPENAI_API_KEY: 'sk-vault' });
    const env = vault.env();
    expect(env['OPENAI_API_KEY']).toBe('sk-vault');
    // The rest of the environment still reaches the child.
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });

  it('reports a session-only vault when the platform cannot encrypt', () => {
    const vault = new KeyVault(() => vaultFile(), fakeStorage(false));
    expect(vault.persistent()).toBe(false);
    // The keys still work for this session, which is what the dialog offers.
    expect(vault.save({ OPENAI_API_KEY: 'sk-x' }).OPENAI_API_KEY).toBe('sk-x');
    expect(vault.keys().OPENAI_API_KEY).toBe('sk-x');
  });

  it('hands out a copy, so a caller cannot mutate the vault', () => {
    const vault = new KeyVault(() => vaultFile(), fakeStorage());
    vault.save({ OPENAI_API_KEY: 'sk-x' });
    vault.keys().OPENAI_API_KEY = 'tampered';
    expect(vault.keys().OPENAI_API_KEY).toBe('sk-x');
  });

  it('resolves the path on first use, not at construction', () => {
    // app.getPath('userData') is only valid after the app is ready. Reading at
    // import time found a path Electron never writes, so every relaunch came
    // back with an empty vault.
    const path = vaultFile();
    const storage = fakeStorage();
    writeVault(path, { OPENAI_API_KEY: 'sk-x' }, storage);
    let resolved = 0;
    const vault = new KeyVault(() => {
      resolved += 1;
      return path;
    }, storage);
    expect(resolved).toBe(0);
    expect(vault.keys().OPENAI_API_KEY).toBe('sk-x');
    expect(resolved).toBe(1);
    // Cached: later calls reuse the same file rather than re-reading it.
    expect(vault.keys().OPENAI_API_KEY).toBe('sk-x');
    expect(resolved).toBe(1);
  });
});