import type { AddressResolverStrategy, PolicyGroupTargetMode, RuntimeMode, SubscriptionOptions } from '../types/cli-config';
import type { SingBoxVersionStatus } from './dependencies';
import type { MihomoVersionStatus } from '../mihomo/dependencies';
import type { MihomoServiceStatus } from '../mihomo/launch-agent';
import type { InstallProgressEvent } from '../install-progress';
import type { SubscriptionStatus } from '../utils/subscription-cache';
import type { diagnoseMihomoNode } from '../mihomo/probe';

export type DesktopAction = 'doctor' | 'preview' | 'sync' | 'rebuild' | 'restore' | 'clean';

export type RepairableCheck =
  | 'surgeConfigPath'
  | 'outputDir'
  | 'backupDir'
  | 'mihomo-data-dir'
  | 'mihomo-launch-agent'
  | 'mihomo-controller'
  | 'mihomo-listeners'
  | 'proxy-group-section'
  | 'proxy-section'
  | 'rule-section';

export type SingBoxInstallMethod = 'direct' | 'homebrew';
export type MihomoInstallMethod = 'direct' | 'homebrew';
export type MihomoServiceAction = 'start' | 'stop' | 'restart';

export type ActivityEntry = {
  id: string;
  action:
    | DesktopAction
    | 'scheduled-sync'
    | 'repair-environment'
    | 'install-sing-box'
    | 'update-sing-box'
    | 'rollback-sing-box'
    | 'install-mihomo'
    | 'update-mihomo'
    | 'rollback-mihomo'
    | 'start-mihomo'
    | 'stop-mihomo'
    | 'switch-engine';
  success: boolean;
  message: string;
  output: string;
  createdAt: string;
  count?: number;
};

export type ScheduleSettings = {
  enabled: boolean;
  kind: 'interval' | 'daily';
  intervalHours: number;
  hour: number;
  minute: number;
  runAtLoad: boolean;
};

export type DesktopConfigView = {
  runtimeMode: RuntimeMode;
  subscriptionUrls: string[];
  subscriptionNames: string[];
  subscriptionOptions: SubscriptionOptions[];
  vlessNodes: string[];
  surgeConfigPath: string;
  singBoxBinary: string;
  mihomoBinary: string;
  mihomoDataDir: string;
  mihomoControllerPort: number;
  mihomoAutoStart: boolean;
  mihomoLogLevel: 'silent' | 'error' | 'warning' | 'info' | 'debug';
  policyGroupName: string;
  policyGroupTargets: string[];
  policyGroupExclusions: string[];
  policyGroupTargetModes: Record<string, PolicyGroupTargetMode>;
  portStart: number;
  backupKeep: number;
  autoReload: boolean;
  udpRelay: boolean;
  udpTestEnabled: boolean;
  udpTestTarget: string;
  tcpFastOpen: boolean;
  connectTimeoutEnabled: boolean;
  connectTimeoutSeconds: number;
  addressResolverStrategy: AddressResolverStrategy;
  addressResolverDohEndpoint: string;
  addressResolverDnsServers: string[];
  addressResolverFilterSurgeFakeIp: boolean;
};

export type DoctorCheckView = {
  label: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
};

export type BackupView = {
  path: string;
  name: string;
  modifiedAt: string;
  size: number;
};

export type PolicyGroupView = {
  name: string;
  containsPolicyGroup: boolean;
  membershipMode?: 'merge' | 'reference' | 'both';
  groupType: string;
  hasIncludeOtherGroup: boolean;
  hasPolicyRegexFilter: boolean;
  recommendedMode: Exclude<PolicyGroupTargetMode, 'auto'>;
};

export type DesktopState = {
  configPath: string;
  configExists: boolean;
  runtimeModeConfirmed: boolean;
  config: DesktopConfigView;
  doctor: {
    checks: DoctorCheckView[];
    failures: number;
    warnings: number;
  };
  nodeCount: number;
  subscriptionStatuses: Array<SubscriptionStatus | undefined>;
  diagnosticNodes: Array<{ name: string; port: number }>;
  backups: BackupView[];
  history: ActivityEntry[];
  schedule: ScheduleSettings;
  schedulerLog: string;
  profiles: Array<{ path: string; modifiedAt: string }>;
  policyGroups: PolicyGroupView[];
  environment: {
    homebrewPath?: string;
    managedSingBoxPath: string;
    managedMihomoPath: string;
    singBox: SingBoxVersionStatus;
    mihomo: MihomoVersionStatus;
    mihomoService: MihomoServiceStatus;
    controllerSecretConfigured: boolean;
  };
};

export type ActionResult = {
  success: boolean;
  message: string;
  output: string;
  count?: number;
  preview?: {
    count: number;
    added: number;
    removed: number;
    profileChanged: boolean;
    policyGroupName: string;
    policyGroupTargets: string[];
    policyGroupExclusions: string[];
    policyGroupTargetModes: Record<string, PolicyGroupTargetMode>;
    udpRelay: boolean;
    udpTestEnabled: boolean;
    udpTestTarget: string;
    tcpFastOpen: boolean;
    connectTimeoutEnabled: boolean;
    connectTimeoutSeconds: number;
    policyGroupChanges: Array<{
      name: string;
      action: 'add' | 'remove';
      mode: PolicyGroupTargetMode;
      resolvedMode: Exclude<PolicyGroupTargetMode, 'auto'>;
      before: string;
      after: string;
    }>;
    surgeConfigPath: string;
    outputDir: string;
    nodes: Array<{ name: string; port: number; server: string }>;
    runtimeMode?: RuntimeMode;
    engineLabel?: string;
    proxyFormat?: string;
    validationSummary?: string;
  };
};

export type DesktopApi = {
  getVersion: () => Promise<string>;
  getState: () => Promise<DesktopState>;
  diagnoseNode: (input: { port: number; name: string }) => ReturnType<typeof diagnoseMihomoNode>;
  inspectPolicyGroups: (input: { surgeConfigPath: string; policyGroupName: string }) => Promise<PolicyGroupView[]>;
  saveSources: (input: { subscriptionUrls: string[]; subscriptionNames?: string[]; subscriptionOptions?: SubscriptionOptions[]; vlessNodes: string[] }) => Promise<DesktopState>;
  previewSourceFilters: (input: { subscriptionUrl: string; options: SubscriptionOptions }) => Promise<{ available: boolean; total: number; matched: number; skipped: number }>;
  saveSettings: (input: DesktopConfigView) => Promise<DesktopState>;
  runAction: (action: DesktopAction) => Promise<ActionResult>;
  repairCheck: (check: RepairableCheck) => Promise<ActionResult>;
  installSingBox: (method: SingBoxInstallMethod) => Promise<ActionResult>;
  checkSingBoxUpdate: () => Promise<SingBoxVersionStatus>;
  rollbackSingBox: () => Promise<ActionResult>;
  installMihomo: (method: MihomoInstallMethod) => Promise<ActionResult>;
  checkMihomoUpdate: () => Promise<MihomoVersionStatus>;
  rollbackMihomo: () => Promise<ActionResult>;
  controlMihomo: (action: MihomoServiceAction) => Promise<ActionResult>;
  switchEngine: (targetMode: RuntimeMode) => Promise<ActionResult>;
  saveSchedule: (input: ScheduleSettings) => Promise<ScheduleSettings>;
  disableSchedule: () => Promise<ScheduleSettings>;
  clearHistory: () => Promise<number>;
  cleanOldBackups: () => Promise<{ deletedCount: number; backups: BackupView[] }>;
  chooseFile: (kind: 'surge-profile' | 'sing-box' | 'mihomo') => Promise<string | undefined>;
  confirm: (input: { title: string; message: string; detail?: string }) => Promise<boolean>;
  revealPath: (path: string) => Promise<void>;
  onInstallProgress: (listener: (event: InstallProgressEvent) => void) => () => void;
};
