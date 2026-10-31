export const LEGACY_SUBSCRIPTION_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export const DEFAULT_SUBSCRIPTION_HEADERS = {
  accept: 'application/yaml,text/yaml,application/json,text/plain,*/*',
  'user-agent': 'clash.meta',
};

export const subscriptionHeaders = (input: Record<string, string> = {}) => {
  // Canonicalize before merging so an explicit User-Agent overrides the lowercase default.
  const headers = { ...DEFAULT_SUBSCRIPTION_HEADERS } as Record<string, string>;
  for (const [name, value] of Object.entries(input)) headers[name.toLowerCase()] = value;
  // Migrate only the browser identity previously shipped by this app; preserve custom clients.
  if (headers['user-agent'] === LEGACY_SUBSCRIPTION_USER_AGENT) headers['user-agent'] = 'clash.meta';
  return headers;
};
