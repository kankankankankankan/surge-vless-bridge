/**
 * [INPUT]: Proxy share links, native TLS validation and common policy mappings.
 * [OUTPUT]: Native nodes with verified parameter formats and escaped Surge policy lines.
 * [POS]: Native-only conversion boundary; never emits sing-box or Mihomo settings.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { createHash } from 'node:crypto';
import { SubscriptionError } from '../utils/subscription-error';
import { normalizeCertificateFingerprint, validateTlsName } from './tls';
import { nativePolicyKeys, nativePolicyParameters } from './parameters';

export type NativeProxyNode = {
  type: 'ss' | 'vmess' | 'trojan' | 'anytls' | 'hysteria2' | 'tuic' | 'tuic-v5';
  tag: string;
  server: string;
  server_port: number;
  uuid?: string;
  parameters: Record<string, string>;
};

export class UnsupportedNativeNodeError extends SubscriptionError {}

export const nativeProtocol = (link: string) => {
  const scheme = link.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1]?.toLowerCase() ?? '';
  return scheme === 'hy2' ? 'hysteria2' : scheme;
};

export const supportsNativeProtocol = (link: string) =>
  ['vless', 'ss', 'vmess', 'trojan', 'anytls', 'hysteria2', 'tuic', 'tuic-v5'].includes(nativeProtocol(link));

export const proxyProtocolLabel = (link: string) => ({
  vless: 'VLESS', ss: 'SS', ssr: 'SSR', vmess: 'VMess', trojan: 'Trojan', anytls: 'AnyTLS',
  hysteria: 'Hysteria 1', hy: 'Hysteria 1', hysteria2: 'Hysteria2', tuic: 'TUIC', 'tuic-v5': 'TUIC v5',
  snell: 'Snell', wireguard: 'WireGuard', quic: 'QUIC', socks: 'SOCKS', socks5: 'SOCKS5', http: 'HTTP', https: 'HTTPS',
} as Record<string, string>)[nativeProtocol(link)] ?? '未知协议';

export const decodeBase64Text = (raw: string) => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) || raw.length % 4 === 1) throw new Error('Invalid Base64');
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  if (text.includes('\uFFFD')) throw new Error('Invalid UTF-8');
  return text;
};

export const subscriptionNodeName = (link: string) => {
  if (/^vmess:\/\//i.test(link)) {
    try {
      const entry = JSON.parse(decodeBase64Text(link.slice(8).split('#')[0]!));
      if (typeof entry.ps === 'string') return entry.ps;
    } catch { /* URI-style VMess uses the regular fragment below. */ }
  }
  return decodeURIComponent(new URL(link).hash.slice(1));
};

export const quoteSurgeValue = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new SubscriptionError('节点参数含换行或控制字符，已取消转换。');
  return /[\s,=;"\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
};

const ssMethods = new Set(['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  'rc4', 'rc4-md5', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'aes-128-ctr', 'aes-192-ctr',
  'aes-256-ctr', 'salsa20', 'chacha20', 'chacha20-ietf', 'none']);

export const parseNativeProxy = (link: string, index: number, onNotice?: (message: string) => void): NativeProxyNode => {
  const fail = (message: string): never => { throw new SubscriptionError(`第 ${index + 1} 个节点：${message}`); };
  const unsupported = (message: string): never => { throw new UnsupportedNativeNodeError(`第 ${index + 1} 个节点：${message}`); };
  try {
    let scheme = nativeProtocol(link);
    if (!supportsNativeProtocol(link) || scheme === 'vless') unsupported('当前节点协议尚未映射到 Surge 原生。');
    let url: URL;
    let vmess: Record<string, unknown> | undefined;
    if (scheme === 'vmess' && !link.slice(8).includes('@')) {
      vmess = JSON.parse(decodeBase64Text(link.slice(8).split('#')[0]!));
      if (!vmess || Array.isArray(vmess) || typeof vmess !== 'object') fail('VMess JSON 格式无效。');
      const keys = new Set(['v', 'ps', 'add', 'port', 'id', 'aid', 'scy', 'tls', 'sni', 'net', 'type', 'host', 'path', 'alpn', 'fp', 'allowInsecure', 'pcs', 'vcn']);
      nativePolicyKeys.forEach(key => keys.add(key));
      keys.add('client-cert');
      if (Object.keys(vmess!).some(key => !keys.has(key))) unsupported('VMess JSON 存在尚未映射的参数。');
      for (const key of ['ps', 'add', 'id', 'net', 'type', 'host', 'path', 'tls', 'sni', 'scy', 'fp']) {
        if (vmess![key] !== undefined && typeof vmess![key] !== 'string') fail('VMess 文本参数格式无效。');
      }
      const server = String(vmess!.add ?? '');
      url = new URL(`vmess://${server.includes(':') ? `[${server}]` : server}:${Number(vmess!.port)}`);
    } else if (scheme === 'ss' && !link.split('#')[0]!.split('?')[0]!.includes('@')) {
      const [body, hash = ''] = link.slice(5).split('#');
      url = new URL(`ss://${decodeBase64Text(body!)}#${hash}`);
    } else {
      url = new URL(link);
    }
    const host = url!.hostname.replace(/^\[(.+)\]$/, '$1');
    const port = Number(url!.port || '443');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) fail('缺少有效的服务器或端口。');
    const q = url!.searchParams;
    for (const key of ['insecure', 'allowInsecure', 'reuse', 'tls', 'udp']) {
      if (q.has(key) && !['true', 'false', '0', '1'].includes(q.get(key)!)) fail('布尔参数格式无效。');
    }
    const parameters: Record<string, string> = nativePolicyParameters(vmess ?? q);
    let uuid: string | undefined;
    const username = decodeURIComponent(url!.username);
    const password = decodeURIComponent(url!.password);
    const required = (value: string, label: string) => value || fail(`缺少 ${label}。`);
    const bool = (value: unknown) => value === true || value === 1 || value === 'true' || value === '1';
    const set = (key: string, value: unknown) => {
      if (value !== undefined && value !== null && value !== '') parameters[key] = String(value);
    };
    const integer = (value: unknown, minimum: number, label: string) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < minimum) fail(`${label} 格式无效。`);
      return String(n);
    };

    if (scheme === 'ss') {
      let method = username;
      let secret = password;
      if (!url!.password && !link.includes(':@')) {
        const decoded = decodeBase64Text(username);
        const separator = decoded.indexOf(':');
        if (separator < 1) fail('Shadowsocks 凭据格式无效。');
        method = decoded.slice(0, separator);
        secret = decoded.slice(separator + 1);
      }
      if (!ssMethods.has(method)) unsupported('Surge 不支持此 Shadowsocks 加密方法。');
      set('encrypt-method', method);
      set('password', method === 'none' ? secret : required(secret, 'Shadowsocks 密码'));
      const plugin = q.get('plugin');
      if (plugin) {
        const [name, ...values] = plugin.split(';');
        if (!['obfs-local', 'simple-obfs'].includes(name!)) unsupported('Surge 原生仅映射 Shadowsocks simple-obfs 插件。');
        for (const entry of values) {
          const separator = entry.indexOf('=');
          const key = entry.slice(0, separator);
          const value = entry.slice(separator + 1);
          if (!['obfs', 'obfs-host', 'obfs-uri'].includes(key) || separator < 0) unsupported('Shadowsocks 插件参数尚未映射。');
          set(key, value);
        }
        if (!['http', 'tls'].includes(parameters.obfs ?? '')) unsupported('simple-obfs 仅支持 http 或 tls。');
      }
      if (bool(q.get('udp'))) set('udp-relay', 'true');
    } else if (scheme === 'vmess') {
      uuid = required(String(vmess?.id ?? username), 'VMess UUID');
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uuid)) fail('VMess UUID 格式无效。');
      const aid = Number(vmess?.aid ?? q.get('alterId') ?? q.get('aid') ?? 0);
      if (!Number.isInteger(aid) || aid < 0) fail('VMess alterId 格式无效。');
      if (aid !== 0) unsupported('Surge 不支持指定非零 VMess alterId，不能安全转换。');
      const cipher = String(vmess?.scy ?? q.get('encryption') ?? 'auto');
      if (!['auto', 'aes-128-gcm', 'chacha20-poly1305', 'chacha20-ietf-poly1305'].includes(cipher)) unsupported('Surge 不支持此 VMess 加密方法。');
      set('username', uuid);
      set('vmess-aead', 'true');
      if (cipher !== 'auto') set('encrypt-method', cipher === 'chacha20-poly1305' ? 'chacha20-ietf-poly1305' : cipher);
    } else if (scheme === 'tuic' || scheme === 'tuic-v5') {
      const version = q.get('version');
      scheme = scheme === 'tuic-v5' || url!.password || version === '5' ? 'tuic-v5' : 'tuic';
      if (version && !['4', '5'].includes(version)) unsupported('TUIC 版本仅支持 v4 或 v5。');
      if (version === '4' && scheme === 'tuic-v5') fail('TUIC v4 与 v5 认证字段冲突。');
      if (scheme === 'tuic-v5') {
        uuid = required(username, 'TUIC v5 UUID');
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uuid)) fail('TUIC v5 UUID 格式无效。');
        set('uuid', uuid);
        set('password', required(password, 'TUIC v5 密码'));
      } else set('token', required(username || q.get('token') || '', 'TUIC v4 token'));
    } else {
      const auth = password ? `${username}:${password}` : username;
      set('password', required(scheme === 'hysteria2' ? q.get('auth') || auth : auth, '节点密码'));
      if (scheme === 'anytls' && q.has('reuse')) set('reuse', bool(q.get('reuse')) ? 'true' : 'false');
    }

    const tlsEnabled = !['ss', 'vmess'].includes(scheme) || vmess?.tls === 'tls' || q.get('security') === 'tls' || bool(q.get('tls'));
    if (!['ss', 'vmess'].includes(scheme) && (q.get('security') === 'none' || q.get('tls') === 'false')) fail('该协议必须启用 TLS。');
    if (vmess?.tls && !['tls', 'none'].includes(String(vmess.tls))) unsupported('VMess TLS 类型尚未映射。');
    if (scheme === 'vmess' && (vmess?.tls === 'reality' || q.get('security') === 'reality')) unsupported('Surge VMess 不支持 Reality。');
    if (tlsEnabled) {
      if (scheme === 'vmess') set('tls', 'true');
      const sni = vmess?.sni || q.get('sni') || q.get('peer') || q.get('serverName');
      if (sni) set('sni', validateTlsName(sni, 'SNI'));
      if (bool(vmess?.allowInsecure) || bool(q.get('insecure')) || bool(q.get('allowInsecure'))) set('skip-cert-verify', 'true');
      set('alpn', vmess?.alpn || q.get('alpn'));
      const fingerprint = vmess?.pcs || q.get('pinSHA256') || q.get('pcs');
      if (fingerprint) set('server-cert-fingerprint-sha256', normalizeCertificateFingerprint(fingerprint));
      const verifyName = vmess?.vcn || q.get('vcn') || q.get('server-cert-verify-name');
      if (verifyName) set('server-cert-verify-name', validateTlsName(verifyName, '证书校验名称'));
      set('client-cert', vmess?.['client-cert'] || q.get('client-cert'));
      if (q.has('fp') || q.has('fingerprint') || vmess?.fp) onNotice?.(`第 ${index + 1} 个节点：Surge 原生使用自身 TLS 指纹，订阅的自定义指纹不参与转换。`);
    }

    if (scheme === 'vmess' || scheme === 'trojan') {
      const transport = String(vmess?.net ?? q.get('type') ?? 'tcp').toLowerCase() || 'tcp';
      if (!['tcp', 'ws', 'httpupgrade'].includes(transport)) unsupported('Surge VMess/Trojan 当前仅映射 TCP、WebSocket 和 HTTPUpgrade。');
      if (vmess?.type && vmess.type !== 'none') unsupported('VMess TCP 伪装参数尚未映射。');
      if (transport !== 'tcp') {
        set('ws', 'true');
        if (transport === 'httpupgrade') set('ws-http-upgrade', 'true');
        const path = String(vmess?.path || q.get('path') || '/');
        if (!path.startsWith('/')) fail('WebSocket path 必须以 / 开头。');
        set('ws-path', path);
        const hostHeader = vmess?.host || q.get('host');
        if (hostHeader) set('ws-headers', `Host:${hostHeader}`);
      }
    }
    if (scheme === 'hysteria2' || scheme === 'tuic' || scheme === 'tuic-v5') {
      const normalizePorts = (value: string) => value.replace(/,/g, ';').replace(/:/g, '-');
      if (q.get('mport') && q.get('ports') && normalizePorts(q.get('mport')!) !== normalizePorts(q.get('ports')!)) fail('ports 与 mport 不一致，请保留一个端口范围。');
      const ports = q.get('mport') || q.get('ports');
      if (ports) {
        const normalized = ports.replace(/,/g, ';').replace(/:/g, '-');
        if (!normalized.split(';').every(range => {
          const values = range.split('-').map(Number);
          return values.length <= 2 && values.every(value => Number.isInteger(value) && value >= 1 && value <= 65535)
            && (values.length === 1 || values[0]! <= values[1]!);
        })) fail('port-hopping 格式无效。');
        set('port-hopping', normalized);
      }
      const interval = q.get('hop-interval');
      if (interval) set('port-hopping-interval', integer(interval, 1, 'hop-interval'));
      if (scheme === 'hysteria2') {
        const obfs = q.get('obfs');
        if (obfs && !['none', 'salamander', 'gecko'].includes(obfs)) unsupported('Hysteria2 混淆类型尚未映射。');
        if (obfs && obfs !== 'none') set(`${obfs}-password`, required(q.get('obfs-password') || '', '混淆密码'));
        const down = q.get('downmbps') || q.get('down');
        if (down) {
          const value = Number(down.replace(/\s*mbps$/i, ''));
          if (!Number.isFinite(value) || value <= 0) fail('download-bandwidth 格式无效。');
          set('download-bandwidth', value);
        }
      }
    }
    const known = new Set(scheme === 'ss' ? ['plugin', 'udp'] :
      ['sni', 'peer', 'serverName', 'insecure', 'allowInsecure', 'alpn', 'pinSHA256', 'pcs', 'vcn', 'server-cert-verify-name', 'client-cert', 'fp', 'fingerprint', 'security', 'tls']);
    const protocolKeys: Record<string, string[]> = {
      ss: [], vmess: ['alterId', 'aid', 'encryption', 'type', 'path', 'host'],
      trojan: ['type', 'path', 'host'], anytls: ['reuse', 'udp'],
      hysteria2: ['auth', 'mport', 'ports', 'hop-interval', 'obfs', 'obfs-password', 'downmbps', 'down'],
      tuic: ['version', 'token', 'mport', 'ports', 'hop-interval'],
      'tuic-v5': ['version', 'mport', 'ports', 'hop-interval'],
    };
    protocolKeys[scheme]?.forEach(key => known.add(key));
    nativePolicyKeys.forEach(key => known.add(key));
    if (parameters['underlying-proxy'] && parameters['port-hopping']) fail('端口跳跃不能与 underlying-proxy 同时使用。');
    if ([...q.keys()].some(key => !known.has(key))) unsupported('存在尚未映射的链接参数，不能静默丢弃。');
    const name = subscriptionNodeName(link);
    const tag = name || `${scheme}-${createHash('sha256').update(link).digest('hex').slice(0, 12)}`;
    // Validate escaping before caching; failures must never replace a successful snapshot.
    Object.values(parameters).forEach(quoteSurgeValue);
    quoteSurgeValue(host);
    return { type: scheme as NativeProxyNode['type'], tag, server: host, server_port: port, uuid, parameters };
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    return fail('节点链接、编码或必要参数格式无效。');
  }
};

export const buildNativeProxyLine = (nodeName: string, node: NativeProxyNode, tcpFastOpen: boolean, udpRelay: boolean) => {
  const parameters = { ...node.parameters };
  if (tcpFastOpen && parameters.tfo === undefined) parameters.tfo = 'true';
  if (node.type === 'ss' && udpRelay) parameters['udp-relay'] = 'true';
  parameters['ip-version'] ??= 'prefer-v4';
  return [`${nodeName} = ${node.type}`, quoteSurgeValue(node.server), String(node.server_port),
    ...Object.entries(parameters).map(([key, value]) => `${key}=${quoteSurgeValue(value)}`)].join(', ');
};
