/**
 * [INPUT]: Remote or data URL responses, shared URI detection and Clash parser options.
 * [OUTPUT]: Runtime-supported links, bounded transient retries and credential-safe download errors.
 * [POS]: Download and format-detection boundary used by all runtime modes.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { writeTextFile } from './utils/fs';
import { parseClashVlessNodes, type SubscriptionParseOptions } from './utils/parse-clash-vless';
import { SubscriptionError } from './utils/subscription-error';
import { subscriptionHeaders } from './utils/subscription-headers';
import { parseProxyLinkList } from './utils/decode-subscription';
import { ProxyAgent } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { parseNativeProxy, proxyProtocolLabel, supportsNativeProtocol, UnsupportedNativeNodeError } from './native/proxy';

const SUBSCRIPTION_TIMEOUT_MS = 15_000;
const TRANSIENT_HTTP = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const TRANSIENT_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

// Only inspect known codes. Remote error messages can contain the full private URL.
const networkCodes = (error: unknown): string[] => {
  if (!error || typeof error !== 'object') return [];
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  return [typeof value.code === 'string' ? value.code : '',
    ...networkCodes(value.cause), ...(Array.isArray(value.errors) ? value.errors.flatMap(networkCodes) : [])];
};

const networkFailure = (error: unknown, source: string) => {
  const codes = networkCodes(error);
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    || codes.some(code => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code))) {
    return `订阅 ${source} 请求超时（每次最多 15 秒），请检查到订阅服务器的网络连接。`;
  }
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) return `订阅 ${source} 域名解析失败，请检查 DNS 设置。`;
  if (codes.some(code => ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) {
    return `订阅 ${source} TLS 证书校验失败，请检查系统时间及订阅服务器证书。`;
  }
  if (codes.includes('ECONNREFUSED')) return `订阅 ${source} 连接被拒绝，请检查服务地址和端口。`;
  if (codes.some(code => ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code))) return `订阅 ${source} 连接被中断，请稍后重试。`;
  return `订阅 ${source} 下载失败，请检查网络、DNS 或 TLS 连接。`;
};

export const parseSubscriptionNodes = (raw: string, options: SubscriptionParseOptions = {}): string[] => {
  let text = raw.trim();
  if (!text) throw new SubscriptionError('订阅响应为空。');
  const compact = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) && compact.length % 4 !== 1) {
    text = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
    if (!text || text.includes('\uFFFD')) {
      throw new SubscriptionError('Base64 解码后不是有效文本；请确认订阅格式或是否需要专用解密。');
    }
  }
  if (/^\s*</.test(text)) throw new SubscriptionError('订阅返回 HTML/XML 页面，请检查地址或订阅访问权限。');
  // Only interpret complete link lists as links; URLs in comments or HTML are not nodes.
  const entries = parseProxyLinkList(text);
  if (entries) {
    let skipped = 0;
    const nodes = [...new Set(entries.flatMap((line, index) => {
      if (/^vless:\/\//i.test(line)) {
        if (options.native && new URL(line).searchParams.has('fp')) options.onNotice?.(`第 ${index + 1} 个节点：Surge 原生使用自身 TLS 指纹，订阅的自定义指纹不参与转换。`);
        return [line];
      }
      if (!options.native || !supportsNativeProtocol(line)) {
        options.onNotice?.(`第 ${index + 1} 个节点：当前运行方式尚未映射 ${proxyProtocolLabel(line)}，此节点未导入。`);
        return [];
      }
      try {
        parseNativeProxy(line, index, options.onNotice);
        return [line];
      } catch (error) {
        if (!options.skipUnsupported || !(error instanceof UnsupportedNativeNodeError)) throw error;
        skipped += 1;
        options.onSkipped?.(error.message);
        return [];
      }
    }))];
    if (skipped && !nodes.length) throw new SubscriptionError('所有可转换节点均含不兼容参数，已保留现有配置与缓存。');
    return nodes;
  }
  return [...new Set(parseClashVlessNodes(text, options))];
};

// Subscription URLs carry a token, in the query string or in the path itself, so failures name the
// provider by origin only. Without this, a user with several subscriptions cannot tell which one
// returned the error.
const describeSubscriptionUrl = (subscriptionUrl: string) => {
  try {
    const url = new URL(subscriptionUrl);
    return url.protocol === 'data:' ? 'data: URL' : url.origin;
  } catch {
    return 'subscription URL';
  }
};

export const getVlessSubscriptionNodes = async ({
  subscriptionUrl,
  requestHeaders,
  subscriptionOutputPath,
  parseOptions,
  proxyUrl,
}: {
  subscriptionUrl: string;
  requestHeaders?: Record<string, string>;
  subscriptionOutputPath?: string;
  parseOptions?: SubscriptionParseOptions;
  proxyUrl?: string;
}) => {
  const source = describeSubscriptionUrl(subscriptionUrl);

  const download = async (dispatcher?: ProxyAgent) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(subscriptionUrl, {
          headers: subscriptionHeaders(requestHeaders),
          // Without a deadline an unresponsive provider hangs `sync` indefinitely.
          signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: ProxyAgent });
        if (!response.ok) {
          await response.body?.cancel();
          if (!attempt && TRANSIENT_HTTP.has(response.status)) { await delay(300); continue; }
          throw new SubscriptionError(`订阅请求失败（HTTP ${response.status}）。${response.status === 403
            ? '服务端拒绝访问，请检查订阅权限、客户端 UA 限制、IP 白名单或反向代理规则。'
            : TRANSIENT_HTTP.has(response.status) ? '订阅服务器或上游网关暂时不可用，已重试一次，请稍后再试。' : ''}`);
        }
        return await response.text();
      } catch (error) {
        if (error instanceof SubscriptionError) throw error;
        if (!attempt && networkCodes(error).some(code => TRANSIENT_CODES.has(code))) { await delay(300); continue; }
        throw new SubscriptionError(networkFailure(error, source));
      }
    }
    throw new SubscriptionError('订阅下载失败。');
  };

  let rawData: string;
  let directError: SubscriptionError | undefined;
  try {
    rawData = await download();
  } catch (error) {
    directError = error instanceof SubscriptionError ? error : new SubscriptionError('订阅下载失败。');
    if (!proxyUrl?.trim()) throw directError;
    let proxy: URL;
    try {
      proxy = new URL(proxyUrl.trim());
    } catch {
      throw new SubscriptionError('订阅代理地址格式无效，请使用 http:// 或 https:// 地址。');
    }
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.toString().includes('@')) {
      throw new SubscriptionError('订阅代理仅支持不带认证信息的 HTTP 或 HTTPS 地址。');
    }
    const dispatcher = new ProxyAgent(proxy.toString());
    try {
      rawData = await download(dispatcher);
    } catch (error) {
      const detail = error instanceof SubscriptionError ? error.message : '请检查代理地址和网络。';
      throw new SubscriptionError(`${directError.message}；代理重试也失败：${detail}`);
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
  const vlessNodes = parseSubscriptionNodes(rawData, parseOptions);
  if (subscriptionOutputPath) {
    await writeTextFile(subscriptionOutputPath, `${vlessNodes.join('\n')}\n`);
  }

  return vlessNodes;
};
