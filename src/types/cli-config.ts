export type AddressResolverStrategy = 'system' | 'doh' | 'dns' | 'off';
export type PolicyGroupTargetMode = 'auto' | 'merge' | 'reference';
export type RuntimeMode = 'external' | 'mihomo';

export type MihomoConfig = {
  binary: string;
  dataDir: string;
  controllerHost: string;
  controllerPort: number;
  controllerSecret: string;
  autoStart: boolean;
  logLevel: 'silent' | 'error' | 'warning' | 'info' | 'debug';
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
  vlessNodes?: string[];
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
  requestHeaders: Record<string, string>;
  addressResolver: AddressResolverConfig;
};

export type CliConfigInput = Partial<Omit<CliConfig, 'addressResolver' | 'mihomo'>> & {
  addressResolver?: AddressResolverStrategy | Partial<AddressResolverConfig>;
  mihomo?: Partial<MihomoConfig>;
};
