import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

import {
  backupSurgeProfile,
  buildSurgeProfile,
  cleanManagedArtifacts,
  collectVlessNodes,
  ensureRequiredConfig,
  ensureUniquePolicyName,
  reloadSurgeIfEnabled,
  sanitizePolicyName,
} from '../surge';
import type { CliConfig } from '../types/cli-config';
import { pathExists, readTextFile, writeTextFile } from '../utils/fs';
import { stopManagedSingBoxProcesses } from '../utils/managed-processes';
import { parseVlessNode } from '../utils/parse-vless-node';
import { buildMihomoSurgeProxyLine, mapVlessToMihomoProxy, renderMihomoConfig, type MihomoNode } from './config';
import { getMihomoServiceStatus, installMihomoLaunchAgent, stopMihomoLaunchAgent } from './launch-agent';

const execFileAsync = promisify(execFile);
const CONFIG_FILE_NAME = 'config.yaml';
const PREVIOUS_CONFIG_FILE_NAME = 'config.previous.yaml';

const validateUdpTarget = (config: CliConfig) => {
  if (!config.udpRelay || !config.udpTestEnabled) return;
  const [hostname, address, extra] = config.udpTestTarget.split('@');
  if (!hostname || /\s/.test(hostname) || !address || extra || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    throw new Error(`Invalid UDP test target: ${config.udpTestTarget}. Expected hostname@IPv4.`);
  }
};

const collectOutbounds = async (config: CliConfig) => {
  ensureRequiredConfig(config);
  const links = await collectVlessNodes(config);
  return { links, outbounds: links.map((node, index) => parseVlessNode(node, index)) };
};

const buildNodes = async (config: CliConfig) => {
  const { links, outbounds } = await collectOutbounds(config);
  const seen = new Map<string, number>();
  const nodes: MihomoNode[] = outbounds.map((outbound, index) => {
    const name = ensureUniquePolicyName(sanitizePolicyName(outbound.tag, index), seen);
    const port = config.portStart + index;
    return {
      name,
      port,
      server: outbound.server,
      proxy: mapVlessToMihomoProxy(outbound, name, config),
    };
  });
  return { links, nodes };
};

const validateMihomoConfig = async (binary: string, candidatePath: string) => {
  if (!(await pathExists(binary))) throw new Error(`mihomo binary not found: ${binary || 'missing'}`);
  try {
    await execFileAsync(binary, ['-t', '-f', candidatePath], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error);
    throw new Error(`mihomo rejected ${basename(candidatePath)}${stderr ? `: ${stderr}` : ''}`);
  }
};

const canListen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });

const validatePorts = async (nodes: MihomoNode[]) => {
  const status = await Promise.all(nodes.map(async (node) => ({ port: node.port, available: await canListen(node.port) })));
  const conflicts = status.filter((entry) => !entry.available).map((entry) => entry.port);
  if (conflicts.length > 0) throw new Error(`Mihomo listener ports are already in use: ${conflicts.join(', ')}`);
};

const waitForController = async (config: CliConfig) => {
  const deadline = Date.now() + 15_000;
  do {
    const status = await getMihomoServiceStatus(config);
    if (status.controllerReady) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('Mihomo started but its local controller did not become ready.');
};

const previewFromNodes = async (config: CliConfig, nodes: MihomoNode[]) => {
  const proxyLines = nodes.map((node) => buildMihomoSurgeProxyLine({ name: node.name, port: node.port, config }));
  const profile = await buildSurgeProfile({ config, proxyLines, nodeNames: nodes.map((node) => node.name) });
  const previous = await readMihomoNodes(config).catch(() => []);
  const previousNames = new Set(previous.map((node) => node.name));
  const nextNames = new Set(nodes.map((node) => node.name));
  return {
    count: nodes.length,
    added: [...nextNames].filter((name) => !previousNames.has(name)).length,
    removed: [...previousNames].filter((name) => !nextNames.has(name)).length,
    profileChanged: profile.updated !== profile.source,
    policyGroupName: config.policyGroupName,
    policyGroupTargets: config.policyGroupTargets,
    policyGroupExclusions: config.policyGroupExclusions,
    policyGroupTargetModes: config.policyGroupTargetModes,
    policyGroupChanges: profile.policyGroupChanges,
    udpRelay: config.udpRelay,
    udpTestEnabled: config.udpTestEnabled,
    udpTestTarget: config.udpTestTarget,
    tcpFastOpen: config.tcpFastOpen,
    connectTimeoutEnabled: false,
    connectTimeoutSeconds: config.connectTimeoutSeconds,
    surgeConfigPath: config.surgeConfigPath,
    outputDir: config.mihomo.dataDir,
    runtimeMode: 'mihomo' as const,
    engineLabel: 'Mihomo 网关',
    proxyFormat: 'SOCKS5',
    validationSummary: 'Mihomo 配置已通过内核校验',
    nodes: nodes.map((node) => ({ name: node.name, port: node.port, server: node.server })),
  };
};

export const readMihomoNodes = async (config: CliConfig): Promise<Array<{ name: string; port: number; server: string }>> => {
  const text = await readTextFile(join(config.mihomo.dataDir, CONFIG_FILE_NAME));
  const document = parse(text) as {
    proxies?: Array<{ name?: string; server?: string }>;
    listeners?: Array<{ port?: number; proxy?: string }>;
  };
  const proxies = new Map((document.proxies ?? []).map((proxy) => [proxy.name, proxy]));
  return (document.listeners ?? []).flatMap((listener) => {
    const proxy = proxies.get(listener.proxy);
    return proxy?.name && proxy.server && Number.isInteger(listener.port)
      ? [{ name: proxy.name, port: Number(listener.port), server: proxy.server }]
      : [];
  });
};

export const syncMihomoToSurge = async (config: CliConfig, { dryRun = false }: { dryRun?: boolean } = {}) => {
  if (!config.surgeConfigPath || !(await pathExists(config.surgeConfigPath))) {
    throw new Error(`Surge profile not found: ${config.surgeConfigPath || 'missing'}`);
  }
  validateUdpTarget(config);
  await mkdir(config.mihomo.dataDir, { recursive: true });
  await mkdir(config.backupDir, { recursive: true });
  const { links, nodes } = await buildNodes(config);
  const candidatePath = join(config.mihomo.dataDir, `.candidate-${randomUUID()}.yaml`);
  await writeTextFile(candidatePath, renderMihomoConfig({ nodes, config }));
  await chmod(candidatePath, 0o600);

  try {
    await validateMihomoConfig(config.mihomo.binary, candidatePath);
    const preview = await previewFromNodes(config, nodes);
    if (dryRun) {
      console.log(`Would write ${nodes.length} nodes through Mihomo.`);
      return { dryRun: true as const, backupPath: undefined, count: nodes.length, preview };
    }

    const configPath = join(config.mihomo.dataDir, CONFIG_FILE_NAME);
    const previousPath = join(config.mihomo.dataDir, PREVIOUS_CONFIG_FILE_NAME);
    const hadConfig = await pathExists(configPath);
    const previousSurge = await readFile(config.surgeConfigPath);
    const backupPath = await backupSurgeProfile(config);
    const profile = await buildSurgeProfile({
      config,
      proxyLines: nodes.map((node) => buildMihomoSurgeProxyLine({ name: node.name, port: node.port, config })),
      nodeNames: nodes.map((node) => node.name),
    });

    try {
      if (hadConfig) await copyFile(configPath, previousPath);
      const running = await getMihomoServiceStatus(config);
      if (!running.controllerReady) {
        await stopManagedSingBoxProcesses({ singBoxBinary: config.singBoxBinary, outputDir: config.outputDir });
        await validatePorts(nodes);
      }
      await rename(candidatePath, configPath);
      await chmod(configPath, 0o600);
      await installMihomoLaunchAgent(config);
      await waitForController(config);
      await writeTextFile(config.surgeConfigPath, profile.updated);
      await reloadSurgeIfEnabled(config, profile.updated);
      if (config.subscriptionOutputPath) await writeTextFile(config.subscriptionOutputPath, `${links.join('\n')}\n`);
      return { dryRun: false as const, backupPath, count: nodes.length };
    } catch (error) {
      await writeTextFile(config.surgeConfigPath, previousSurge.toString('utf8'));
      if (await pathExists(previousPath)) {
        await copyFile(previousPath, configPath);
        await installMihomoLaunchAgent(config).catch(() => undefined);
      } else {
        await rm(configPath, { force: true });
        await stopMihomoLaunchAgent({ uninstall: true }).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
};

export const rebuildMihomoSurge = async (config: CliConfig) => {
  const nodes = await readMihomoNodes(config);
  if (nodes.length === 0) throw new Error(`No usable Mihomo listeners found in ${config.mihomo.dataDir}`);
  const profile = await buildSurgeProfile({
    config,
    proxyLines: nodes.map((node) => buildMihomoSurgeProxyLine({ name: node.name, port: node.port, config })),
    nodeNames: nodes.map((node) => node.name),
  });
  const backupPath = await backupSurgeProfile(config);
  await writeTextFile(config.surgeConfigPath, profile.updated);
  await reloadSurgeIfEnabled(config, profile.updated);
  return { backupPath, count: nodes.length };
};

export const cleanMihomoArtifacts = async (
  config: CliConfig,
  { stopService = stopMihomoLaunchAgent }: { stopService?: typeof stopMihomoLaunchAgent } = {},
) => {
  await stopService({ uninstall: true });
  const result = await cleanManagedArtifacts(config);
  const generatedConfigs = (await readdir(config.mihomo.dataDir).catch(() => [])).filter(
    (entry) =>
      entry === CONFIG_FILE_NAME ||
      entry === PREVIOUS_CONFIG_FILE_NAME ||
      /^\.candidate-[0-9A-Za-z-]+\.yaml$/.test(entry),
  );
  await Promise.all(generatedConfigs.map((entry) => rm(join(config.mihomo.dataDir, entry), { force: true })));
  return { ...result, removedMihomoConfigs: generatedConfigs.length };
};
