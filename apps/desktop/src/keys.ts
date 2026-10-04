/**
 * Bring-your-own-keys for hosted providers.
 *
 * Local models need nothing, but the mid and frontier tiers only exist when
 * an API key is present. On a server or a dev machine that key lives in the
 * shell environment; inside the desktop app and especially the Android
 * webview there is no environment to read, so the app keeps a device-local
 * vault and sends the keys only as Bearer tokens to provider endpoints.
 *
 * The vault lives in localStorage beside the appearance settings. Keys are
 * never written to a config file, a log, the transcript, or health output,
 * and the agent IPC accepts them only through an allowlist below: a
 * renderer-supplied environment must never reach the main process intact,
 * or it could override PATH and friends.
 */

export interface KeyField {
  /** Environment variable the providers read. */
  env: string;
  /** Short human label for the dialog. */
  label: string;
}

export const KEY_FIELDS: readonly KeyField[] = [
  { env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { env: 'OPENAI_API_KEY', label: 'OpenAI' },
  { env: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
  { env: 'MODEL_API_KEY', label: 'Meta (Muse Spark)' },
  { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { env: 'GEMINI_API_KEY', label: 'Gemini' },
  { env: 'MISTRAL_API_KEY', label: 'Mistral' },
  { env: 'XAI_API_KEY', label: 'xAI' },
  { env: 'LONGCAT_API_KEY', label: 'LongCat' },
  { env: 'TOGETHER_API_KEY', label: 'Together' },
  { env: 'GROQ_API_KEY', label: 'Groq' },
];

/** The allowlist the main process enforces on renderer-supplied keys. */
const ALLOWED_ENVS = new Set(KEY_FIELDS.map((field) => field.env));

/** Minimal storage surface, so the helpers test without a DOM. */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'waypoint.keys';

/**
 * Keep only known key variables with non-empty string values, trimmed.
 * Everything else is dropped, so a compromised renderer cannot smuggle
 * unrelated environment entries through the agent IPC.
 */
export function sanitizeKeys(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_ENVS.has(name)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') out[name] = trimmed;
  }
  return out;
}

/** Read the vault; corrupt JSON reads as empty rather than crashing boot. */
export function loadKeys(storage: KeyStorage): Record<string, string> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    return sanitizeKeys(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** Persist the vault (already sanitized by the dialog before saving). */
export function saveKeys(storage: KeyStorage, keys: Record<string, string>): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitizeKeys(keys)));
  } catch {
    // Device-local and non-essential; a full quota must not break the app.
  }
}

/** Forget every stored key. */
export function clearKeys(storage: KeyStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Already gone or storage disabled; either way the goal is met.
  }
}

/** Whether any key is stored, for the header button state. */
export function hasKeys(storage: KeyStorage): boolean {
  return Object.keys(loadKeys(storage)).length > 0;
}
