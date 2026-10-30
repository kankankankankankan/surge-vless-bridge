import {
  cleanManagedArtifacts,
  rebuildSurgeFromLocalConfigs,
  runExternalDoctor,
  syncSubscriptionToSurge,
} from '../surge';
import type { CliConfig } from '../types/cli-config';
import { withBridgeOperation } from '../utils/operation-lock';
import { runMihomoDoctor } from '../mihomo/doctor';
import { cleanMihomoArtifacts, rebuildMihomoSurge, syncMihomoToSurge } from '../mihomo/sync';

export const syncBridge = (config: CliConfig, options?: { dryRun?: boolean }) =>
  withBridgeOperation(config, () => config.runtimeMode === 'mihomo' ? syncMihomoToSurge(config, options) : syncSubscriptionToSurge(config, options));

export const rebuildBridge = (config: CliConfig) =>
  withBridgeOperation(config, () => config.runtimeMode === 'mihomo' ? rebuildMihomoSurge(config) : rebuildSurgeFromLocalConfigs(config));

export const cleanBridge = (config: CliConfig) =>
  withBridgeOperation(config, () => config.runtimeMode === 'mihomo' ? cleanMihomoArtifacts(config) : cleanManagedArtifacts(config));

export const doctorBridge = (config: CliConfig) =>
  config.runtimeMode === 'mihomo' ? runMihomoDoctor(config) : runExternalDoctor(config);
