import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ConfigError,
  defaultConfig,
  parseConfig,
  type GearVaneConfig,
} from '@gearvane/core';

/**
 * Searched in order when no config path is given.
 *
 * Includes config.example.yaml so this CLI behaves like the Python one in a
 * fresh checkout, where the example is the only config present. Without it
 * the two CLIs would route the same prompt to different tiers purely because
 * of which file they happened to find.
 */
const CONFIG_FILENAMES = [
  'gearvane.config.json',
  'gearvane.config.yaml',
  'gearvane.yaml',
  'config.yaml',
  'config.example.yaml',
  '.gearvane/config.yaml',
];

export interface LoadResult {
  config: GearVaneConfig;
  /** Where the config came from, or null when built-in defaults were used. */
  path: string | null;
  /** Human-readable note about a fallback, for stderr. */
  note?: string;
}

/**
 * Load configuration.
 *
 * Search order: explicit path, then the working directory, then each
 * ancestor directory, then the home directory. Falling back to built-in
 * defaults means a fresh install runs with no setup at all.
 */
export function loadConfig(explicitPath?: string): LoadResult {
  if (explicitPath) {
    const path = resolve(explicitPath);
    if (!existsSync(path)) {
      throw new ConfigError(`Config file not found: ${explicitPath}`);
    }
    return { config: readConfigFile(path), path };
  }

  for (const candidate of searchPaths()) {
    if (!existsSync(candidate)) continue;

    const extension = candidate.split('.').pop();
    const format = extension === 'json' ? 'json' : 'yaml';

    try {
      return {
        config: readConfigFile(candidate, format),
        path: candidate,
        note: `Loaded config from ${candidate}`,
      };
    } catch (error) {
      throw new ConfigError(
        `Failed to load ${candidate}: ${(error as Error).message}`,
      );
    }
  }

  return {
    config: defaultConfig(process.env as Record<string, string | undefined>),
    path: null,
    note: 'No config file found; using built-in defaults',
  };
}

function searchPaths(): string[] {
  const paths: string[] = [];

  let current = process.cwd();
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      paths.push(join(current, name));
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }

  try {
    for (const name of CONFIG_FILENAMES) {
      paths.push(join(homedir(), name));
    }
  } catch {
    // No home directory available; the cwd search is enough.
  }

  return paths;
}

function readConfigFile(path: string, format?: 'yaml' | 'json'): GearVaneConfig {
  const text = readFileSync(path, 'utf8');

  // An empty file is a valid config that overrides nothing.
  if (text.trim() === '') return defaultConfig();

  return parseConfig(text, format ?? (path.endsWith('.json') ? 'json' : 'yaml'));
}

export { defaultConfig };