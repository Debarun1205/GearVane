/**
 * Key vault storage in the main process, encrypted by the OS.
 *
 * The renderer used to keep API keys in localStorage, which is plaintext on
 * disk: any process that can read the profile directory — a backup, a synced
 * folder, another user on a shared machine, a crash dump — recovers every key
 * the user ever entered. Electron's `safeStorage` hands the encryption to the
 * platform (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux),
 * so the file on disk is ciphertext that only this user's login can open.
 *
 * ## What this is not
 *
 * This is encryption at rest, not containment. A key is still in renderer
 * memory while a hosted run is in flight, because the renderer has to see which
 * providers are keyed and has to hand the value to the agent IPC. It protects
 * the file, not a live process.
 *
 * ## Fallback
 *
 * If the platform has no usable secret store (a Linux box with no keyring
 * daemon, usually), `safeStorage.isEncryptionAvailable()` is false. The vault
 * then stays in memory for the session and the renderer is told, so the UI can
 * say keys will not survive a restart. It never falls back to writing plaintext.
 */

import { app, safeStorage, type SafeStorage } from 'electron';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KEY_FIELDS, sanitizeKeys } from './keys.js';

const FILE_NAME = 'keys.vault';

const ALLOWED_ENVS = new Set(KEY_FIELDS.map((field) => field.env));

export interface VaultState {
  keys: Record<string, string>;
  /** False when the platform has no secret store: keys live only in memory. */
  persistent: boolean;
}

/** The slice of Electron's safeStorage this module uses, so tests can inject one. */
export interface VaultStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/**
 * Read the vault.
 *
 * A file that will not decrypt — a different login, a re-imaged machine, a
 * corrupted write — reads as empty rather than throwing. The user is asked for
 * keys again, which is recoverable; refusing to start is not.
 */
export function readVault(
  path: string,
  storage: VaultStorage = safeStorage as unknown as SafeStorage,
): VaultState {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return { keys: {}, persistent: storage.isEncryptionAvailable() };
  }

  if (!storage.isEncryptionAvailable()) {
    // Written by a machine that had a keyring; this one does not. Reading it
    // would need the plaintext, which was never written, so there is nothing
    // to salvage.
    return { keys: {}, persistent: false };
  }

  try {
    const parsed: unknown = JSON.parse(storage.decryptString(raw));
    return { keys: sanitizeKeys(parsed), persistent: true };
  } catch {
    return { keys: {}, persistent: true };
  }
}

/**
 * Write the vault, encrypting through the platform when it can.
 *
 * Written to a sibling file and renamed, so a crash mid-write leaves the
 * previous vault intact instead of a truncated ciphertext nobody can open.
 */
export function writeVault(
  path: string,
  keys: Record<string, string>,
  storage: VaultStorage = safeStorage as unknown as SafeStorage,
): VaultState {
  const clean = sanitizeKeys(keys);
  if (!storage.isEncryptionAvailable()) {
    return { keys: clean, persistent: false };
  }

  const cipher = storage.encryptString(JSON.stringify(clean));
  const partial = `${path}.new`;
  try {
    writeFileSync(partial, cipher, { mode: 0o600 });
    renameSync(partial, path);
  } catch {
    try {
      unlinkSync(partial);
    } catch {
      // Best effort; a stale .new is ignored on the next write.
    }
  }
  return { keys: clean, persistent: true };
}

/** Forget every stored key. */
export function clearVault(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone; the goal is met either way.
  }
}

/**
 * Hold the vault for the session.
 *
 * The main process is the only reader of the encrypted file, so keys are
 * decrypted once at startup and cached here rather than re-read per call.
 */
export class KeyVault {
  private state: VaultState;
  private path: string;
  private readonly storage: VaultStorage;

  /**
   * Takes a path function, not a path.
   *
   * `safeStorage` and `app.getPath('userData')` are only meaningful once the
   * app is ready, and neither answers correctly before that: an encrypted
   * vault built at import time reads back empty on every launch. Resolving
   * the path lazily on first use keeps the vault a single instance while
   * still reading exactly once.
   */
  constructor(
    private readonly resolvePath: () => string,
    storage?: VaultStorage,
  ) {
    this.path = '';
    this.storage = storage ?? (safeStorage as unknown as SafeStorage);
    this.state = { keys: {}, persistent: true };
  }

  /** Read the file once, on first use. */
  private ensureLoaded(): void {
    if (this.path === '') {
      this.path = this.resolvePath();
      this.state = readVault(this.path, this.storage);
    }
  }

  keys(): Record<string, string> {
    this.ensureLoaded();
    return { ...this.state.keys };
  }

  persistent(): boolean {
    this.ensureLoaded();
    return this.state.persistent;
  }

  /** Only allowlisted variables, trimmed, and nothing else survives the IPC. */
  save(input: unknown): Record<string, string> {
    this.ensureLoaded();
    this.state = writeVault(this.path, sanitizeKeys(input), this.storage);
    return this.keys();
  }

  clear(): void {
    this.ensureLoaded();
    clearVault(this.path);
    this.state = { keys: {}, persistent: this.storage.isEncryptionAvailable() };
  }

  /**
   * Environment for a hosted run: the shell, with vault keys winning.
   *
   * Keys were entered for this device after the process started, so they are
   * more current than the shell it inherited.
   */
  env(): Record<string, string | undefined> {
    return { ...process.env, ...this.state.keys } as Record<string, string | undefined>;
  }
}

/**
 * The vault file, resolved late.
 *
 * `app.getPath` is only valid after the app is ready, so this is a function
 * rather than a value: calling it at import time yields a path that is not
 * where Electron later writes.
 */
export function vaultPath(): () => string {
  return () => join(app.getPath('userData'), FILE_NAME);
}

/** Keep the allowlist in one place: the vault and the renderer must agree. */
export { ALLOWED_ENVS };