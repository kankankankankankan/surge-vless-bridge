import { parseDocument } from 'yaml';
import { SubscriptionError } from './subscription-error';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value : '';
const enabled = (value: unknown) => value === true || value === 'true' || value === 1;

const clashProxyToVless = (proxy: Record<string, unknown>, index: number): string => {
  const fail = (reason: string): never => {
    throw new SubscriptionError(`Clash 第 ${index + 1} 个节点：${reason}`);
  };
  const server = string(proxy.server).trim();
  const uuid = string(proxy.uuid).trim();
  const port = Number(proxy.port);
  if (!server || !uuid || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail('缺少有效的 server、port 或 uuid。');
  }
  let url: URL;
  try {
    url = new URL(`vless://${server.includes(':') && !server.startsWith('[') ? `[${server}]` : server}:${port}`);
    if (url.username || url.password || url.pathname || url.search || url.hash) fail('server 格式无效。');
  } catch {
    return fail('server 格式无效。');
  }
  url.username = encodeURIComponent(uuid);
  url.hash = encodeURIComponent(string(proxy.name));
  const params = url.searchParams;
  params.set('encryption', 'none');

  // These options cannot be represented by the shared sing-box/Mihomo node model.
  for (const key of ['encryption', 'fingerprint', 'certificate', 'private-key', 'name-cert-verify', 'dialer-proxy']) {
    if (proxy[key] && proxy[key] !== 'none') fail(`暂不支持 ${key}，未转换此订阅。`);
  }
  for (const key of ['ech-opts', 'shadow-tls-opts', 'restls-opts', 'jls-opts']) {
    if (Object.keys(record(proxy[key])).length) fail(`暂不支持 ${key}，未转换此订阅。`);
  }
  if (enabled(record(proxy.smux).enabled)) fail('暂不支持 smux，未转换此订阅。');

  const network = string(proxy.network).toLowerCase() || 'tcp';
  if (!['tcp', 'ws', 'grpc', 'httpupgrade'].includes(network)) {
    fail('暂不支持该 network，仅支持 TCP、WS、gRPC 和 HTTP Upgrade。');
  }
  params.set('type', network);
  const ws = record(proxy['ws-opts']);
  const headers = record(ws.headers ?? proxy['ws-headers']);
  if (network === 'ws') {
    if (Object.keys(headers).some((key) => key.toLowerCase() !== 'host')) {
      fail('WS 暂不支持 Host 以外的自定义请求头。');
    }
    const host = Object.entries(headers).find(([key]) => key.toLowerCase() === 'host')?.[1];
    if (host !== undefined && typeof host !== 'string') fail('WS Host 必须为字符串。');
    if (host) params.set('host', string(host));
    params.set('path', string(ws.path) || '/');
    if (enabled(ws['v2ray-http-upgrade-fast-open'])) fail('暂不支持 HTTP Upgrade fast-open。');
    if (enabled(ws['v2ray-http-upgrade'])) params.set('type', 'httpupgrade');
    const earlyData = Number(ws['max-early-data'] ?? 0);
    if (!Number.isInteger(earlyData) || earlyData < 0) fail('max-early-data 必须为非负整数。');
    if (earlyData > 0) {
      if (params.get('type') !== 'ws') fail('HTTP Upgrade 暂不支持 early data。');
      params.set('ed', String(earlyData));
      params.set('eh', string(ws['early-data-header-name']));
    }
  } else if (network === 'grpc') {
    const grpc = record(proxy['grpc-opts']);
    params.set('serviceName', string(grpc['grpc-service-name'] ?? grpc['service-name']));
  } else if (network === 'httpupgrade') {
    const upgrade = record(proxy['httpupgrade-opts']);
    params.set('path', string(upgrade.path) || '/');
    if (upgrade.host) params.set('host', string(upgrade.host));
  }

  const reality = record(proxy['reality-opts']);
  const publicKey = string(reality['public-key']);
  if (proxy['reality-opts'] !== undefined && !publicKey) fail('Reality 缺少 public-key。');
  if (publicKey) {
    if (proxy.tls === false) fail('Reality 节点需要启用 TLS。');
    if (reality['short-id'] !== undefined && typeof reality['short-id'] !== 'string') {
      fail('Reality short-id 必须用引号包围，避免 YAML 将其当作数字。');
    }
    params.set('security', 'reality');
    params.set('pbk', publicKey);
    params.set('sid', string(reality['short-id']));
  } else if (enabled(proxy.tls)) {
    params.set('security', 'tls');
  }
  const sni = string(proxy.servername ?? proxy.sni) || params.get('host');
  if (sni) params.set('sni', sni);
  if (enabled(proxy['skip-cert-verify'])) params.set('allowInsecure', '1');
  if (proxy['client-fingerprint']) params.set('fp', string(proxy['client-fingerprint']));
  if (proxy.flow) params.set('flow', string(proxy.flow));
  if (proxy.alpn !== undefined) {
    if (!Array.isArray(proxy.alpn) || proxy.alpn.some((value) => typeof value !== 'string' || !value || value.includes(','))) {
      fail('alpn 必须为协议名称列表。');
    }
    params.set('alpn', (proxy.alpn as string[]).join(','));
  } else if (params.has('security')) {
    params.set('alpn', network === 'grpc' ? 'h2' : network === 'ws' || network === 'httpupgrade' ? 'http/1.1' : '');
  }
  const packetEncoding = string(proxy['packet-encoding']) || (enabled(proxy.xudp) ? 'xudp' : '');
  if (enabled(proxy['packet-addr']) || (packetEncoding && packetEncoding !== 'xudp')) {
    fail('暂不支持该 packet-encoding，仅支持 xudp。');
  }
  if (packetEncoding) params.set('packetEncoding', packetEncoding);
  return url.toString();
};

export const parseClashVlessNodes = (raw: string): string[] => {
  let document: Record<string, unknown>;
  try {
    // Parser snippets can contain UUIDs or subscription URLs, so never forward its errors.
    const parsed = parseDocument(raw, { merge: true, prettyErrors: false });
    if (parsed.errors.length || parsed.warnings.length) throw new Error('Invalid YAML document.');
    document = record(parsed.toJS());
  } catch {
    throw new SubscriptionError('Clash YAML/JSON 语法错误，请检查订阅响应格式。');
  }
  if (!Array.isArray(document.proxies)) {
    if (document['proxy-providers']) {
      throw new SubscriptionError('该 Clash 配置使用 proxy-providers，请填写节点 provider 的订阅地址。');
    }
    throw new SubscriptionError('无法识别订阅格式；支持节点链接、Base64 和包含 proxies 的 Clash YAML/JSON。');
  }
  if (document.proxies.length === 0 && document['proxy-providers']) {
    throw new SubscriptionError('该 Clash 配置的 proxies 为空，请填写节点 provider 的订阅地址。');
  }
  return document.proxies.flatMap((entry, index) => {
    const proxy = record(entry);
    return string(proxy.type).toLowerCase() === 'vless' ? [clashProxyToVless(proxy, index)] : [];
  });
};
