import { describe, expect, it } from 'vitest';

import {
  KEY_FIELDS,
  clearKeys,
  hasKeys,
  loadKeys,
  sanitizeKeys,
  saveKeys,
  type KeyStorage,
} from '../src/keys.js';

function memoryStorage(initial?: string): KeyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set('gearvane.keys', initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('key fields', () => {
  it('covers every hosted provider the core can route to', () => {
    const envs = KEY_FIELDS.map((field) => field.env);
    for (const env of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'MODEL_API_KEY',
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'LONGCAT_API_KEY',
      'TOGETHER_API_KEY',
      'GROQ_API_KEY',
    ]) {
      expect(envs).toContain(env);
    }
    expect(new Set(envs).size).toBe(envs.length);
  });
});

describe('sanitizeKeys', () => {
  it('keeps known keys and trims pasted whitespace', () => {
    expect(sanitizeKeys({ ANTHROPIC_API_KEY: '  sk-ant-x  ', PATH: '/bin' })).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-x',
    });
  });

  it('drops empty and non-string values', () => {
    expect(
      sanitizeKeys({ OPENAI_API_KEY: '   ', GEMINI_API_KEY: 42, MISTRAL_API_KEY: null }),
    ).toEqual({});
  });

  it('reads non-objects as empty', () => {
    expect(sanitizeKeys(null)).toEqual({});
    expect(sanitizeKeys('sk-ant-x')).toEqual({});
    expect(sanitizeKeys(undefined)).toEqual({});
  });
});

describe('key vault', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    saveKeys(storage, { OPENAI_API_KEY: 'sk-x' });
    expect(loadKeys(storage)).toEqual({ OPENAI_API_KEY: 'sk-x' });
    expect(hasKeys(storage)).toBe(true);
  });

  it('sanitizes on save, so hand-edited values cannot smuggle variables', () => {
    const storage = memoryStorage();
    saveKeys(storage, { OPENAI_API_KEY: 'sk-x', PATH: '/bin' });
    expect(loadKeys(storage)).toEqual({ OPENAI_API_KEY: 'sk-x' });
  });

  it('reads corrupt JSON as empty', () => {
    expect(loadKeys(memoryStorage('not json{'))).toEqual({});
    expect(hasKeys(memoryStorage('not json{'))).toBe(false);
  });

  it('forgets everything on clear', () => {
    const storage = memoryStorage();
    saveKeys(storage, { OPENAI_API_KEY: 'sk-x' });
    clearKeys(storage);
    expect(loadKeys(storage)).toEqual({});
    expect(hasKeys(storage)).toBe(false);
  });

  it('migrates a pre-rename waypoint.keys vault forward once', () => {
    const storage = memoryStorage();
    storage.data.set('waypoint.keys', JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    expect(loadKeys(storage)).toEqual({ OPENAI_API_KEY: 'sk-x' });
    expect(storage.data.get('gearvane.keys')).toContain('sk-x');
  });

  it('never throws when storage is disabled', () => {
    const broken: KeyStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadKeys(broken)).toEqual({});
    expect(hasKeys(broken)).toBe(false);
    expect(() => saveKeys(broken, { OPENAI_API_KEY: 'sk-x' })).not.toThrow();
    expect(() => clearKeys(broken)).not.toThrow();
  });
});
