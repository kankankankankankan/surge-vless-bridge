import type { AddressResolverStrategy, PolicyGroupTargetMode } from '../types/cli-config';
import type { SingBoxVersionStatus } from './dependencies';

export type DesktopAction = 'doctor' | 'preview' | 'sync' | 'rebuild' | 'restore' | 'clean';

export type RepairableCheck =
  | 'surgeConfigPath'
  | 'outputDir'
  | 'backupDir'
  | 'proxy-group-section'
  | 'proxy-section';

export type SingBoxInstallMethod = 'direct' | 'homebrew';

export type ActivityEntry = {
  id: string;
  action:
    | DesktopAction
    | 'scheduled-sync'
    | 'repair-environment'
    | 'install-sing-box'
    | 'update-sing-box'
    | 'rollback-sing-box';
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
  subscriptionUrls: string[];
  vlessNodes: string[];
  surgeConfigPath: string;
  singBoxBinary: string;
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
  config: DesktopConfigView;
  doctor: {
    checks: DoctorCheckView[];
    failures: number;
    warnings: number;
  };
  nodeCount: number;
  backups: BackupView[];
  history: ActivityEntry[];
  schedule: ScheduleSettings;
  schedulerLog: string;
  profiles: Array<{ path: string; modifiedAt: string }>;
  policyGroups: PolicyGroupView[];
  environment: {
    homebrewPath?: string;
    managedSingBoxPath: string;
    singBox: SingBoxVersionStatus;
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
  };
};

export type DesktopApi = {
  getVersion: () => Promise<string>;
  getState: () => Promise<DesktopState>;
  inspectPolicyGroups: (input: { surgeConfigPath: string; policyGroupName: string }) => Promise<PolicyGroupView[]>;
  saveSources: (input: { subscriptionUrls: string[]; vlessNodes: string[] }) => Promise<DesktopState>;
  saveSettings: (input: DesktopConfigView) => Promise<DesktopState>;
  runAction: (action: DesktopAction) => Promise<ActionResult>;
  repairCheck: (check: RepairableCheck) => Promise<ActionResult>;
  installSingBox: (method: SingBoxInstallMethod) => Promise<ActionResult>;
  checkSingBoxUpdate: () => Promise<SingBoxVersionStatus>;
  rollbackSingBox: () => Promise<ActionResult>;
  saveSchedule: (input: ScheduleSettings) => Promise<ScheduleSettings>;
  disableSchedule: () => Promise<ScheduleSettings>;
  clearHistory: () => Promise<number>;
  cleanOldBackups: () => Promise<{ deletedCount: number; backups: BackupView[] }>;
  chooseFile: (kind: 'surge-profile' | 'sing-box') => Promise<string | undefined>;
  confirm: (input: { title: string; message: string; detail?: string }) => Promise<boolean>;
  revealPath: (path: string) => Promise<void>;
};
