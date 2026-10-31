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
  prepareManagedCleanup,
  parseSyncVlessNodes,
  reloadSurgeIfEnabled,
  stablePolicyNames,
} from '../surge';
import type { CliConfig } from '../types/cli-config';
import { pathExists, readTextFile, writeTextFile } from '../utils/fs';
import { stopManagedSingBoxProcesses } from '../utils/managed-processes';
import { parseVlessNode } from '../utils/parse-vless-node';
import { planStablePorts, stableNodeIdentity, stableNodeVariant, stablePortFile, type PortEntry, type PortIdentity } from '../utils/stable-ports';
import { parseClashVlessNodes } from '../utils/parse-clash-vless';
import { validateSurgeProfile } from '../utils/surge-cli';
import { buildMihomoSurgeProxyLine, mapVlessToMihomoProxy, renderMihomoConfig, type MihomoNode } from './config';
import { defaultMihomoLaunchAgentPath, getMihomoServiceStatus, installMihomoLaunchAgent, renderMihomoLaunchAgentPlist, stopMihomoLaunchAgent, waitForMihomoRuntime } from './launch-agent';
import { readMihomoVersion } from './dependencies';

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
  return { links, ...parseSyncVlessNodes(links) };
};

const buildNodes = async (config: CliConfig) => {
  const { links, outbounds, unnamed } = await collectOutbounds(config);
  const previous: PortEntry[] = [];
  const previousNames: PortIdentity[] = [];
  const configPath = join(config.mihomo.dataDir, CONFIG_FILE_NAME);
  if (await pathExists(configPath)) {
    const old = parse(await readTextFile(configPath)) as { proxies?: Array<{ name: string; server: string; port: number; uuid: string }>; listeners?: Array<{ proxy: string; port: number }> };
    for (const listener of old.listeners ?? []) {
      const proxy = old.proxies?.find(entry => entry.name === listener.proxy);
      if (proxy?.uuid && proxy.server && Number.isInteger(listener.port)) {
        let variant: string | undefined;
        try {
          const [link] = parseClashVlessNodes(JSON.stringify({ proxies: [proxy] }));
          if (link) variant = stableNodeVariant(parseVlessNode(link, 0));
        } catch {
          // Unknown legacy options must not attach a different transport to an existing identity.
        }
        const identity = { name: proxy.name, server: proxy.server, serverPort: proxy.port, uuid: proxy.uuid, variant };
        previous.push({ id: stableNodeIdentity(identity), port: listener.port });
        previousNames.push(identity);
      }
    }
  }
  const names = stablePolicyNames(outbounds, previousNames, unnamed);
  const allocation = await planStablePorts({
    filePath: stablePortFile(config.outputDir, 'mihomo'), portStart: config.portStart, previous,
    identities: outbounds.map((node, index) => stableNodeIdentity({ name: names[index]!, server: node.server, serverPort: node.server_port, uuid: node.uuid })),
  });
  const nodes: MihomoNode[] = outbounds.map((outbound, index) => {
    const name = names[index]!;
    const port = allocation.ports[index]!;
    return {
      name,
      port,
      server: outbound.server,
      proxy: mapVlessToMihomoProxy(outbound, name, config),
    };
  });
  nodes.sort((left, right) => left.port - right.port);
  return { links, nodes, commitPorts: allocation.commit };
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

const syncOperations = {
  status: getMihomoServiceStatus,
  start: installMihomoLaunchAgent,
  stop: stopMihomoLaunchAgent,
  wait: waitForController,
  verify: waitForMihomoRuntime,
  readVersion: readMihomoVersion,
  definitionMatches: async (config: CliConfig) => {
    const expected = renderMihomoLaunchAgentPlist({ binary: config.mihomo.binary, dataDir: config.mihomo.dataDir,
      configPath: join(config.mihomo.dataDir, CONFIG_FILE_NAME), autoStart: config.mihomo.autoStart });
    return (await readTextFile(defaultMihomoLaunchAgentPath()).catch(() => '')) === expected;
  },
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

export const syncMihomoToSurge = async (config: CliConfig, { dryRun = false, operations: overrides = {} }: {
  dryRun?: boolean; operations?: Partial<typeof syncOperations>;
} = {}) => {
  const operations = { ...syncOperations, ...overrides };
  if (!config.surgeConfigPath || !(await pathExists(config.surgeConfigPath))) {
    throw new Error(`Surge profile not found: ${config.surgeConfigPath || 'missing'}`);
  }
  validateUdpTarget(config);
  await mkdir(config.mihomo.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.backupDir, { recursive: true, mode: 0o700 });
  const { links, nodes, commitPorts } = await buildNodes(config);
  const candidatePath = join(config.mihomo.dataDir, `.candidate-${randomUUID()}.yaml`);
  const nextConfig = renderMihomoConfig({ nodes, config });
  await writeTextFile(candidatePath, nextConfig);
  await chmod(candidatePath, 0o600);

  try {
    await validateMihomoConfig(config.mihomo.binary, candidatePath);
    const preview = await previewFromNodes(config, nodes);
    const profile = await buildSurgeProfile({
      config,
      proxyLines: nodes.map((node) => buildMihomoSurgeProxyLine({ name: node.name, port: node.port, config })),
      nodeNames: nodes.map((node) => node.name),
    });
    const surgeValidation = await validateSurgeProfile(profile.updated, config.surgeConfigPath);
    preview.validationSummary = surgeValidation.checked ? 'Mihomo 与 Surge 配置已通过校验'
      : `Mihomo 配置已通过校验；${surgeValidation.warning}`;
    if (dryRun) {
      console.log(`Would write ${nodes.length} nodes through Mihomo.`);
      return { dryRun: true as const, backupPath: undefined, count: nodes.length, preview };
    }

    const configPath = join(config.mihomo.dataDir, CONFIG_FILE_NAME);
    const previousPath = join(config.mihomo.dataDir, PREVIOUS_CONFIG_FILE_NAME);
    const hadConfig = await pathExists(configPath);
    const previousSurge = await readFile(config.surgeConfigPath);
    const running = await operations.status(config);
    if (running.loaded && !running.serviceMatchesConfig) throw new Error('Mihomo 服务与当前配置不匹配，已停止同步。');
    if (running.controllerReady && (!running.loaded || !running.pid)) throw new Error('Controller 由未确认归属的进程提供服务，已停止同步。');
    const sameConfig = hadConfig && await readTextFile(configPath) === nextConfig;
    if (sameConfig && running.controllerReady && running.serviceMatchesConfig && await operations.definitionMatches(config)) {
      let healthy = false;
      try {
        await operations.verify(config, await operations.readVersion(config.mihomo.binary), 1_500);
        healthy = true;
      } catch { /* A stale or unhealthy managed service must be repaired even when its files match. */ }
      if (healthy) {
        const profileChanged = profile.updated !== previousSurge.toString('utf8');
        const backupPath = profileChanged ? await backupSurgeProfile(config) : undefined;
        try {
          if (profileChanged) await writeTextFile(config.surgeConfigPath, profile.updated);
          if (config.subscriptionOutputPath) {
            const value = `${links.join('\n')}\n`;
            if (await readTextFile(config.subscriptionOutputPath).catch(() => '') !== value) await writeTextFile(config.subscriptionOutputPath, value);
          }
          await commitPorts();
        } catch (error) {
          if (profileChanged) await writeTextFile(config.surgeConfigPath, previousSurge.toString('utf8'));
          throw error;
        }
        if (profileChanged) await reloadSurgeIfEnabled(config, profile.updated);
        console.log('Mihomo 配置未变化，运行状态已验证，已跳过重启。');
        return { dryRun: false as const, backupPath, count: nodes.length, unchanged: !profileChanged };
      }
    }
    const backupPath = await backupSurgeProfile(config);

    try {
      if (hadConfig) await copyFile(configPath, previousPath);
      if (!running.controllerReady) {
        if (running.loaded && running.pid) await operations.stop({});
        await stopManagedSingBoxProcesses({ singBoxBinary: config.singBoxBinary, outputDir: config.outputDir });
        await validatePorts(nodes);
      }
      await rename(candidatePath, configPath);
      await chmod(configPath, 0o600);
      await operations.start(config);
      await operations.wait(config);
      await operations.verify(config, await operations.readVersion(config.mihomo.binary));
      await writeTextFile(config.surgeConfigPath, profile.updated);
      if (config.subscriptionOutputPath) await writeTextFile(config.subscriptionOutputPath, `${links.join('\n')}\n`);
      await commitPorts();
      await reloadSurgeIfEnabled(config, profile.updated);
      return { dryRun: false as const, backupPath, count: nodes.length };
    } catch (error) {
      await writeTextFile(config.surgeConfigPath, previousSurge.toString('utf8'));
      if (hadConfig && await pathExists(previousPath)) {
        await copyFile(previousPath, configPath);
        await operations.start(config).catch(() => undefined);
      } else {
        await rm(configPath, { force: true });
        await operations.stop({ uninstall: true }).catch(() => undefined);
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
  await validateSurgeProfile(profile.updated, config.surgeConfigPath);
  const backupPath = await backupSurgeProfile(config);
  await writeTextFile(config.surgeConfigPath, profile.updated);
  await reloadSurgeIfEnabled(config, profile.updated);
  return { backupPath, count: nodes.length };
};

export const cleanMihomoArtifacts = async (
  config: CliConfig,
  { stopService = stopMihomoLaunchAgent }: { stopService?: typeof stopMihomoLaunchAgent } = {},
) => {
  const profile = await prepareManagedCleanup(config);
  await stopService({ uninstall: true });
  const result = await cleanManagedArtifacts(config, profile);
  const generatedConfigs = (await readdir(config.mihomo.dataDir).catch(() => [])).filter(
    (entry) =>
      entry === CONFIG_FILE_NAME ||
      entry === PREVIOUS_CONFIG_FILE_NAME ||
      /^\.candidate-[0-9A-Za-z-]+\.yaml$/.test(entry),
  );
  await Promise.all(generatedConfigs.map((entry) => rm(join(config.mihomo.dataDir, entry), { force: true })));
  return { ...result, removedMihomoConfigs: generatedConfigs.length };
};
