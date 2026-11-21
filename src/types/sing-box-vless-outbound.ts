/**
 * [INPUT]: VLESS 链接与 Clash 参数解析结果。
 * [OUTPUT]: TLS、传输层和 VLESS 中间节点类型。
 * [POS]: 三种运行方式共用的 VLESS 契约，不承载其他协议。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
export type SingBoxTls = {
  enabled: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  utls?: {
    enabled: boolean;
    fingerprint: string;
  };
  reality?: {
    enabled: boolean;
    public_key: string;
    short_id?: string;
  };
  certificate_fingerprint_sha256?: string;
  certificate_verify_name?: string;
};

export type SingBoxTransport = {
  type: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  service_name?: string;
  authority?: string;
  mode?: string;
  extra?: string;
  max_early_data?: number;
  early_data_header_name?: string;
};

export type SingBoxVlessOutbound = {
  type: 'vless';
  tag: string;
  server: string;
  server_port: number;
  uuid: string;
  flow?: string;
  packet_encoding?: 'xudp';
  encryption?: string;
  tcp_fast_open?: boolean;
  connect_timeout?: string;
  tls?: SingBoxTls;
  transport?: SingBoxTransport;
  network?: string;
  ntp?: unknown;
};
