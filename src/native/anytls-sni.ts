/**
 * [INPUT]: 用户确认的 AnyTLS 端点、TLS 名称和连接复用，以及原生节点。
 * [OUTPUT]: TLS 设置校验、端点匹配与独立字段覆盖。
 * [POS]: 原生转换的单节点 TLS 身份设置，不探测或猜测服务器身份。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { AnyTlsSniOverride } from '../types/cli-config';
import type { NativeProxyNode } from './proxy';

const hostname = (value: unknown, label: string, allowIp: boolean) => {
  if (typeof value !== 'string') throw new Error(`${label}必须填写有效域名。`);
  const raw = value.trim().replace(/^\[([^\]]+)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  if (allowIp && isIP(raw)) return raw;
  if (/[\\/:@?#,%\s=*\[\]]/.test(raw)) throw new Error(`${label}必须填写有效域名，不能包含协议、路径、端口或通配符。`);
  const ascii = domainToASCII(raw);
  if (!ascii || ascii.length > 253 || isIP(ascii) || !ascii.split('.').every(part =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) {
    throw new Error(`${label}必须填写有效域名，不能包含协议、路径、端口或通配符。`);
  }
  return ascii;
};

export const anyTlsEndpointKey = (server: string, port: number) => {
  const raw = server.trim().replace(/^\[([^\]]+)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  const canonical = isIP(raw) === 6 ? new URL(`http://[${raw}]/`).hostname : domainToASCII(raw) || raw;
  return JSON.stringify([canonical, port]);
};

export const normalizeAnyTlsSniOverrides = (input: unknown): AnyTlsSniOverride[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('AnyTLS SNI 设置必须为节点列表。');
  const overrides = new Map<string, AnyTlsSniOverride>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') throw new Error('AnyTLS SNI 节点设置无效。');
    if (entry.sni !== undefined && typeof entry.sni !== 'string') throw new Error('SNI 必须填写有效域名。');
    if (entry.certificateVerifyName !== undefined && typeof entry.certificateVerifyName !== 'string') throw new Error('证书校验名称必须填写有效域名。');
    if (entry.reuse !== undefined && typeof entry.reuse !== 'boolean') throw new Error('AnyTLS 连接复用必须为布尔值。');
    const sni = entry.sni?.trim() ? hostname(entry.sni, 'SNI', false) : '';
    const certificateVerifyName = entry.certificateVerifyName?.trim()
      ? hostname(entry.certificateVerifyName, '证书校验名称', false) : undefined;
    if (!sni && !certificateVerifyName && entry.reuse === undefined) continue;
    const server = hostname(entry.server, '节点服务器', true);
    const port = Number(entry.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AnyTLS 节点端口必须在 1 到 65535 之间。');
    const key = anyTlsEndpointKey(server, port);
    const normalized = { server, port, sni, ...(certificateVerifyName ? { certificateVerifyName } : {}),
      ...(entry.reuse !== undefined ? { reuse: entry.reuse } : {}) };
    if (overrides.has(key) && JSON.stringify(overrides.get(key)) !== JSON.stringify(normalized)) throw new Error('同一 AnyTLS 端点不能设置不同的 TLS 参数。');
    overrides.set(key, normalized);
  }
  return [...overrides.values()];
};

export const applyAnyTlsSniOverride = (node: NativeProxyNode, overrides: AnyTlsSniOverride[] = []): NativeProxyNode => {
  if (node.type !== 'anytls') return node;
  const match = overrides.find(entry => anyTlsEndpointKey(entry.server, entry.port) === anyTlsEndpointKey(node.server, node.server_port));
  return match ? { ...node, parameters: { ...node.parameters,
    ...(match.sni ? { sni: match.sni } : {}),
    ...(match.certificateVerifyName ? { 'server-cert-verify-name': match.certificateVerifyName } : {}),
    ...(match.reuse !== undefined ? { reuse: String(match.reuse) } : {}),
  } } : node;
};
