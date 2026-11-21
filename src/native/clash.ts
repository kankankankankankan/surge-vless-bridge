/**
 * [INPUT]: A non-VLESS Clash record, native TLS validation and common policy mappings.
 * [OUTPUT]: A canonical share link validated by the native protocol converter.
 * [POS]: Clash-to-native adapter; VLESS retains the established Clash mapping.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { SubscriptionError } from '../utils/subscription-error';
import { UnsupportedNativeNodeError } from './proxy';
import { normalizeCertificateFingerprint } from './tls';
import { nativePolicyKeys, nativePolicyParameters } from './parameters';

export const clashNativeProxyToLink = (proxy: Record<string, unknown>, index: number): string => {
  const fail = (message: string): never => { throw new SubscriptionError(`Clash 第 ${index + 1} 个节点：${message}`); };
  const unsupported = (message: string): never => { throw new UnsupportedNativeNodeError(`Clash 第 ${index + 1} 个节点：${message}`); };
  const str = (value: unknown) => typeof value === 'string' ? value : '';
  const obj = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const bool = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
  const protocol = str(proxy.type).toLowerCase();
  for (const key of ['tls', 'skip-cert-verify', 'udp', 'reuse']) {
    if (proxy[key] !== undefined && ![true, false, 1, 0, 'true', 'false', '1', '0'].includes(proxy[key] as string)) fail(`${key} 必须为布尔值。`);
  }
  if (proxy['name-cert-verify'] !== undefined && proxy['server-cert-verify-name'] !== undefined
    && proxy['name-cert-verify'] !== proxy['server-cert-verify-name']) fail('证书校验名称别名不一致。');
  const allowed = new Set(['name', 'type', 'server', 'port', 'udp', 'password']);
  nativePolicyKeys.forEach(key => allowed.add(key));
  if (protocol !== 'ss') ['tls', 'sni', 'servername', 'skip-cert-verify', 'alpn', 'client-fingerprint', 'fingerprint', 'name-cert-verify', 'server-cert-verify-name', 'client-cert']
    .forEach(key => allowed.add(key));
  const protocolKeys: Record<string, string[]> = {
    ss: ['cipher', 'plugin', 'plugin-opts'], vmess: ['uuid', 'network', 'ws-opts', 'cipher', 'alterId'],
    trojan: ['network', 'ws-opts'], anytls: ['reuse'], hysteria2: ['obfs', 'obfs-password', 'ports', 'mport', 'hop-interval', 'down'],
    tuic: ['token', 'uuid', 'version', 'ports', 'hop-interval'], 'tuic-v5': ['uuid', 'version', 'ports', 'hop-interval'],
  };
  protocolKeys[protocol]?.forEach(key => allowed.add(key));
  if (Object.keys(proxy).some(key => !allowed.has(key) && proxy[key] !== undefined && proxy[key] !== false)) {
    unsupported('存在尚未映射的原生协议参数。');
  }
  const server = str(proxy.server);
  const port = Number(proxy.port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) fail('缺少有效的 server 或 port。');
  let url: URL;
  try {
    url = new URL(`${protocol}://${server.includes(':') ? `[${server}]` : server}:${port}`);
    if (url.username || url.password || url.pathname || url.search || url.hash) fail('server 格式无效。');
  } catch { return fail('server 格式无效。'); }
  const q = url.searchParams;
  for (const [key, value] of Object.entries(nativePolicyParameters(proxy))) q.set(key, value);
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
  };
  const alpn = proxy.alpn;
  if (alpn !== undefined && (!Array.isArray(alpn) || alpn.some(value => typeof value !== 'string' || !value || value.includes(',')))) fail('alpn 必须为字符串列表。');
  const sni = str(proxy.servername ?? proxy.sni);
  add('sni', sni);
  if (bool(proxy['skip-cert-verify'])) add('insecure', '1');
  if (Array.isArray(alpn)) add('alpn', alpn.join(','));
  add('fp', proxy['client-fingerprint']);
  // Clash fingerprint is a certificate digest, not a client TLS fingerprint.
  const fingerprint = proxy.fingerprint ? normalizeCertificateFingerprint(proxy.fingerprint) : undefined;
  add('pinSHA256', fingerprint);
  add('vcn', proxy['name-cert-verify'] ?? proxy['server-cert-verify-name']);
  add('client-cert', proxy['client-cert']);
  if (proxy.tls === false && !['ss', 'vmess'].includes(protocol)) fail('该协议必须启用 TLS。');
  if (protocol === 'vmess') {
    const network = str(proxy.network) || 'tcp';
    const ws = obj(proxy['ws-opts']);
    const headers = obj(ws.headers);
    if (Object.keys(ws).some(key => !['path', 'headers'].includes(key))) unsupported('VMess WebSocket 参数尚未映射。');
    if (Object.keys(headers).some(key => key.toLowerCase() !== 'host')) unsupported('VMess 目前仅映射 WebSocket Host 请求头。');
    const host = Object.entries(headers).find(([key]) => key.toLowerCase() === 'host')?.[1];
    if (host !== undefined && typeof host !== 'string') fail('WebSocket Host 必须为字符串。');
    const value = {
      v: '2', ps: str(proxy.name), add: server, port, id: str(proxy.uuid), aid: proxy.alterId ?? 0,
      scy: str(proxy.cipher) || 'auto', net: network, type: 'none', tls: bool(proxy.tls) ? 'tls' : '',
      sni, alpn: Array.isArray(alpn) ? alpn.join(',') : '', host: str(host), path: str(ws.path),
      allowInsecure: bool(proxy['skip-cert-verify']), fp: str(proxy['client-fingerprint']),
      pcs: fingerprint, vcn: str(proxy['name-cert-verify'] ?? proxy['server-cert-verify-name']),
      ...nativePolicyParameters(proxy), ...(proxy['client-cert'] ? { 'client-cert': proxy['client-cert'] } : {}),
    };
    return `vmess://${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  }
  if (protocol === 'ss') {
    url.username = Buffer.from(`${str(proxy.cipher)}:${str(proxy.password)}`).toString('base64url');
    if (proxy.plugin) {
      if (proxy.plugin !== 'obfs') unsupported('Surge 原生仅映射 simple-obfs 插件。');
      const plugin = obj(proxy['plugin-opts']);
      if (Object.keys(plugin).some(key => !['mode', 'host', 'uri'].includes(key))) unsupported('simple-obfs 插件参数尚未映射。');
      add('plugin', ['obfs-local', `obfs=${str(plugin.mode)}`, plugin.host ? `obfs-host=${plugin.host}` : '',
        plugin.uri ? `obfs-uri=${plugin.uri}` : ''].filter(Boolean).join(';'));
    }
    if (bool(proxy.udp)) add('udp', 'true');
  } else if (protocol === 'tuic' || protocol === 'tuic-v5') {
    if (proxy.uuid) {
      url.protocol = 'tuic-v5:';
      url.username = encodeURIComponent(str(proxy.uuid));
      url.password = encodeURIComponent(str(proxy.password));
    } else url.username = encodeURIComponent(str(proxy.token));
    add('version', proxy.version);
  } else {
    url.username = encodeURIComponent(str(proxy.password));
    if (protocol === 'hysteria2') {
      add('obfs', proxy.obfs);
      add('obfs-password', proxy['obfs-password']);
      add('down', proxy.down);
    }
    if (protocol === 'anytls') add('reuse', proxy.reuse);
    if (protocol === 'trojan' && proxy.network) {
      add('type', proxy.network);
      const ws = obj(proxy['ws-opts']);
      if (Object.keys(ws).some(key => !['path', 'headers'].includes(key))) unsupported('Trojan WebSocket 参数尚未映射。');
      const headers = obj(ws.headers);
      if (Object.keys(headers).some(key => key.toLowerCase() !== 'host')) unsupported('Trojan 目前仅映射 WebSocket Host 请求头。');
      add('path', ws.path);
      add('host', Object.entries(headers).find(([key]) => key.toLowerCase() === 'host')?.[1]);
    }
  }
  add('ports', proxy.ports);
  add('mport', proxy.mport);
  add('hop-interval', proxy['hop-interval']);
  url.hash = encodeURIComponent(str(proxy.name));
  return url.toString();
};
