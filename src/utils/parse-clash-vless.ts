import { parse as parseYaml } from 'yaml';

type ClashProxy = {
  name?: unknown;
  type?: unknown;
  server?: unknown;
  port?: unknown;
  uuid?: unknown;
  tls?: unknown;
  servername?: unknown;
  sni?: unknown;
  'skip-cert-verify'?: unknown;
  flow?: unknown;
  network?: unknown;
  'client-fingerprint'?: unknown;
  'packet-encoding'?: unknown;
  'reality-opts'?: {
    'public-key'?: unknown;
    'short-id'?: unknown;
  };
  'ws-opts'?: {
    path?: unknown;
    headers?: Record<string, unknown>;
  };
  'grpc-opts'?: {
    'grpc-service-name'?: unknown;
    'service-name'?: unknown;
  };
  'http-opts'?: {
    path?: unknown;
    headers?: Record<string, unknown>;
  };
};

const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const asBoolean = (value: unknown) => value === true || value === 'true' || value === 1;

const firstHeader = (headers: Record<string, unknown> | undefined, names: string[]) => {
  if (!headers) return '';
  for (const name of names) {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const result = asString(value);
    if (result) return result;
  }
  return '';
};

const encoded = (value: string) => encodeURIComponent(value);

const formatServer = (server: string) => (server.includes(':') && !server.startsWith('[') ? `[${server}]` : server);

const clashProxyToVless = (proxy: ClashProxy) => {
  const name = asString(proxy.name);
  const server = asString(proxy.server);
  const uuid = asString(proxy.uuid);
  const port = Number(proxy.port);
  if (!server || !uuid || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  const params = new URLSearchParams();
  params.set('encryption', 'none');

  const reality = proxy['reality-opts'];
  const publicKey = asString(reality?.['public-key']);
  const shortId = asString(reality?.['short-id']);
  if (publicKey) {
    params.set('security', 'reality');
    params.set('pbk', publicKey);
    if (shortId) params.set('sid', shortId);
  } else if (asBoolean(proxy.tls)) {
    params.set('security', 'tls');
  }

  const serverName = asString(proxy.servername) || asString(proxy.sni);
  if (serverName) params.set('sni', serverName);

  if (asBoolean(proxy['skip-cert-verify'])) params.set('allowInsecure', '1');
  const fingerprint = asString(proxy['client-fingerprint']);
  if (fingerprint) params.set('fp', fingerprint);
  const flow = asString(proxy.flow);
  if (flow) params.set('flow', flow);
  const packetEncoding = asString(proxy['packet-encoding']);
  if (packetEncoding) params.set('packetEncoding', packetEncoding);

  const network = asString(proxy.network).toLowerCase();
  if (network) params.set('type', network === 'h2' ? 'http' : network);

  const transport = network === 'ws' ? proxy['ws-opts'] : network === 'grpc' ? proxy['grpc-opts'] : proxy['http-opts'];
  if (network === 'ws') {
    const path = asString(proxy['ws-opts']?.path);
    const host = firstHeader(proxy['ws-opts']?.headers, ['host']);
    if (path) params.set('path', path);
    if (host) params.set('host', host);
  } else if (network === 'grpc') {
    const grpc = proxy['grpc-opts'];
    const serviceName = asString(grpc?.['grpc-service-name']) || asString(grpc?.['service-name']);
    if (serviceName) params.set('serviceName', serviceName);
  } else if (network === 'http' || network === 'h2' || network === 'httpupgrade') {
    const http = proxy['http-opts'];
    const path = asString(http?.path);
    const host = firstHeader(http?.headers, ['host']);
    if (path) params.set('path', path);
    if (host) params.set('host', host);
  }

  const query = params.toString();
  return `vless://${encoded(uuid)}@${formatServer(server)}:${port}?${query}${name ? `#${encoded(name)}` : ''}`;
};

export const parseClashVlessNodes = (raw: string): string[] => {
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch {
    return [];
  }

  if (!document || typeof document !== 'object' || !Array.isArray((document as { proxies?: unknown }).proxies)) {
    return [];
  }

  return (document as { proxies: unknown[] }).proxies.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const proxy = entry as ClashProxy;
    return asString(proxy.type).toLowerCase() === 'vless' ? [clashProxyToVless(proxy)].filter(Boolean) : [];
  }) as string[];
};
