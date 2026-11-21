/**
 * [INPUT]: CLI、桌面表单与持久化配置的运行参数。
 * [OUTPUT]: 运行方式、订阅、解析器和单节点 AnyTLS TLS 与复用类型。
 * [POS]: 核心与桌面共用配置契约，不包含运行时状态。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
export type AddressResolverStrategy = 'system' | 'doh' | 'dot' | 'dns' | 'off';
export type AnyTlsSniOverride = { server: string; port: number; sni: string; certificateVerifyName?: string; reuse?: boolean };
export type PolicyGroupTargetMode = 'auto' | 'merge' | 'reference';
export type RuntimeMode = 'external' | 'mihomo' | 'surge-native';
export type MihomoDnsMode = 'inherit' | 'dns' | 'doh' | 'dot' | 'system';

export type SubscriptionOptions = {
  enabled: boolean;
  include: string;
  exclude: string;
  skipUnsupported: boolean;
};

export type MihomoConfig = {
  binary: string;
  dataDir: string;
  controllerHost: string;
  controllerPort: number;
  controllerSecret: string;
  autoStart: boolean;
  logLevel: 'silent' | 'error' | 'warning' | 'info' | 'debug';
  dnsMode: MihomoDnsMode;
  dnsServers: string[];
  dohEndpoint: string;
  dnsIpv6: boolean;
  tcpConcurrent: boolean;
};

export type AddressResolverConfig = {
  strategy: AddressResolverStrategy;
  dohEndpoint: string;
  dnsServers: string[];
  filterSurgeFakeIp: boolean;
};

export type CliConfig = {
  runtimeMode: RuntimeMode;
  runtimeModeConfirmed: boolean;
  mihomo: MihomoConfig;
  subscriptionUrl?: string;
  subscriptionUrls?: string[];
  subscriptionNames?: string[];
  subscriptionOptions?: SubscriptionOptions[];
  vlessNodes?: string[];
  anytlsSniOverrides: AnyTlsSniOverride[];
  surgeConfigPath: string;
  singBoxBinary: string;
  outputDir: string;
  backupDir: string;
  policyGroupName: string;
  policyGroupTargets: string[];
  policyGroupExclusions: string[];
  policyGroupTargetModes: Record<string, PolicyGroupTargetMode>;
  proxyStartMarker: string;
  proxyEndMarker: string;
  portStart: number;
  backupKeep: number;
  autoReload: boolean;
  udpRelay: boolean;
  udpTestEnabled: boolean;
  udpTestTarget: string;
  tcpFastOpen: boolean;
  connectTimeoutEnabled: boolean;
  connectTimeoutSeconds: number;
  subscriptionOutputPath: string;
  subscriptionProxyUrl: string;
  requestHeaders: Record<string, string>;
  addressResolver: AddressResolverConfig;
};

export type CliConfigInput = Partial<Omit<CliConfig, 'addressResolver' | 'mihomo'>> & {
  addressResolver?: AddressResolverStrategy | Partial<AddressResolverConfig>;
  mihomo?: Partial<MihomoConfig>;
};
