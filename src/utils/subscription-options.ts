/**
 * [INPUT]: Source options and URI links with fragment or VMess JSON display names.
 * [OUTPUT]: Normalized source controls and case-insensitive name filtering.
 * [POS]: Runtime-neutral source selection used before previews and syncs.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import type { CliConfig, SubscriptionOptions } from '../types/cli-config';
import { subscriptionNodeName } from '../native/proxy';

export const normalizeSubscriptionOptions = (input?: Partial<SubscriptionOptions>): SubscriptionOptions => ({
  enabled: input?.enabled !== false,
  include: typeof input?.include === 'string' ? input.include.trim() : '',
  exclude: typeof input?.exclude === 'string' ? input.exclude.trim() : '',
  skipUnsupported: input?.skipUnsupported === true,
});

export const subscriptionOptionsForUrl = (config: CliConfig, url: string) => {
  const index = config.subscriptionUrls?.findIndex(value => value.trim() === url.trim()) ?? -1;
  return normalizeSubscriptionOptions(index < 0 ? undefined : config.subscriptionOptions?.[index]);
};

export const filterSubscriptionNodes = (nodes: string[], options: SubscriptionOptions) => {
  if (!options.enabled) return [];
  const include = options.include.toLowerCase();
  const exclude = options.exclude.toLowerCase();
  return nodes.filter(link => {
    let name = '';
    try { name = subscriptionNodeName(link).toLowerCase(); } catch { return false; }
    return (!include || name.includes(include)) && (!exclude || !name.includes(exclude));
  });
};
