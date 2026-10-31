import type { CliConfig, SubscriptionOptions } from '../types/cli-config';

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
    try { name = decodeURIComponent(new URL(link).hash.slice(1)).toLowerCase(); } catch { return false; }
    return (!include || name.includes(include)) && (!exclude || !name.includes(exclude));
  });
};
