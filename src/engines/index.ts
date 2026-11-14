import {
  cleanManagedArtifacts,
  rebuildSurgeFromLocalConfigs,
  runExternalDoctor,
  runNativeDoctor,
  syncNativeSurgeToSurge,
  syncSubscriptionToSurge,
} from '../surge';
import type { CliConfig } from '../types/cli-config';
import { withBridgeOperation } from '../utils/operation-lock';
import { runMihomoDoctor } from '../mihomo/doctor';
import { cleanMihomoArtifacts, rebuildMihomoSurge, syncMihomoToSurge } from '../mihomo/sync';

export const syncBridge = (config: CliConfig, options?: { dryRun?: boolean }) =>
  withBridgeOperation<Awaited<
    ReturnType<typeof syncMihomoToSurge> |
    ReturnType<typeof syncNativeSurgeToSurge> |
    ReturnType<typeof syncSubscriptionToSurge>
  >>(config,
    () => config.runtimeMode === 'mihomo'
      ? syncMihomoToSurge(config, options)
      : config.runtimeMode === 'surge-native'
        ? syncNativeSurgeToSurge(config, options)
        : syncSubscriptionToSurge(config, options));

export const rebuildBridge = (config: CliConfig) =>
  withBridgeOperation<Awaited<
    ReturnType<typeof rebuildMihomoSurge> |
    ReturnType<typeof syncNativeSurgeToSurge> |
    ReturnType<typeof rebuildSurgeFromLocalConfigs>
  >>(config, () => config.runtimeMode === 'mihomo'
    ? rebuildMihomoSurge(config)
    : config.runtimeMode === 'surge-native'
      ? syncNativeSurgeToSurge(config)
      : rebuildSurgeFromLocalConfigs(config));

export const cleanBridge = (config: CliConfig) =>
  withBridgeOperation(config, () => config.runtimeMode === 'mihomo' ? cleanMihomoArtifacts(config) : cleanManagedArtifacts(config));

export const doctorBridge = (config: CliConfig) =>
  config.runtimeMode === 'mihomo'
    ? runMihomoDoctor(config)
    : config.runtimeMode === 'surge-native'
      ? runNativeDoctor(config)
      : runExternalDoctor(config);
