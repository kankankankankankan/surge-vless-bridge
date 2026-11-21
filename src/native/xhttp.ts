/**
 * [INPUT]: VLESS XHTTP extra JSON 和 Surge 官方客户端参数表。
 * [OUTPUT]: 校验后的 xhttp-* 参数；拒绝未知字段和分离下载配置。
 * [POS]: 原生 XHTTP 扩展转换，不改变 External 或 Mihomo 的传输配置。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { SubscriptionError } from '../utils/subscription-error';

const fields: Record<string, [string, 'range' | 'boolean' | 'text' | readonly string[]]> = {
  xPaddingBytes: ['padding-bytes', 'range'],
  xPaddingObfsMode: ['padding-obfs', 'boolean'],
  xPaddingKey: ['padding-key', 'text'],
  xPaddingHeader: ['padding-header', 'text'],
  xPaddingPlacement: ['padding-placement', ['queryInHeader', 'header', 'cookie', 'query']],
  xPaddingMethod: ['padding-method', ['repeat-x', 'tokenish']],
  uplinkHTTPMethod: ['uplink-method', ['POST', 'GET']],
  sessionIDPlacement: ['session-placement', ['path', 'query', 'header', 'cookie']],
  sessionIDKey: ['session-key', 'text'],
  sessionIDTable: ['session-table', 'text'],
  sessionIDLength: ['session-length', 'range'],
  seqPlacement: ['seq-placement', ['path', 'query', 'header', 'cookie']],
  seqKey: ['seq-key', 'text'],
  uplinkDataPlacement: ['uplink-data-placement', ['auto', 'body', 'header', 'cookie']],
  uplinkDataKey: ['uplink-data-key', 'text'],
  uplinkChunkSize: ['uplink-chunk-size', 'range'],
  noGRPCHeader: ['no-grpc-header', 'boolean'],
  scMaxEachPostBytes: ['max-each-post-bytes', 'range'],
  scMinPostsIntervalMs: ['min-posts-interval', 'range'],
};
const xmuxFields: Record<string, string> = {
  maxConcurrency: 'max-concurrency', maxConnections: 'max-connections',
  cMaxReuseTimes: 'max-reuse-times', hMaxRequestTimes: 'max-request-times',
  hMaxReusableSecs: 'max-reusable-secs', hKeepAlivePeriod: 'keep-alive',
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const nativeXhttpParameters = (raw: string, mode = 'auto'): Record<string, string> => {
  const fail = (message: string): never => { throw new SubscriptionError(`XHTTP extra：${message}`); };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return fail('必须是有效 JSON 对象。'); }
  if (!object(data)) return fail('必须是有效 JSON 对象。');
  const result: Record<string, string> = {};
  const range = (value: unknown) => {
    const text = String(value);
    if (!['string', 'number'].includes(typeof value) || !/^\d+(?:-\d+)?$/.test(text)) return fail('数值必须为非负整数或范围。');
    const values = text.split('-').map(Number);
    if (values.some(n => !Number.isSafeInteger(n)) || (values.length === 2 && values[0]! > values[1]!)) return fail('数值范围无效。');
    return text;
  };
  for (const [key, value] of Object.entries(data)) {
    if (key === 'downloadSettings') return fail('Surge 不支持独立 downloadSettings。');
    if (key === 'headers') {
      if (!object(value)) return fail('headers 必须为字符串对象。');
      const headers = Object.entries(value).map(([name, content]) => {
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || name.toLowerCase() === 'host'
          || typeof content !== 'string' || /[\r\n\0|]/.test(content)) return fail('请求头无效，Host 请使用 xhttp-host。');
        return `${name}:${content}`;
      });
      if (headers.length) result['xhttp-headers'] = headers.join('|');
      continue;
    }
    if (key === 'xmux') {
      if (!object(value)) return fail('xmux 必须为对象。');
      for (const [name, content] of Object.entries(value)) {
        if (!xmuxFields[name]) return fail('存在尚未映射的 xmux 参数。');
        result[`xhttp-xmux-${xmuxFields[name]}`] = range(content);
      }
      continue;
    }
    const field = fields[key];
    if (!field) return fail('存在尚未映射的参数，已取消转换。');
    const [target, type] = field;
    if (Array.isArray(type)) {
      if (typeof value !== 'string' || !type.includes(value)) return fail(`${key} 取值无效。`);
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') return fail(`${key} 必须为布尔值。`);
    } else if (type === 'text') {
      if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) return fail(`${key} 必须为有效文本。`);
    }
    result[`xhttp-${target}`] = type === 'range' ? range(value) : String(value);
  }
  if (result['xhttp-uplink-method'] === 'GET' && mode !== 'packet-up') return fail('GET 上传需要 packet-up 模式。');
  if (['header', 'cookie'].includes(result['xhttp-uplink-data-placement'] ?? '') && mode !== 'packet-up') {
    return fail('请求头或 Cookie 上传需要 packet-up 模式。');
  }
  if (result['xhttp-xmux-max-connections'] !== undefined && result['xhttp-xmux-max-concurrency'] !== undefined) {
    return fail('maxConnections 与 maxConcurrency 不能同时指定。');
  }
  if (result['xhttp-session-table'] !== undefined && Number((result['xhttp-session-length'] ?? '0').split('-')[0]) < 1) {
    return fail('指定 sessionIDTable 时，sessionIDLength 至少为 1。');
  }
  return result;
};
