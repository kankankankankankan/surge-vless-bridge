/**
 * [INPUT]: 原生节点的查询参数或 Clash 策略参数。
 * [OUTPUT]: 经过类型校验的 Surge 通用策略参数。
 * [POS]: 原生出口与测试选项的共同边界，不修改全局配置。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { isIP } from 'node:net';
import { SubscriptionError } from '../utils/subscription-error';

export const nativePolicyKeys = ['interface', 'allow-other-interface', 'dns-follow-interface',
  'no-error-alert', 'ip-version', 'tfo', 'tos', 'ecn', 'block-quic', 'test-url', 'test-timeout',
  'test-udp', 'underlying-proxy', 'client-cert'] as const;

export const nativePolicyParameters = (source: URLSearchParams | Record<string, unknown>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of nativePolicyKeys) {
    const value = source instanceof URLSearchParams ? source.get(key) : source[key];
    if (value === null || value === undefined) continue;
    const fail = (): never => { throw new SubscriptionError(`Surge 参数 ${key} 格式无效。`); };
    if (!['string', 'number', 'boolean'].includes(typeof value)) fail();
    let text = String(value);
    if (!text || /[\r\n\0]/.test(text)) fail();
    if (['allow-other-interface', 'dns-follow-interface', 'no-error-alert', 'tfo'].includes(key)) {
      if (!['true', 'false', '1', '0'].includes(text)) fail();
      text = text === 'true' || text === '1' ? 'true' : 'false';
    }
    if (key === 'ip-version' && !['dual', 'v4-only', 'v6-only', 'prefer-v4', 'prefer-v6'].includes(text)) fail();
    if ((key === 'ecn' || key === 'block-quic') && !['auto', 'on', 'off', 'true', 'false', ...(key === 'block-quic' ? ['adaptive'] : [])].includes(text)) fail();
    if (key === 'tos' && (!/^(?:\d+|0x[0-9a-f]+)$/i.test(text) || Number(text) > 255)) fail();
    if (key === 'test-timeout' && (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Number(text) <= 0)) fail();
    if (key === 'test-url') {
      try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail();
      } catch { fail(); }
    }
    if (key === 'test-udp') {
      const [host, address, extra] = text.split('@');
      if (!host || !/^[a-z0-9.-]+$/i.test(host) || !address || isIP(address) !== 4 || extra !== undefined) fail();
    }
    result[key] = text;
  }
  return result;
};
