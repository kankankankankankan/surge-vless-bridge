import { constants } from 'node:fs';
import { access, chmod, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import type {
  AddressResolverConfig,
  CliConfig,
  CliConfigInput,
  PolicyGroupTargetMode,
  RuntimeMode,
} from './types/cli-config';
import { pathExists, readJsonFile, writeTextFile } from './utils/fs';
import { DEFAULT_SUBSCRIPTION_HEADERS as DEFAULT_HEADERS, subscriptionHeaders } from './utils/subscription-headers';
import { normalizeSubscriptionOptions, subscriptionOptionsForUrl } from './utils/subscription-options';

export const CONFIG_FILE_NAME = '.surge-vless-bridge.json';
export const HOME_CONFIG_FILE_PATH = join('.config', 'surge-vless-bridge', 'config.json');

const DEFAULT_ADDRESS_RESOLVER: AddressResolverConfig = {
  strategy: 'doh',
  dohEndpoint: 'https://1.1.1.1/dns-query',
  dnsServers: ['1.1.1.1', '8.8.8.8'],
  filterSurgeFakeIp: true,
};

const isExecutable = async (path: string) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const detectSingBoxBinary = async ({
  home = process.env.HOME ?? process.env.USERPROFILE ?? '.',
  searchPath = process.env.PATH ?? '',
}: {
  home?: string;
  searchPath?: string;
} = {}) => {
  const result = spawnSync('/usr/bin/which', ['sing-box'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: searchPath },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status === 0) {
    const binaryPath = result.stdout.trim();
    if (binaryPath && (await isExecutable(binaryPath))) {
      return { path: binaryPath, exists: true };
    }
  }

  const managedPath = join(home, '.config', 'surge-vless-bridge', 'bin', 'sing-box');
  const homebrewPaths =
    process.arch === 'x64'
      ? ['/usr/local/bin/sing-box', '/opt/homebrew/bin/sing-box']
      : ['/opt/homebrew/bin/sing-box', '/usr/local/bin/sing-box'];
  const candidates = [managedPath, join(home, '.local', 'bin', 'sing-box'), ...homebrewPaths];

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return { path: candidate, exists: true };
    }
  }

  return {
    path: managedPath,
    exists: false,
  };
};

// Most recently modified first: that is the profile the user is most likely working in, and it is the
// order `init` offers the candidates in.
export const listSurgeProfiles = async () => {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }

  const profilesDir = join(home, 'Library/Application Support/Surge/Profiles');

  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
      .map((entry) => join(profilesDir, entry.name));

    const sortedByMtime = await Promise.all(
      candidates.map(async (candidate) => ({
        path: candidate,
        mtimeMs: (await stat(candidate)).mtimeMs,
      })),
    );

    sortedByMtime.sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }

      return right.path.localeCompare(left.path);
    });

    return sortedByMtime;
  } catch {
    return [];
  }
};

const detectSurgeConfigPath = async () => (await listSurgeProfiles())[0]?.path ?? '';

export const getDefaultConfig = async (_cwd: string): Promise<CliConfig> => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const stateDir = join(home, '.config', 'surge-vless-bridge');
  const singBoxBinary = await detectSingBoxBinary();

  return {
    runtimeMode: 'external',
    runtimeModeConfirmed: false,
    mihomo: {
      binary: join(stateDir, 'bin', 'mihomo'),
      dataDir: join(stateDir, 'mihomo'),
      controllerHost: '127.0.0.1',
      controllerPort: 19090,
      controllerSecret: randomBytes(24).toString('hex'),
      autoStart: true,
      logLevel: 'info',
    },
    subscriptionUrl: '',
    subscriptionUrls: [],
    subscriptionNames: [],
    subscriptionOptions: [],
    vlessNodes: [],
    surgeConfigPath: await detectSurgeConfigPath(),
    singBoxBinary: singBoxBinary.path,
    outputDir: join(stateDir, 'nodes'),
    backupDir: join(stateDir, 'backups'),
    policyGroupName: 'VLESS',
    policyGroupTargets: [],
    policyGroupExclusions: [],
    policyGroupTargetModes: {},
    proxyStartMarker: '# vless start',
    proxyEndMarker: '# vless end',
    portStart: 2081,
    backupKeep: 20,
    autoReload: true,
    udpRelay: false,
    udpTestEnabled: false,
    udpTestTarget: 'apple.com@8.8.8.8',
    tcpFastOpen: false,
    connectTimeoutEnabled: false,
    connectTimeoutSeconds: 10,
    subscriptionOutputPath: join(stateDir, 'vless_nodes.txt'),
    requestHeaders: { ...DEFAULT_HEADERS },
    addressResolver: { ...DEFAULT_ADDRESS_RESOLVER },
  };
};

const resolveGitRoot = (cwd: string): string | undefined => {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status === 0) {
    return result.stdout.trim() || undefined;
  }

  return undefined;
};

export const resolveConfigPath = (cwd: string, configPath?: string) =>
  configPath ? resolve(cwd, configPath) : resolveDefaultConfigPath(cwd);

const resolveDefaultConfigPath = (cwd: string) => {
  const gitRoot = resolveGitRoot(cwd);
  if (gitRoot) {
    return join(gitRoot, CONFIG_FILE_NAME);
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    return join(home, HOME_CONFIG_FILE_PATH);
  }

  return resolve(cwd, CONFIG_FILE_NAME);
};

const writePrivateJsonAtomically = async (path: string, value: unknown) => {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await chmod(path, 0o600);
};

export const persistMihomoControllerSecret = async ({
  config,
  configPath,
}: {
  config: CliConfig;
  configPath: string;
}) => {
  const raw = (await pathExists(configPath)) ? await readJsonFile<CliConfigInput>(configPath) : {};
  const storedSecret = raw.mihomo?.controllerSecret?.trim();
  const controllerSecret = storedSecret || config.mihomo.controllerSecret || randomBytes(24).toString('hex');
  if (!storedSecret) {
    await writePrivateJsonAtomically(configPath, {
      ...raw,
      mihomo: {
        ...(raw.mihomo ?? {}),
        controllerSecret,
      },
    });
  }
  return {
    ...config,
    mihomo: {
      ...config.mihomo,
      controllerSecret,
    },
  };
};

const mergeConfig = (base: CliConfig, input?: CliConfigInput): CliConfig => {
  if (!input) {
    return base;
  }

  const definedEntries = Object.entries(input).filter(([, value]) => value !== undefined);
  const sanitizedInput = Object.fromEntries(definedEntries) as CliConfigInput;
  const hasSubscriptionUrls = Array.isArray(sanitizedInput.subscriptionUrls);
  const inputSubscriptionNames = Array.isArray(sanitizedInput.subscriptionNames)
    ? sanitizedInput.subscriptionNames
    : [];
  const normalizedSubscriptions = hasSubscriptionUrls
    ? sanitizedInput.subscriptionUrls
        ?.map((url, index) => ({
          url: typeof url === 'string' ? url.trim() : '',
          name: typeof inputSubscriptionNames[index] === 'string' ? inputSubscriptionNames[index]!.trim() : '',
          options: normalizeSubscriptionOptions(sanitizedInput.subscriptionOptions?.[index] ?? subscriptionOptionsForUrl(base, typeof url === 'string' ? url : '')),
        }))
        .filter((entry) => entry.url !== '')
    : undefined;
  const hasVlessNodes = Array.isArray(sanitizedInput.vlessNodes);
  const normalizedVlessNodes = hasVlessNodes
    ? sanitizedInput.vlessNodes?.filter((node) => typeof node === 'string' && node.trim() !== '')
    : undefined;
  const policyGroupName =
    typeof sanitizedInput.policyGroupName === 'string' && sanitizedInput.policyGroupName.trim()
      ? sanitizedInput.policyGroupName.trim()
      : base.policyGroupName;
  const policyGroupTargets = [
    ...new Set(
      (Array.isArray(sanitizedInput.policyGroupTargets) ? sanitizedInput.policyGroupTargets : base.policyGroupTargets)
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim())
        .filter((name) => name && name !== policyGroupName),
    ),
  ];
  const policyGroupExclusions = [
    ...new Set(
      (
        Array.isArray(sanitizedInput.policyGroupExclusions)
          ? sanitizedInput.policyGroupExclusions
          : base.policyGroupExclusions
      )
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim())
        .filter((name) => name && name !== policyGroupName && !policyGroupTargets.includes(name)),
    ),
  ];
  const rawPolicyGroupTargetModes =
    sanitizedInput.policyGroupTargetModes &&
    typeof sanitizedInput.policyGroupTargetModes === 'object' &&
    !Array.isArray(sanitizedInput.policyGroupTargetModes)
      ? sanitizedInput.policyGroupTargetModes
      : base.policyGroupTargetModes;
  const validPolicyGroupTargetModes = new Set<PolicyGroupTargetMode>(['auto', 'merge', 'reference']);
  const policyGroupTargetModes = Object.fromEntries(
    policyGroupTargets.map((name) => {
      const mode = rawPolicyGroupTargetModes[name];
      return [name, mode && validPolicyGroupTargetModes.has(mode) ? mode : 'auto'];
    }),
  ) as Record<string, PolicyGroupTargetMode>;
  const addressResolverInput =
    typeof sanitizedInput.addressResolver === 'string'
      ? { strategy: sanitizedInput.addressResolver }
      : sanitizedInput.addressResolver;
  const connectTimeoutSeconds = Number(sanitizedInput.connectTimeoutSeconds);
  const udpTestTarget =
    typeof sanitizedInput.udpTestTarget === 'string' && sanitizedInput.udpTestTarget.trim()
      ? sanitizedInput.udpTestTarget.trim()
      : base.udpTestTarget;
  const runtimeMode: RuntimeMode =
    sanitizedInput.runtimeMode === 'mihomo' || sanitizedInput.runtimeMode === 'external'
      ? sanitizedInput.runtimeMode
      : base.runtimeMode;
  const runtimeModeConfirmed =
    sanitizedInput.runtimeModeConfirmed === undefined
      ? base.runtimeModeConfirmed
      : Boolean(sanitizedInput.runtimeModeConfirmed);
  const mihomoInput = sanitizedInput.mihomo;
  const controllerPort = Number(mihomoInput?.controllerPort);
  const validLogLevels = new Set(['silent', 'error', 'warning', 'info', 'debug']);

  return {
    ...base,
    ...sanitizedInput,
    runtimeMode,
    runtimeModeConfirmed,
    mihomo: {
      ...base.mihomo,
      ...(mihomoInput ?? {}),
      controllerHost: '127.0.0.1',
      controllerPort:
        Number.isInteger(controllerPort) && controllerPort >= 1024 && controllerPort <= 65535
          ? controllerPort
          : base.mihomo.controllerPort,
      controllerSecret:
        typeof mihomoInput?.controllerSecret === 'string' && mihomoInput.controllerSecret.trim()
          ? mihomoInput.controllerSecret.trim()
          : base.mihomo.controllerSecret,
      logLevel:
        typeof mihomoInput?.logLevel === 'string' && validLogLevels.has(mihomoInput.logLevel)
          ? (mihomoInput.logLevel as CliConfig['mihomo']['logLevel'])
          : base.mihomo.logLevel,
      autoStart: mihomoInput?.autoStart === undefined ? base.mihomo.autoStart : Boolean(mihomoInput.autoStart),
    },
    subscriptionUrls: normalizedSubscriptions?.map((entry) => entry.url) ?? base.subscriptionUrls,
    subscriptionNames:
      normalizedSubscriptions?.map((entry) => entry.name) ??
      (base.subscriptionUrls ?? []).map((_, index) => base.subscriptionNames?.[index]?.trim() ?? ''),
    subscriptionOptions: normalizedSubscriptions?.map(entry => entry.options) ??
      (base.subscriptionUrls ?? []).map((_, index) => normalizeSubscriptionOptions(sanitizedInput.subscriptionOptions?.[index] ?? base.subscriptionOptions?.[index])),
    vlessNodes: normalizedVlessNodes ?? base.vlessNodes,
    policyGroupName,
    policyGroupTargets,
    policyGroupExclusions,
    policyGroupTargetModes,
    udpTestTarget,
    connectTimeoutSeconds:
      Number.isFinite(connectTimeoutSeconds) && connectTimeoutSeconds > 0
        ? connectTimeoutSeconds
        : base.connectTimeoutSeconds,
    requestHeaders: subscriptionHeaders({
      ...base.requestHeaders,
      ...(sanitizedInput.requestHeaders ?? {}),
    }),
    addressResolver: {
      ...base.addressResolver,
      ...(addressResolverInput ?? {}),
    },
  };
};

export const loadCliConfig = async ({
  cwd,
  configPath,
  overrides,
}: {
  cwd: string;
  configPath?: string;
  overrides?: CliConfigInput;
}) => {
  const defaults = await getDefaultConfig(cwd);
  const resolvedConfigPath = resolveConfigPath(cwd, configPath);

  if (!(await pathExists(resolvedConfigPath))) {
    return {
      config: mergeConfig(defaults, overrides),
      configPath: resolvedConfigPath,
      exists: false,
    };
  }

  const parsed = await readJsonFile<CliConfigInput>(resolvedConfigPath);
  let config = mergeConfig(mergeConfig(defaults, parsed), overrides);
  if (config.runtimeMode === 'mihomo' && !parsed.mihomo?.controllerSecret?.trim()) {
    config = await persistMihomoControllerSecret({ config, configPath: resolvedConfigPath });
  }
  return {
    config,
    configPath: resolvedConfigPath,
    exists: true,
  };
};

export const writeExampleConfig = async ({
  cwd,
  configPath,
  force,
  values,
}: {
  cwd: string;
  configPath?: string;
  force?: boolean;
  // Answers collected by `init` when it can prompt. Anything absent falls back to the template
  // placeholder, so a skipped question still leaves an editable file behind.
  values?: { subscriptionUrls?: string[]; vlessNodes?: string[]; surgeConfigPath?: string };
}) => {
  const defaults = await getDefaultConfig(cwd);
  const singBoxBinary = await detectSingBoxBinary();
  const resolvedConfigPath = resolveConfigPath(cwd, configPath);

  if (!force && (await pathExists(resolvedConfigPath))) {
    throw new Error(`Config file already exists: ${resolvedConfigPath}`);
  }

  // Values reach this file from a prompt, a flag, or a script, and only the prompt trims its own
  // input. Padding survives `sync` either way — every consumer trims — but it should not be baked
  // into a file the user opens and edits later.
  const clean = (values?: string[]) => values?.map((value) => value.trim()).filter(Boolean) ?? [];
  const subscriptionUrls = clean(values?.subscriptionUrls);

  const example: CliConfigInput = {
    runtimeMode: defaults.runtimeMode,
    runtimeModeConfirmed: defaults.runtimeModeConfirmed,
    mihomo: { ...defaults.mihomo, controllerSecret: '' },
    subscriptionUrls: subscriptionUrls.length ? subscriptionUrls : [''],
    vlessNodes: clean(values?.vlessNodes),
    surgeConfigPath: values?.surgeConfigPath?.trim() || defaults.surgeConfigPath,
    policyGroupName: defaults.policyGroupName,
    policyGroupTargets: defaults.policyGroupTargets,
    policyGroupExclusions: defaults.policyGroupExclusions,
    policyGroupTargetModes: defaults.policyGroupTargetModes,
    portStart: defaults.portStart,
    udpRelay: defaults.udpRelay,
    udpTestEnabled: defaults.udpTestEnabled,
    udpTestTarget: defaults.udpTestTarget,
    tcpFastOpen: defaults.tcpFastOpen,
    connectTimeoutEnabled: defaults.connectTimeoutEnabled,
    connectTimeoutSeconds: defaults.connectTimeoutSeconds,
    addressResolver: { ...defaults.addressResolver },
  };

  await writeTextFile(resolvedConfigPath, `${JSON.stringify(example, null, 2)}\n`);
  return {
    configPath: resolvedConfigPath,
    warnings: singBoxBinary.exists
      ? []
      : [
          `sing-box not found. Install it first(brew install sing-box), or update singBoxBinary manually: ${singBoxBinary.path}`,
        ],
  };
};
