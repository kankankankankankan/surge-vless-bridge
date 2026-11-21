/**
 * [INPUT]: 订阅中的 TLS 名称与证书 SHA-256 字符串。
 * [OUTPUT]: 无转义和控制符的 TLS 名称及 64 位十六进制证书指纹。
 * [POS]: 原生 TLS 转换的格式边界，不将客户端指纹或公钥作为证书指纹。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { SubscriptionError } from '../utils/subscription-error';

export const validateTlsName = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value || /[\\/@?#,%\s=*"';\0]/.test(value)) {
    throw new SubscriptionError(`${label} 必须是有效服务器名称，不能包含转义符、协议或路径。`);
  }
  return value;
};

export const normalizeCertificateFingerprint = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i.test(value)) {
    throw new SubscriptionError('证书 fingerprint 必须是 SHA-256（64 位十六进制），不能使用客户端指纹或 Reality 公钥。');
  }
  return value.replace(/:/g, '').toLowerCase();
};
