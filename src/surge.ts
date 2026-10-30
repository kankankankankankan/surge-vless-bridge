import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Resolver, lookup } from 'node:dns/promises';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isIP } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getVlessSubscriptionNodes } from './parse';
import { SubscriptionError } from './utils/subscription-error';
import { pruneSubscriptionCache, readSubscriptionCache, writeSubscriptionCache } from './utils/subscription-cache';
import { withDirectoryLock } from './utils/operation-lock';
import type { AddressResolverConfig, CliConfig, PolicyGroupTargetMode } from './types/cli-config';
import type { SingBoxVlessOutbound } from './types/sing-box-vless-outbound';
import { parseTemplate } from './utils/parse-template';
import { pathExists, readJsonFile, readTextFile, writeBinaryFile, writeTextFile } from './utils/fs';
import { parseVlessNode } from './utils/parse-vless-node';
import { stopManagedSingBoxProcesses } from './utils/managed-processes';
import { parseHttpApiSettings, reloadSurgeProfile } from './utils/surge-reload';

const POLICY_REGEX_FILTER = /^((?!Remain|Expired|官网|如需|套餐|去除|剩余|距离|Reset|重置|流量).)+$/;
const MANAGED_CONFIG_PATTERN = /^sing-box\[\d+\]\.json$/;
const MANIFEST_FILE_NAME = 'manifest.json';
const SING_BOX_CHECK_CONCURRENCY = 8;
const SING_BOX_CHECK_TIMEOUT_MS = 15_000;
const DOH_RECORD_TYPES = {
  A: 1,
  AAAA: 28,
} as const;

type GeneratedNode = {
  nodeName: string;
  port: number;
  configPath: string;
  server: string;
};

type StagedGeneratedNode = GeneratedNode & {
  stagedConfigPath: string;
};

type ManagedConfigManifest = {
  version: 1;
  files: string[];
};

type SingBoxConfig = {
  outbounds?: Array<{
    tag?: string;
    server?: string;
  }>;
};

const execFileAsync = promisify(execFile);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Bounded so a large subscription does not spawn one sing-box process per node at once.
const mapWithConcurrency = async <T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) => {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const isSurgeFakeIp = (address: string) => {
  if (isIP(address) !== 4) {
    return false;
  }

  const [first, second] = address.split('.').map((part) => Number(part));
  return first === 198 && (second === 18 || second === 19);
};

// Surge accepts a single value in `addresses=`, and A/AAAA records arrive in an unstable order.
// IPv4 comes first so the written address is deterministic and usable on IPv4-only networks.
const uniqueRealAddresses = (addresses: string[], resolverConfig: AddressResolverConfig) =>
  [
    ...new Set(
      addresses.filter((address) => isIP(address) && (!resolverConfig.filterSurgeFakeIp || !isSurgeFakeIp(address))),
    ),
  ].sort((left, right) => Number(isIP(right) === 4) - Number(isIP(left) === 4));

const resolveWithSystem = async (server: string) => {
  const records = await lookup(server, { all: true });
  return records.map((record) => record.address);
};

const resolveWithDnsServers = async (server: string, dnsServers: string[]) => {
  const resolver = new Resolver();
  if (dnsServers.length > 0) {
    resolver.setServers(dnsServers);
  }

  const settled = await Promise.allSettled([resolver.resolve4(server), resolver.resolve6(server)]);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
};

const queryDohAddresses = async (server: string, recordType: keyof typeof DOH_RECORD_TYPES, dohEndpoint: string) => {
  const url = new URL(dohEndpoint);
  url.searchParams.set('name', server);
  url.searchParams.set('type', recordType);

  const response = await fetch(url, {
    headers: {
      accept: 'application/dns-json',
    },
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    Answer?: Array<{
      type?: number;
      data?: string;
    }>;
  };

  if (!Array.isArray(payload.Answer)) {
    return [];
  }

  const answerType = DOH_RECORD_TYPES[recordType];
  return payload.Answer.filter((answer) => answer.type === answerType && typeof answer.data === 'string').map(
    (answer) => answer.data as string,
  );
};

const resolveWithDoh = async (server: string, dohEndpoint: string) => {
  const settled = await Promise.allSettled([
    queryDohAddresses(server, 'A', dohEndpoint),
    queryDohAddresses(server, 'AAAA', dohEndpoint),
  ]);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
};

export const sanitizePolicyName = (tag: string, index: number) => {
  const candidate = POLICY_REGEX_FILTER.test(tag) ? tag : `node${index + 1}`;
  const sanitized = candidate
    .replace(/[,\n\r=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || `node${index + 1}`;
};

type ResolverAttempt = {
  label: string;
  run: () => Promise<string[]>;
};

export const ensureUniquePolicyName = (nodeName: string, seenNames: Map<string, number>) => {
  const previousCount = seenNames.get(nodeName) ?? 0;
  seenNames.set(nodeName, previousCount + 1);

  if (previousCount === 0) {
    return nodeName;
  }

  return `${nodeName} ${previousCount + 1}`;
};

// `subscriptionUrl` and `subscriptionUrls` are merged rather than one shadowing the other: a user
// adding a second provider usually keeps the legacy single-URL field, and dropping it silently would
// remove every node of their original subscription. The legacy field stays first so existing node
// order, and therefore the assigned local ports, do not shift.
export const getSubscriptionUrls = (config: CliConfig) => {
  const urls = [config.subscriptionUrl, ...(config.subscriptionUrls ?? [])];

  return [
    ...new Set(
      urls.filter((url): url is string => typeof url === 'string' && url.trim() !== '').map((url) => url.trim()),
    ),
  ];
};

export const getConfiguredVlessNodes = (config: CliConfig) =>
  (config.vlessNodes ?? [])
    .filter((node): node is string => typeof node === 'string' && node.trim() !== '')
    .map((node) => node.trim());

export const collectVlessNodes = (config: CliConfig) => withDirectoryLock(join(config.outputDir, '.subscription-operation.lock'), async () => {
  const subscriptionUrls = getSubscriptionUrls(config);
  const failures: string[] = [];
  await pruneSubscriptionCache(config, subscriptionUrls);
  const describeSubscription = (index: number) => `Subscription ${index + 1} of ${subscriptionUrls.length}`;
  const vlessNodesBySubscription = await Promise.all(
    subscriptionUrls.map(async (subscriptionUrl, index) => {
      const previous = await readSubscriptionCache(config, subscriptionUrl);
      const checkedAt = new Date().toISOString();
      let nodes: string[];
      try {
        nodes = await getVlessSubscriptionNodes({
          subscriptionUrl,
          requestHeaders: config.requestHeaders,
        });
        nodes.forEach((node, nodeIndex) => parseVlessNode(node, nodeIndex));
      } catch (error) {
        const detail = error instanceof SubscriptionError ? error.message : '订阅读取失败。';
        failures[index] = `订阅 ${index + 1}：${detail}`;
        const cached = previous?.lastSuccessAt ? previous.nodes : [];
        await writeSubscriptionCache(config, subscriptionUrl, {
          version: 1, nodes: cached, count: cached.length, checkedAt,
          lastSuccessAt: previous?.lastSuccessAt,
          state: previous?.lastSuccessAt ? 'cached' : 'failed', detail,
        });
        console.warn(`${describeSubscription(index)}: ${detail}${previous?.lastSuccessAt
          ? ` 使用 ${previous.lastSuccessAt} 的缓存（${cached.length} 个节点）。`
          : ' 无可用缓存，已跳过。'}`);
        return cached;
      }
      // A valid empty document replaces the old snapshot; only failures use cached nodes.
      await writeSubscriptionCache(config, subscriptionUrl, {
        version: 1, nodes, count: nodes.length, checkedAt, lastSuccessAt: checkedAt, state: 'fresh',
      });
      if (nodes.length === 0) {
        failures[index] = `订阅 ${index + 1}：已识别订阅，但没有 VLESS 节点。`;
        console.warn(`${describeSubscription(index)} returned no VLESS nodes.`);
      }
      return nodes;
    }),
  );

  const nodes = [
    ...new Set([...vlessNodesBySubscription.flat(), ...getConfiguredVlessNodes(config)].map((node) => node.trim())),
  ].filter(Boolean);
  if (nodes.length === 0) {
    throw new Error(['No VLESS nodes from any configured source; refusing to update the Surge profile.', ...failures.filter(Boolean)].join('\n'));
  }
  return nodes;
});

const resolveAddresses = async (server: string, resolverConfig: AddressResolverConfig) => {
  if (resolverConfig.strategy === 'off') {
    return [];
  }

  if (isIP(server)) {
    return uniqueRealAddresses([server], resolverConfig);
  }

  const doh: ResolverAttempt = {
    label: 'doh',
    run: () => resolveWithDoh(server, resolverConfig.dohEndpoint),
  };
  const dns: ResolverAttempt = {
    label: 'dns',
    run: () => resolveWithDnsServers(server, resolverConfig.dnsServers),
  };
  const system: ResolverAttempt = {
    label: 'system',
    run: () => resolveWithSystem(server),
  };

  // Surge's enhanced mode answers system DNS with fake IPs (198.18.0.0/15), which would pin an
  // unusable address into the external proxy line. Every strategy therefore falls back to the
  // resolvers that bypass the system resolver before giving up.
  const chain: ResolverAttempt[] =
    resolverConfig.strategy === 'dns'
      ? [dns, doh, system]
      : resolverConfig.strategy === 'system'
        ? [system, doh, dns]
        : [doh, dns, system];

  let sawFakeIp = false;

  for (const attempt of chain) {
    let addresses: string[];
    try {
      addresses = await attempt.run();
    } catch (error) {
      console.error(`Failed to resolve ${server} via ${attempt.label}:`, error);
      continue;
    }

    const usable = uniqueRealAddresses(addresses, resolverConfig);
    if (usable.length > 0) {
      if (sawFakeIp) {
        console.warn(`Resolved ${server} via ${attempt.label} after discarding Surge fake IP results.`);
      }

      return usable;
    }

    if (resolverConfig.filterSurgeFakeIp && addresses.some(isSurgeFakeIp)) {
      sawFakeIp = true;
      console.warn(
        `Discarded Surge fake IP result for ${server} from ${attempt.label}; trying the next resolver.`,
      );
    }
  }

  console.error(`Failed to resolve a usable address for ${server}; the external proxy entry will omit addresses=.`);
  return [];
};

const buildExternalProxyLine = async ({
  nodeName,
  port,
  configPath,
  server,
  singBoxBinary,
  addressResolver,
  udpRelay,
  udpTestEnabled,
  udpTestTarget,
}: GeneratedNode & {
  singBoxBinary: string;
  addressResolver: AddressResolverConfig;
  udpRelay: boolean;
  udpTestEnabled: boolean;
  udpTestTarget: string;
}) => {
  const addresses = await resolveAddresses(server, addressResolver);
  const addressArg = addresses.length > 0 ? `, addresses=${addresses[0]}` : '';
  const udpRelayArg = udpRelay ? ', udp-relay=true' : '';
  if (udpRelay && udpTestEnabled) {
    const [hostname, address, extra] = udpTestTarget.split('@');
    if (!hostname || /\s/.test(hostname) || !address || extra || isIP(address) !== 4) {
      throw new Error(`Invalid UDP test target: ${udpTestTarget}. Expected hostname@IPv4.`);
    }
  }
  const udpTestArg = udpRelay && udpTestEnabled ? `, test-udp=${udpTestTarget}` : '';
  return `${nodeName} = external, exec=${singBoxBinary}, args=run, args=-c, args=${configPath}, local-port=${port}${addressArg}${udpRelayArg}${udpTestArg}`;
};

export const ensureRequiredConfig = (config: CliConfig) => {
  if (getSubscriptionUrls(config).length === 0 && getConfiguredVlessNodes(config).length === 0) {
    throw new Error(
      'Missing subscriptionUrl/subscriptionUrls/vlessNodes. Run `surge-vless-bridge init` and fill the config, or pass --subscription-url.',
    );
  }

  if (!config.surgeConfigPath) {
    throw new Error(
      'Missing surgeConfigPath. Run `surge-vless-bridge init` and fill the config, or pass --surge-config.',
    );
  }
};

// Checked before anything is generated: a wrong sing-box path produces nodes Surge can never start,
// and the failure is far easier to understand here than as a Surge popup.
const ensureRuntimePaths = async (config: CliConfig) => {
  if (!config.surgeConfigPath || !(await pathExists(config.surgeConfigPath))) {
    throw new Error(`Surge profile not found: ${config.surgeConfigPath || 'missing'}`);
  }

  if (!config.singBoxBinary || !(await pathExists(config.singBoxBinary))) {
    throw new Error(`sing-box binary not found: ${config.singBoxBinary || 'missing'}`);
  }
};

export const ensureWritableDirs = async (config: CliConfig) => {
  await mkdir(config.outputDir, { recursive: true });
  await mkdir(config.backupDir, { recursive: true });
};

// `sing-box check` validates structure only: it rejects malformed JSON, unknown outbound types and
// out-of-range values, but accepts an outbound with missing or nonsensical fields. It is a guard
// against this tool generating structurally broken configs, not a connectivity test.
const validateSingBoxConfig = async (singBoxBinary: string, configPath: string) => {
  try {
    await execFileAsync(singBoxBinary, ['check', '-c', configPath], {
      maxBuffer: 1024 * 1024,
      timeout: SING_BOX_CHECK_TIMEOUT_MS,
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error);
    throw new Error(`sing-box rejected ${basename(configPath)}${stderr ? `: ${stderr}` : ''}`);
  }
};

// The manifest records exactly which files the last sync produced. Without it `rebuild` globs the
// output directory and resurrects nodes that have since been removed from the subscription.
const readManagedConfigEntries = async (outputDir: string) => {
  const manifestPath = join(outputDir, MANIFEST_FILE_NAME);
  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFile<ManagedConfigManifest>(manifestPath);
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.files) ||
      manifest.files.some((entry) => !MANAGED_CONFIG_PATTERN.test(entry))
    ) {
      throw new Error(`Invalid managed config manifest: ${manifestPath}`);
    }

    return [...new Set(manifest.files)].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  // No manifest yet: fall back to globbing so an install that predates the manifest still rebuilds.
  return (await readdir(outputDir))
    .filter((entry) => MANAGED_CONFIG_PATTERN.test(entry))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
};

const promoteGeneratedConfigs = async (config: CliConfig, generated: StagedGeneratedNode[]) => {
  for (const entry of generated) {
    await rename(entry.stagedConfigPath, entry.configPath);
  }

  const manifest: ManagedConfigManifest = {
    version: 1,
    files: generated.map((entry) => basename(entry.configPath)),
  };
  await writeTextFile(join(config.outputDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
};

const removeStaleConfigs = async (outputDir: string, generated: GeneratedNode[]) => {
  const expected = new Set(generated.map((entry) => basename(entry.configPath)));
  const staleFiles = (await readdir(outputDir)).filter(
    (entry) => MANAGED_CONFIG_PATTERN.test(entry) && !expected.has(entry),
  );

  await Promise.all(staleFiles.map((entry) => rm(join(outputDir, entry), { force: true })));
  return staleFiles.length;
};

// Every sync, rebuild and clean writes a backup, so without pruning the directory grows without
// bound: a daily sync leaves 365 profiles behind in a year.
const pruneBackups = async (backupDir: string, keep: number) => {
  if (!Number.isFinite(keep) || keep <= 0) {
    return 0;
  }

  const backups = await listBackups(backupDir);
  const stale = backups.slice(keep);
  await Promise.all(stale.map((path) => rm(path, { force: true })));
  return stale.length;
};

export const backupSurgeProfile = async (config: CliConfig) => {
  await mkdir(config.backupDir, { recursive: true });

  const bytes = await readJsonCompatibleBinary(config.surgeConfigPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(config.backupDir, `${basename(config.surgeConfigPath, '.conf')}-${timestamp}.conf`);

  await writeBinaryFile(backupPath, bytes);
  await pruneBackups(config.backupDir, config.backupKeep);
  return backupPath;
};

const updatePolicyGroup = ({
  surgeText,
  policyGroupName,
  nodeNames,
}: {
  surgeText: string;
  policyGroupName: string;
  nodeNames: string[];
}) => {
  const sectionPattern = /(\[Proxy Group\])([\s\S]*?)(?=\n\[|$)/;
  const groupPattern = new RegExp(`^${escapeRegExp(policyGroupName)}\\s*=.*$`, 'm');
  const groupLine = `${policyGroupName} = url-test, ${nodeNames.join(', ')}, no-alert=0, hidden=0`;

  return surgeText.replace(sectionPattern, (match, sectionTitle, sectionBody) => {
    if (groupPattern.test(sectionBody)) {
      return `${sectionTitle}${sectionBody.replace(groupPattern, groupLine)}`;
    }

    return `${match}\n${groupLine}`;
  });
};

type PolicyGroupToken = {
  value: string;
  start: number;
  end: number;
  separatorBefore?: number;
};

const splitPolicyGroupTokens = (value: string): PolicyGroupToken[] => {
  const tokens: PolicyGroupToken[] = [];
  let start = 0;
  let separatorBefore: number | undefined;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ',') {
      tokens.push({ value: value.slice(start, index).trim(), start, end: index, separatorBefore });
      separatorBefore = index;
      start = index + 1;
    }
  }

  tokens.push({ value: value.slice(start).trim(), start, end: value.length, separatorBefore });
  return tokens;
};

const findInlineRequirementIndex = (value: string) => {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && value[index + 1] === '!' && (index === 0 || /\s/.test(value[index - 1]!))) {
      return index;
    }
  }

  return value.length;
};

const policyGroupParameterIndex = (tokens: PolicyGroupToken[]) =>
  tokens.findIndex((token, index) => index > 0 && /^[A-Za-z][A-Za-z0-9-]*\s*=/.test(token.value));

const includeOtherGroupNames = (tokens: PolicyGroupToken[]) => {
  const token = tokens.find((entry) => /^include-other-group\s*=/i.test(entry.value));
  if (!token) {
    return [];
  }

  const rawValue = token.value.slice(token.value.indexOf('=') + 1).trim();
  const quote =
    rawValue.length >= 2 &&
    (rawValue[0] === '"' || rawValue[0] === "'") &&
    rawValue.at(-1) === rawValue[0]
      ? rawValue[0]
      : undefined;
  const value = quote ? rawValue.slice(1, -1) : rawValue;
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
};

const hasPolicyGroupParameter = (tokens: PolicyGroupToken[], name: string) =>
  tokens.some((token) => new RegExp(`^${escapeRegExp(name)}\\s*=`, 'i').test(token.value));

const resolvePolicyGroupTargetMode = (
  tokens: PolicyGroupToken[],
  requestedMode: PolicyGroupTargetMode,
): Exclude<PolicyGroupTargetMode, 'auto'> => {
  if (requestedMode !== 'auto') {
    return requestedMode;
  }

  const groupType = tokens[0]?.value.toLowerCase();
  return groupType === 'smart' ||
    hasPolicyGroupParameter(tokens, 'include-other-group') ||
    hasPolicyGroupParameter(tokens, 'policy-regex-filter')
    ? 'merge'
    : 'reference';
};

export const inspectPolicyGroups = ({ surgeText, policyGroupName }: { surgeText: string; policyGroupName: string }) => {
  const section = surgeText.match(/\[Proxy Group\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  if (!section) {
    return [];
  }

  const seen = new Set<string>();
  return section.split('\n').flatMap((line) => {
    const equalsIndex = line.indexOf('=');
    if (equalsIndex < 0 || line.trimStart().startsWith('#')) {
      return [];
    }

    const name = line.slice(0, equalsIndex).trim();
    if (!name || name === policyGroupName || seen.has(name)) {
      return [];
    }
    seen.add(name);

    const right = line.slice(equalsIndex + 1);
    const definition = right.slice(0, findInlineRequirementIndex(right));
    const tokens = splitPolicyGroupTokens(definition);
    const parameterIndex = policyGroupParameterIndex(tokens);
    const memberEnd = parameterIndex < 0 ? tokens.length : parameterIndex;
    const containsDirectMember = tokens.slice(1, memberEnd).some((token) => token.value === policyGroupName);
    const containsIncludedGroup = includeOtherGroupNames(tokens).includes(policyGroupName);
    const groupType = tokens[0]?.value.toLowerCase() ?? '';
    const hasIncludeOtherGroup = hasPolicyGroupParameter(tokens, 'include-other-group');
    const hasPolicyRegexFilter = hasPolicyGroupParameter(tokens, 'policy-regex-filter');
    const membershipMode: 'merge' | 'reference' | 'both' | undefined =
      containsDirectMember && containsIncludedGroup
        ? 'both'
        : containsIncludedGroup
          ? 'merge'
          : containsDirectMember
            ? 'reference'
            : undefined;

    return [
      {
        name,
        containsPolicyGroup: containsDirectMember || containsIncludedGroup,
        membershipMode,
        groupType,
        hasIncludeOtherGroup,
        hasPolicyRegexFilter,
        recommendedMode: resolvePolicyGroupTargetMode(tokens, 'auto'),
      },
    ];
  });
};

const removeDirectPolicyGroupMembers = (definition: string, memberName: string) => {
  let updated = definition;

  while (true) {
    const tokens = splitPolicyGroupTokens(updated);
    const parameterIndex = policyGroupParameterIndex(tokens);
    const memberEnd = parameterIndex < 0 ? tokens.length : parameterIndex;
    const memberIndex = tokens.findIndex(
      (token, index) => index > 0 && index < memberEnd && token.value === memberName,
    );
    if (memberIndex < 0) {
      return updated;
    }

    const token = tokens[memberIndex]!;
    updated = `${updated.slice(0, token.separatorBefore!)}${updated.slice(token.end)}`;
  }
};

const replacePolicyGroupToken = (definition: string, token: PolicyGroupToken, replacement: string) => {
  const rawToken = definition.slice(token.start, token.end);
  const leadingSpace = rawToken.match(/^\s*/)?.[0] ?? '';
  const trailingSpace = rawToken.match(/\s*$/)?.[0] ?? '';
  return `${definition.slice(0, token.start)}${leadingSpace}${replacement}${trailingSpace}${definition.slice(token.end)}`;
};

const updateIncludedPolicyGroup = (definition: string, memberName: string, action: 'add' | 'remove') => {
  const tokens = splitPolicyGroupTokens(definition);
  const parameterIndex = policyGroupParameterIndex(tokens);
  const includeToken = tokens.find((token) => /^include-other-group\s*=/i.test(token.value));

  if (!includeToken) {
    if (action === 'remove') {
      return definition;
    }

    if (parameterIndex >= 0) {
      const insertionIndex = tokens[parameterIndex]!.separatorBefore!;
      return `${definition.slice(0, insertionIndex)}, include-other-group=${memberName}${definition.slice(insertionIndex)}`;
    }

    const trailingSpace = definition.match(/\s*$/)?.[0] ?? '';
    return `${definition.slice(0, definition.length - trailingSpace.length)}, include-other-group=${memberName}${trailingSpace}`;
  }

  const equalsIndex = includeToken.value.indexOf('=');
  const prefix = includeToken.value.slice(0, equalsIndex + 1);
  const rawValue = includeToken.value.slice(equalsIndex + 1).trim();
  const existingQuote =
    rawValue.length >= 2 &&
    (rawValue[0] === '"' || rawValue[0] === "'") &&
    rawValue.at(-1) === rawValue[0]
      ? rawValue[0]
      : undefined;
  const names = includeOtherGroupNames([includeToken]).filter((name) => name !== memberName);
  if (action === 'add') {
    names.push(memberName);
  }

  if (names.length === 0) {
    return `${definition.slice(0, includeToken.separatorBefore!)}${definition.slice(includeToken.end)}`;
  }

  const quote = existingQuote ?? (names.length > 1 ? '"' : '');
  const value = `${quote}${names.join(',')}${quote}`;
  return replacePolicyGroupToken(definition, includeToken, `${prefix}${value}`);
};

const updatePolicyGroupMember = (
  line: string,
  memberName: string,
  action: 'add' | 'remove',
  requestedMode: PolicyGroupTargetMode = 'auto',
) => {
  const equalsIndex = line.indexOf('=');
  if (equalsIndex < 0) {
    return line;
  }

  const right = line.slice(equalsIndex + 1);
  const requirementIndex = findInlineRequirementIndex(right);
  let definition = right.slice(0, requirementIndex);
  const requirement = right.slice(requirementIndex);
  let tokens = splitPolicyGroupTokens(definition);
  const groupType = tokens[0]?.value.toLowerCase();
  const resolvedMode = resolvePolicyGroupTargetMode(tokens, requestedMode);

  if (action === 'remove') {
    definition = removeDirectPolicyGroupMembers(definition, memberName);
    definition = updateIncludedPolicyGroup(definition, memberName, 'remove');
  } else if (resolvedMode === 'merge') {
    definition = removeDirectPolicyGroupMembers(definition, memberName);
    definition = updateIncludedPolicyGroup(definition, memberName, 'add');
  } else {
    if (groupType === 'smart') {
      throw new Error(`Smart policy group cannot reference ${memberName} directly: ${line.slice(0, equalsIndex).trim()}`);
    }
    definition = updateIncludedPolicyGroup(definition, memberName, 'remove');
    tokens = splitPolicyGroupTokens(definition);
    const parameterIndex = policyGroupParameterIndex(tokens);
    const memberEnd = parameterIndex < 0 ? tokens.length : parameterIndex;
    const containsDirectMember = tokens
      .slice(1, memberEnd)
      .some((token) => token.value === memberName);

    if (includeOtherGroupNames(tokens).includes(memberName)) {
      definition = updateIncludedPolicyGroup(definition, memberName, 'remove');
    }
    if (containsDirectMember) {
      return `${line.slice(0, equalsIndex + 1)}${definition}${requirement}`;
    } else if (parameterIndex >= 0) {
      const insertionIndex = tokens[parameterIndex]!.separatorBefore!;
      definition = `${definition.slice(0, insertionIndex)}, ${memberName}${definition.slice(insertionIndex)}`;
    } else {
      const trailingSpace = definition.match(/\s*$/)?.[0] ?? '';
      definition = `${definition.slice(0, definition.length - trailingSpace.length)}, ${memberName}${trailingSpace}`;
    }
  }

  return `${line.slice(0, equalsIndex + 1)}${definition}${requirement}`;
};

const configuredPolicyGroupTargets = (config: CliConfig) => [
  ...new Set(
    (config.policyGroupTargets ?? [])
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name) => name && name !== config.policyGroupName),
  ),
];

const configuredPolicyGroupExclusions = (config: CliConfig) => {
  const targets = new Set(configuredPolicyGroupTargets(config));
  return [
    ...new Set(
      (config.policyGroupExclusions ?? [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim())
        .filter((name) => name && name !== config.policyGroupName && !targets.has(name)),
    ),
  ];
};

const configuredPolicyGroupTargetModes = (config: CliConfig) =>
  Object.fromEntries(
    configuredPolicyGroupTargets(config).map((name) => [name, config.policyGroupTargetModes?.[name] ?? 'auto']),
  ) as Record<string, PolicyGroupTargetMode>;

const updatePolicyGroupTargets = ({
  surgeText,
  policyGroupName,
  targetNames,
  action,
  targetModes = {},
}: {
  surgeText: string;
  policyGroupName: string;
  targetNames: string[];
  action: 'add' | 'remove';
  targetModes?: Record<string, PolicyGroupTargetMode>;
}) => {
  if (targetNames.length === 0) {
    return surgeText;
  }

  const sectionPattern = /(\[Proxy Group\])([\s\S]*?)(?=\n\[|$)/;
  const found = new Set<string>();
  const updated = surgeText.replace(sectionPattern, (_match, sectionTitle: string, sectionBody: string) => {
    const lines = sectionBody.split('\n').map((line) => {
      const equalsIndex = line.indexOf('=');
      if (equalsIndex < 0 || line.trimStart().startsWith('#')) {
        return line;
      }

      const name = line.slice(0, equalsIndex).trim();
      if (!targetNames.includes(name)) {
        return line;
      }

      found.add(name);
      return updatePolicyGroupMember(line, policyGroupName, action, targetModes[name] ?? 'auto');
    });
    return `${sectionTitle}${lines.join('\n')}`;
  });

  if (action === 'add') {
    const missing = targetNames.filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`Policy groups not found in [Proxy Group]: ${missing.join(', ')}`);
    }
  }

  return updated;
};

const policyGroupLines = (surgeText: string) => {
  const section = surgeText.match(/\[Proxy Group\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  const lines = new Map<string, string>();
  for (const line of section?.split('\n') ?? []) {
    const equalsIndex = line.indexOf('=');
    if (equalsIndex < 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    const name = line.slice(0, equalsIndex).trim();
    if (name) {
      lines.set(name, line);
    }
  }
  return lines;
};

const policyGroupChangePreview = ({ source, updated, config }: { source: string; updated: string; config: CliConfig }) => {
  const beforeLines = policyGroupLines(source);
  const afterLines = policyGroupLines(updated);
  const targets = new Set(configuredPolicyGroupTargets(config));
  const names = [...targets, ...configuredPolicyGroupExclusions(config)];
  const targetModes = configuredPolicyGroupTargetModes(config);

  return names.flatMap((name) => {
    const before = beforeLines.get(name);
    const after = afterLines.get(name);
    if (!before || !after || before === after) {
      return [];
    }

    const action = targets.has(name) ? 'add' : 'remove';
    const mode = action === 'add' ? targetModes[name] ?? 'auto' : 'auto';
    const definition = before.slice(before.indexOf('=') + 1);
    const tokens = splitPolicyGroupTokens(definition.slice(0, findInlineRequirementIndex(definition)));
    const resolvedMode = resolvePolicyGroupTargetMode(tokens, mode);
    return [{ name, action, mode, resolvedMode, before, after }];
  });
};

const removeLegacyManagedProxyLines = ({ surgeText, outputDir }: { surgeText: string; outputDir: string }) => {
  const proxySectionPattern = /(\[Proxy\])([\s\S]*?)(?=\n\[|$)/;
  const normalizedOutputDir = outputDir.replace(/\\/g, '/');

  return surgeText.replace(proxySectionPattern, (_match: string, sectionTitle: string, sectionBody: string) => {
    let insideManagedBlock = false;
    const cleanedLines = sectionBody.split('\n').filter((line: string) => {
      if (line.includes('# vless start')) {
        insideManagedBlock = true;
        return true;
      }

      if (line.includes('# vless end')) {
        insideManagedBlock = false;
        return true;
      }

      if (insideManagedBlock) {
        return true;
      }

      const normalizedLine = line.replace(/\\/g, '/');
      const isLegacyManagedProxy =
        normalizedLine.includes('= external') &&
        normalizedLine.includes(normalizedOutputDir) &&
        /sing-box\[\d+\]\.json/.test(normalizedLine);

      return !isLegacyManagedProxy;
    });

    return `${sectionTitle}${cleanedLines.join('\n')}`;
  });
};

const updateProxyBlock = ({
  surgeText,
  proxyLines,
  outputDir,
}: {
  surgeText: string;
  proxyLines: string[];
  outputDir: string;
}) => {
  const proxyStartMarker = '# vless start';
  const proxyEndMarker = '# vless end';
  const cleanedSurgeText = removeLegacyManagedProxyLines({ surgeText, outputDir });

  const blockPattern = new RegExp(
    `(${escapeRegExp(proxyStartMarker)})([\\s\\S]*?)(${escapeRegExp(proxyEndMarker)})`,
    'm',
  );

  if (cleanedSurgeText.includes(proxyStartMarker) && cleanedSurgeText.includes(proxyEndMarker)) {
    return cleanedSurgeText.replace(blockPattern, (_, start, __, end) => `${start}\n${proxyLines.join('\n')}\n${end}`);
  }

  const proxySectionPattern = /(\[Proxy\])([\s\S]*?)(?=\n\[|$)/;
  const proxyBlock = `\n${proxyStartMarker}\n${proxyLines.join('\n')}\n${proxyEndMarker}`;

  if (!proxySectionPattern.test(cleanedSurgeText)) {
    throw new Error('Surge profile is missing the [Proxy] section.');
  }

  return cleanedSurgeText.replace(proxySectionPattern, (match) => {
    const trimmed = match.replace(/\s*$/, '');
    return `${trimmed}${proxyBlock}\n`;
  });
};

const updateMihomoProcessRule = ({
  surgeText,
  enabled,
  processName,
}: {
  surgeText: string;
  enabled: boolean;
  processName?: string;
}) => {
  const startMarker = '# surge-vless-bridge mihomo rule start';
  const endMarker = '# surge-vless-bridge mihomo rule end';
  const blockPattern = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, 'm');
  const withoutManagedRule = surgeText.replace(blockPattern, '\n');
  if (!enabled) return withoutManagedRule;

  const sectionPattern = /(\[Rule\])([\s\S]*?)(?=\n\[|$)/;
  if (!sectionPattern.test(withoutManagedRule)) {
    throw new Error('Surge profile is missing the [Rule] section.');
  }
  const resolvedProcessName = processName?.trim();
  if (!resolvedProcessName || /[,\r\n]/.test(resolvedProcessName)) {
    throw new Error(`Invalid Mihomo process name for Surge rule: ${processName || 'missing'}`);
  }
  return withoutManagedRule.replace(sectionPattern, (_match, title: string, body: string) => {
    const normalizedBody = body.startsWith('\n') ? body : `\n${body}`;
    return `${title}\n${startMarker}\nPROCESS-NAME,${resolvedProcessName},DIRECT\n${endMarker}${normalizedBody}`;
  });
};

export const buildSurgeProfile = async ({
  config,
  proxyLines,
  nodeNames,
}: {
  config: CliConfig;
  proxyLines: string[];
  nodeNames: string[];
}) => {
  const source = await readTextFile(config.surgeConfigPath);
  const withProxyBlock = updateProxyBlock({
    surgeText: source,
    proxyLines,
    outputDir: config.outputDir,
  });

  const withSelectedTargets = updatePolicyGroupTargets({
    surgeText: updatePolicyGroup({
      surgeText: withProxyBlock,
      policyGroupName: config.policyGroupName,
      nodeNames,
    }),
    policyGroupName: config.policyGroupName,
    targetNames: configuredPolicyGroupTargets(config),
    action: 'add',
    targetModes: configuredPolicyGroupTargetModes(config),
  });

  const withTargets = updatePolicyGroupTargets({
    surgeText: withSelectedTargets,
    policyGroupName: config.policyGroupName,
    targetNames: configuredPolicyGroupExclusions(config),
    action: 'remove',
  });

  const updated = updateMihomoProcessRule({
    surgeText: withTargets,
    enabled: config.runtimeMode === 'mihomo',
    processName: basename(config.mihomo.binary),
  });

  return {
    source,
    updated,
    policyGroupChanges: policyGroupChangePreview({ source, updated, config }),
  };
};

export const reloadSurgeIfEnabled = async (config: CliConfig, surgeText: string) => {
  if (!config.autoReload) {
    return;
  }

  const { reloaded, via } = await reloadSurgeProfile(surgeText);
  if (reloaded) console.log(`Surge profile reloaded via ${via}.`);
};

const maybeReloadSurge = async (config: CliConfig, surgeText: string) => {
  if (!config.autoReload) return;

  const stopped = await stopManagedSingBoxProcesses({
    singBoxBinary: config.singBoxBinary,
    outputDir: config.outputDir,
  });
  if (stopped.length > 0) {
    console.log(`Stopped ${stopped.length} managed sing-box process${stopped.length === 1 ? '' : 'es'} before reload.`);
  }

  await reloadSurgeIfEnabled(config, surgeText);
};

const generateConfigsFromOutbounds = async ({
  outbounds,
  config,
  stagingDir,
}: {
  outbounds: SingBoxVlessOutbound[];
  config: CliConfig;
  stagingDir: string;
}) => {
  const seenNodeNames = new Map<string, number>();

  const generated = await Promise.all(
    outbounds.map(async (outbound, index) => {
      const port = config.portStart + index;
      const nodeName = ensureUniquePolicyName(sanitizePolicyName(outbound.tag, index), seenNodeNames);
      const fileName = `sing-box[${port}].json`;
      const stagedConfigPath = join(stagingDir, fileName);
      const serverConfig = parseTemplate({
        node: {
          ...outbound,
          tag: nodeName,
          ...(config.tcpFastOpen ? { tcp_fast_open: true } : {}),
          ...(config.connectTimeoutEnabled ? { connect_timeout: `${config.connectTimeoutSeconds}s` } : {}),
        },
        port,
      });

      await writeTextFile(stagedConfigPath, `${JSON.stringify(serverConfig, null, 2)}\n`);

      return {
        nodeName,
        port,
        configPath: join(config.outputDir, fileName),
        stagedConfigPath,
        server: outbound.server,
      } satisfies StagedGeneratedNode;
    }),
  );

  await mapWithConcurrency(generated, SING_BOX_CHECK_CONCURRENCY, (entry) =>
    validateSingBoxConfig(config.singBoxBinary, entry.stagedConfigPath),
  );

  const proxyLines = await Promise.all(
    generated.map((entry) =>
      buildExternalProxyLine({
        ...entry,
        singBoxBinary: config.singBoxBinary,
        addressResolver: config.addressResolver,
        udpRelay: config.udpRelay,
        udpTestEnabled: config.udpTestEnabled,
        udpTestTarget: config.udpTestTarget,
      }),
    ),
  );

  return {
    generated,
    proxyLines,
    nodeNames: generated.map((entry) => entry.nodeName),
  };
};

const reportDryRun = async ({
  config,
  generated,
}: {
  config: CliConfig;
  generated: { generated: StagedGeneratedNode[]; proxyLines: string[]; nodeNames: string[] };
}) => {
  const { source, updated, policyGroupChanges } = await buildSurgeProfile({
    config,
    proxyLines: generated.proxyLines,
    nodeNames: generated.nodeNames,
  });

  console.log(`Would write ${generated.nodeNames.length} nodes:`);
  for (const entry of generated.generated) {
    console.log(`  ${String(entry.port).padEnd(6)} ${entry.nodeName}`);
  }

  const existing = new Set(
    (await readdir(config.outputDir).catch(() => [])).filter((entry) => MANAGED_CONFIG_PATTERN.test(entry)),
  );
  const expected = new Set(generated.generated.map((entry) => basename(entry.configPath)));
  const added = [...expected].filter((entry) => !existing.has(entry)).length;
  const removed = [...existing].filter((entry) => !expected.has(entry)).length;

  console.log(`Node configs: +${added} / -${removed} in ${config.outputDir}`);
  console.log(
    updated === source
      ? `Surge profile unchanged: ${config.surgeConfigPath}`
      : `Surge profile would change: ${config.surgeConfigPath}`,
  );
  console.log(`Policy group: ${config.policyGroupName} = url-test, ${generated.nodeNames.join(', ')}`);
  const policyGroupTargets = configuredPolicyGroupTargets(config);
  const policyGroupExclusions = configuredPolicyGroupExclusions(config);
  const policyGroupTargetModes = configuredPolicyGroupTargetModes(config);
  if (policyGroupTargets.length > 0) {
    console.log(`Add ${config.policyGroupName} to policy groups: ${policyGroupTargets.join(', ')}`);
  }
  if (policyGroupExclusions.length > 0) {
    console.log(`Remove ${config.policyGroupName} from policy groups: ${policyGroupExclusions.join(', ')}`);
  }

  return {
    count: generated.nodeNames.length,
    added,
    removed,
    profileChanged: updated !== source,
    policyGroupName: config.policyGroupName,
    policyGroupTargets,
    policyGroupExclusions,
    policyGroupTargetModes,
    policyGroupChanges,
    udpRelay: config.udpRelay,
    udpTestEnabled: config.udpTestEnabled,
    udpTestTarget: config.udpTestTarget,
    tcpFastOpen: config.tcpFastOpen,
    connectTimeoutEnabled: config.connectTimeoutEnabled,
    connectTimeoutSeconds: config.connectTimeoutSeconds,
    surgeConfigPath: config.surgeConfigPath,
    outputDir: config.outputDir,
    nodes: generated.generated.map((entry) => ({
      name: entry.nodeName,
      port: entry.port,
      server: entry.server,
    })),
  };
};

export const cleanManagedArtifacts = async (config: CliConfig) => {
  if (!config.surgeConfigPath || !(await pathExists(config.surgeConfigPath))) {
    throw new Error(`Surge profile not found: ${config.surgeConfigPath || 'missing'}`);
  }

  const backupPath = await backupSurgeProfile(config);
  const source = await readTextFile(config.surgeConfigPath);

  // Drops the managed block and the generated policy group, leaving the rest of the profile as is.
  const withoutBlock = source.replace(
    new RegExp(`\\n?${escapeRegExp(config.proxyStartMarker)}[\\s\\S]*?${escapeRegExp(config.proxyEndMarker)}\\n?`, 'm'),
    '\n',
  );
  const withoutGroup = withoutBlock.replace(
    new RegExp(`^${escapeRegExp(config.policyGroupName)}\\s*=\\s*url-test,.*$\\n?`, 'm'),
    '',
  );
  const withoutTargets = updatePolicyGroupTargets({
    surgeText: withoutGroup,
    policyGroupName: config.policyGroupName,
    targetNames: [...new Set([...configuredPolicyGroupTargets(config), ...configuredPolicyGroupExclusions(config)])],
    action: 'remove',
  });

  const withoutMihomoRule = updateMihomoProcessRule({ surgeText: withoutTargets, enabled: false });
  await writeTextFile(config.surgeConfigPath, withoutMihomoRule);

  const entries = (await readdir(config.outputDir).catch(() => [])).filter(
    (entry) => MANAGED_CONFIG_PATTERN.test(entry) || entry === MANIFEST_FILE_NAME,
  );
  await Promise.all(entries.map((entry) => rm(join(config.outputDir, entry), { force: true })));

  await maybeReloadSurge(config, withoutMihomoRule);

  return {
    backupPath,
    removedConfigs: entries.filter((entry) => entry !== MANIFEST_FILE_NAME).length,
  };
};

export const syncSubscriptionToSurge = async (config: CliConfig, { dryRun = false }: { dryRun?: boolean } = {}) => {
  ensureRequiredConfig(config);
  await ensureRuntimePaths(config);
  await ensureWritableDirs(config);

  const vlessNodes = await collectVlessNodes(config);

  if (config.subscriptionOutputPath && !dryRun) {
    await writeTextFile(config.subscriptionOutputPath, `${vlessNodes.join('\n')}\n`);
  }

  const outbounds = vlessNodes.map((node, index) => parseVlessNode(node, index));

  // Everything is generated and validated in a staging directory first, so a failure part-way through
  // leaves both the Surge profile and the previous node configs untouched.
  const stagingDir = join(config.outputDir, `.staging-${randomUUID()}`);
  await mkdir(stagingDir, { recursive: true });

  try {
    const generated = await generateConfigsFromOutbounds({ outbounds, config, stagingDir });

    // The staging directory already holds validated configs, so a dry run can report exactly what a
    // real sync would produce without having written anything outside it.
    if (dryRun) {
      const preview = await reportDryRun({ config, generated });
      return { dryRun: true as const, backupPath: undefined, count: generated.nodeNames.length, preview };
    }

    const surgeProfile = await buildSurgeProfile({
      config,
      proxyLines: generated.proxyLines,
      nodeNames: generated.nodeNames,
    });

    const backupPath = await backupSurgeProfile(config);

    await promoteGeneratedConfigs(config, generated.generated);
    await writeTextFile(config.surgeConfigPath, surgeProfile.updated);

    const removedCount = await removeStaleConfigs(config.outputDir, generated.generated);
    if (removedCount > 0) {
      console.log(`Removed ${removedCount} node config${removedCount === 1 ? '' : 's'} no longer in the subscription.`);
    }

    await maybeReloadSurge(config, surgeProfile.updated);

    return {
      dryRun: false as const,
      backupPath,
      count: generated.nodeNames.length,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
};

export const rebuildSurgeFromLocalConfigs = async (config: CliConfig) => {
  if (!config.surgeConfigPath) {
    throw new Error(
      'Missing surgeConfigPath. Run `surge-vless-bridge init` and fill the config, or pass --surge-config.',
    );
  }

  const entries = await readManagedConfigEntries(config.outputDir);
  if (entries.length === 0) {
    throw new Error(`No sing-box configs found in ${config.outputDir}`);
  }

  const generated = await Promise.all(
    entries.map(async (entry) => {
      const match = entry.match(/sing-box\[(\d+)\]\.json$/);
      if (!match) {
        return null;
      }

      const port = Number(match[1]);
      const configPath = join(config.outputDir, entry);
      const json = await readJsonFile<SingBoxConfig>(configPath);
      const outbound = json.outbounds?.[0];
      const rawTag = outbound?.tag;
      const nodeName = rawTag
        ?.replace(/[,\n\r=]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!nodeName || !outbound?.server) {
        console.error(`Skipping unusable config: ${configPath}`);
        return null;
      }

      return {
        nodeName,
        port,
        configPath,
        server: outbound.server,
      } satisfies GeneratedNode;
    }),
  );

  const validEntries = generated.filter((entry): entry is GeneratedNode => Boolean(entry));
  if (validEntries.length === 0) {
    throw new Error(`No usable sing-box configs found in ${config.outputDir}`);
  }

  const proxyLines = await Promise.all(
    validEntries.map((entry) =>
      buildExternalProxyLine({
        ...entry,
        singBoxBinary: config.singBoxBinary,
        addressResolver: config.addressResolver,
        udpRelay: config.udpRelay,
        udpTestEnabled: config.udpTestEnabled,
        udpTestTarget: config.udpTestTarget,
      }),
    ),
  );

  const surgeProfile = await buildSurgeProfile({
    config,
    proxyLines,
    nodeNames: validEntries.map((entry) => entry.nodeName),
  });
  const backupPath = await backupSurgeProfile(config);
  await writeTextFile(config.surgeConfigPath, surgeProfile.updated);

  await maybeReloadSurge(config, surgeProfile.updated);

  return {
    backupPath,
    count: validEntries.length,
  };
};

export const restoreSurgeProfileBackup = async ({ config, backupPath }: { config: CliConfig; backupPath?: string }) => {
  const resolvedBackupPath = backupPath ? resolve(backupPath) : undefined;
  const targetPath = resolvedBackupPath ?? (await findLatestBackup(config.backupDir));

  if (!targetPath) {
    throw new Error(`No backup files found in ${config.backupDir}`);
  }

  await writeBinaryFile(config.surgeConfigPath, await readJsonCompatibleBinary(targetPath));
  await maybeReloadSurge(config, await readTextFile(config.surgeConfigPath));
  return targetPath;
};

const readJsonCompatibleBinary = (path: string) => readFile(path);

// Newest first; the timestamp in the filename sorts lexicographically.
const listBackups = async (backupDir: string) => {
  try {
    const entries = await readdir(backupDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
      .map((entry) => join(backupDir, entry.name))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
};

const findLatestBackup = async (backupDir: string) => (await listBackups(backupDir))[0];

export type DoctorLevel = 'ok' | 'warn' | 'fail';

export type DoctorCheck = {
  label: string;
  level: DoctorLevel;
  detail: string;
};

// Ports are probed by binding them: Surge starts one sing-box per node on portStart+N, and a port
// already taken by something else makes that node fail with no obvious cause.
const findPortConflicts = async (portStart: number, count: number) => {
  const conflicts: number[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    const port = portStart + offset;
    const inUse = await new Promise<boolean>((resolvePromise) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => resolvePromise(error.code === 'EADDRINUSE'));
      server.once('listening', () => server.close(() => resolvePromise(false)));
      server.listen(port, '127.0.0.1');
    });

    if (inUse) {
      conflicts.push(port);
    }
  }

  return conflicts;
};

export const runCommonDoctorChecks = async (config: CliConfig) => {
  const subscriptionUrls = getSubscriptionUrls(config);
  const vlessNodes = getConfiguredVlessNodes(config);
  const checks: DoctorCheck[] = [];

  checks.push({
    label: 'nodeSources',
    level: subscriptionUrls.length + vlessNodes.length > 0 ? 'ok' : 'fail',
    detail: `${subscriptionUrls.length} subscription URLs, ${vlessNodes.length} direct VLESS nodes`,
  });

  const surgeConfigExists = Boolean(config.surgeConfigPath) && (await pathExists(config.surgeConfigPath));
  checks.push({
    label: 'surgeConfigPath',
    level: surgeConfigExists ? 'ok' : 'fail',
    detail: config.surgeConfigPath || 'missing',
  });

  const backupDirExists = await pathExists(config.backupDir);
  checks.push({
    label: 'backupDir',
    level: backupDirExists ? 'ok' : 'warn',
    detail: backupDirExists ? config.backupDir : `${config.backupDir} (not created yet; run \`sync\`)`,
  });

  if (surgeConfigExists) {
    const text = await readTextFile(config.surgeConfigPath);
    checks.push({
      label: 'proxy-group-section',
      level: text.includes('[Proxy Group]') ? 'ok' : 'fail',
      detail: '[Proxy Group]',
    });
    checks.push({
      label: 'proxy-section',
      level: text.includes('[Proxy]') ? 'ok' : 'fail',
      detail: '[Proxy]',
    });
    checks.push({
      label: 'rule-section',
      level: text.includes('[Rule]') ? 'ok' : 'fail',
      detail: '[Rule]',
    });

    const httpApi = parseHttpApiSettings(text);
    checks.push({
      label: 'surge-http-api',
      level: !config.autoReload || httpApi ? 'ok' : 'warn',
      detail: !config.autoReload
        ? 'disabled by config; Surge profile reload is left to the user'
        : httpApi
          ? `${httpApi.origin} (profile reloads automatically)`
          : 'not enabled; add `http-api = <key>@127.0.0.1:6171` to [General] to reload automatically',
    });
  }

  return checks;
};

export const reportDoctorChecks = (checks: DoctorCheck[]) => {
  for (const check of checks) {
    console.log(`${check.level === 'ok' ? 'OK' : check.level === 'warn' ? 'WARN' : 'FAIL'} ${check.label}: ${check.detail}`);
  }

  const failures = checks.filter((check) => check.level === 'fail').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;
  if (failures > 0) {
    console.error(`\n${failures} problem${failures === 1 ? '' : 's'} found.`);
  }

  return { checks, failures, warnings };
};

export const runExternalDoctor = async (config: CliConfig) => {
  const checks = await runCommonDoctorChecks(config);
  const binaryIndex = Math.min(2, checks.length);
  checks.splice(binaryIndex, 0, {
    label: 'singBoxBinary',
    level: Boolean(config.singBoxBinary) && (await pathExists(config.singBoxBinary)) ? 'ok' : 'fail',
    detail: config.singBoxBinary || 'missing',
  });

  const outputDirExists = await pathExists(config.outputDir);
  checks.splice(binaryIndex + 1, 0, {
    label: 'outputDir',
    level: outputDirExists ? 'ok' : 'warn',
    detail: outputDirExists ? config.outputDir : `${config.outputDir} (not created yet; run \`sync\`)`,
  });

  const managedEntries = outputDirExists
    ? await readManagedConfigEntries(config.outputDir).catch(() => [])
    : [];
  if (managedEntries.length > 0) {
    const conflicts = await findPortConflicts(config.portStart, managedEntries.length);
    // Surge keeps the managed nodes listening, so their own ports read as busy while it is running.
    checks.push({
      label: 'ports',
      level: 'ok',
      detail: `${config.portStart}-${config.portStart + managedEntries.length - 1}${
        conflicts.length > 0 ? `, ${conflicts.length} in use (expected while Surge is running)` : ''
      }`,
    });
  }

  return reportDoctorChecks(checks);
};

export const runDoctor = runExternalDoctor;
