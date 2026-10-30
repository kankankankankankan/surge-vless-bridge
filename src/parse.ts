import { writeTextFile } from './utils/fs';
import { parseClashVlessNodes } from './utils/parse-clash-vless';
import { SubscriptionError } from './utils/subscription-error';

const SUBSCRIPTION_TIMEOUT_MS = 15_000;

export const parseSubscriptionNodes = (raw: string): string[] => {
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
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Only interpret complete link lists as links; URLs in comments or HTML are not nodes.
  const entries = lines.filter((line) => !line.startsWith('#'));
  if (entries.length && entries.every((line) => /^(?:ss|ssr|vless|vmess|trojan|hysteria2?|hy2|tuic):\/\//i.test(line))) {
    return [...new Set(entries.filter((line) => /^vless:\/\//i.test(line)))];
  }
  return [...new Set(parseClashVlessNodes(text))];
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
}: {
  subscriptionUrl: string;
  requestHeaders?: Record<string, string>;
  subscriptionOutputPath?: string;
}) => {
  const source = describeSubscriptionUrl(subscriptionUrl);

  let rawData: string;
  try {
    const response = await fetch(subscriptionUrl, {
      headers: requestHeaders,
      // Without a deadline an unresponsive provider hangs `sync` indefinitely.
      signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new SubscriptionError(`订阅请求失败（HTTP ${response.status}）。`);
    rawData = await response.text();
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new SubscriptionError(timeout ? `订阅 ${source} 请求超时（15 秒）。` : `订阅 ${source} 下载失败，请检查网络、DNS 或 TLS 连接。`);
  }
  const vlessNodes = parseSubscriptionNodes(rawData);
  if (subscriptionOutputPath) {
    await writeTextFile(subscriptionOutputPath, `${vlessNodes.join('\n')}\n`);
  }

  return vlessNodes;
};
