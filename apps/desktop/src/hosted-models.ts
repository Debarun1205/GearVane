/**
 * Hosted roster for the Models dialog.
 *
 * Pure function of the active config plus the vault, so the grouping and
 * key states pin down in unit tests: the renderer itself needs a DOM and
 * only runs under Playwright, where a fresh profile never has keys.
 */

import type { ProviderConfig, GearVaneConfig } from '@gearvane/core';
import { LOCAL_PROVIDER_NAMES } from '@gearvane/core';

export type HostedTier = 'mid' | 'frontier';

export interface HostedRow {
  tier: HostedTier;
  label: string;
  keyed: boolean;
  /** Local providers never take keys; the row says so instead. */
  keyless: boolean;
}

/**
 * Whether the vault holds a key this provider would accept: its declared
 * variable or the NAME_API_KEY convention. Shell-environment keys are
 * invisible here, so callers must label this vault state, not capability.
 */
export function keyStateFor(
  provider: { name: string; apiKeyEnv?: string },
  keys: Record<string, string>,
): boolean {
  const candidates = [
    provider.apiKeyEnv,
    `${provider.name.toUpperCase().replace(/-/g, '_')}_API_KEY`,
  ];
  return candidates.some((name) => name !== undefined && keys[name] !== undefined);
}

/** Every configured hosted model, tier by tier, with vault key state. */
export function hostedModelRows(
  config: GearVaneConfig,
  keys: Record<string, string>,
): HostedRow[] {
  const rows: HostedRow[] = [];
  for (const tier of ['mid', 'frontier'] as const) {
    const providers: ProviderConfig[] = config.tiers[tier]?.providers ?? [];
    for (const provider of providers) {
      // A local provider inside a hosted tier (the embedded mid-tier
      // weights) needs no key and must never read as "needs key".
      const keyless = LOCAL_PROVIDER_NAMES.includes(provider.name.toLowerCase().trim());
      for (const model of provider.models) {
        rows.push({
          tier,
          label: `${provider.name}/${model}`,
          keyed: keyless || keyStateFor(provider, keys),
          keyless,
        });
      }
    }
  }
  return rows;
}
