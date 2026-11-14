const assert = require('node:assert/strict');
const { chmod, mkdir, mkdtemp, readFile, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectSingBoxBinary, loadCliConfig } = require('../dist/configuration.js');

test('detects sing-box installed in the user local bin directory without a GUI PATH', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'svb-sing-box-home-'));
  const binaryPath = path.join(home, '.local', 'bin', 'sing-box');
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(binaryPath, 0o755);

  const detected = await detectSingBoxBinary({ home, searchPath: '/usr/bin:/bin' });

  assert.deepEqual(detected, { path: binaryPath, exists: true });
});

test('uses the managed install location when sing-box is missing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'svb-empty-home-'));

  const detected = await detectSingBoxBinary({ home, searchPath: '/usr/bin:/bin' });

  assert.deepEqual(detected, {
    path: path.join(home, '.config', 'surge-vless-bridge', 'bin', 'sing-box'),
    exists: false,
  });
});

test('loads legacy configs with no policy group membership settings and normalizes configured groups', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-policy-targets-'));
  const legacyPath = path.join(root, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({ policyGroupName: 'VLESS' }), 'utf8');

  const legacy = await loadCliConfig({ cwd: root, configPath: legacyPath });
  assert.deepEqual(legacy.config.policyGroupTargets, []);
  assert.deepEqual(legacy.config.subscriptionNames, []);
  assert.deepEqual(legacy.config.policyGroupExclusions, []);
  assert.deepEqual(legacy.config.policyGroupTargetModes, {});
  assert.equal(legacy.config.udpRelay, false);
  assert.equal(legacy.config.udpTestEnabled, false);
  assert.equal(legacy.config.udpTestTarget, 'apple.com@8.8.8.8');
  assert.equal(legacy.config.tcpFastOpen, false);
  assert.equal(legacy.config.connectTimeoutEnabled, false);
  assert.equal(legacy.config.connectTimeoutSeconds, 10);
  assert.equal(legacy.config.runtimeModeConfirmed, false);
  assert.equal(legacy.config.mihomo.dnsMode, 'inherit');
  assert.deepEqual(legacy.config.mihomo.dnsServers, ['1.1.1.1', '8.8.8.8']);
  assert.equal(legacy.config.mihomo.dohEndpoint, 'https://1.1.1.1/dns-query');
  assert.equal(legacy.config.mihomo.dnsIpv6, true);
  assert.equal(legacy.config.mihomo.tcpConcurrent, true);

  const normalized = await loadCliConfig({
    cwd: root,
    configPath: legacyPath,
    overrides: {
      policyGroupTargets: [' Proxy ', 'Proxy', '', 'VLESS', '自动选择'],
      policyGroupExclusions: [' 香港线路 ', '香港线路', 'Proxy', 'VLESS'],
      policyGroupTargetModes: { Proxy: 'merge', 自动选择: 'invalid', 香港线路: 'reference' },
      udpRelay: true,
      udpTestEnabled: true,
      udpTestTarget: ' example.com@1.1.1.1 ',
      tcpFastOpen: true,
      connectTimeoutEnabled: true,
      connectTimeoutSeconds: 15,
      addressResolver: {
        strategy: 'dot',
        dohEndpoint: 'tls://dns.alidns.com:853',
      },
      subscriptionUrls: [' https://example.com/a ', '', 'https://example.com/b'],
      subscriptionNames: [' Primary ', 'ignored', ''],
      mihomo: {
        dnsMode: 'dns',
        dnsServers: [' 192.0.2.53 ', '192.0.2.53', ' 1.1.1.1 '],
        dohEndpoint: ' https://dns.example/dns-query ',
        dnsIpv6: false,
        tcpConcurrent: false,
      },
    },
  });
  assert.deepEqual(normalized.config.policyGroupTargets, ['Proxy', '自动选择']);
  assert.deepEqual(normalized.config.policyGroupExclusions, ['香港线路']);
  assert.deepEqual(normalized.config.policyGroupTargetModes, { Proxy: 'merge', 自动选择: 'auto' });
  assert.equal(normalized.config.udpRelay, true);
  assert.equal(normalized.config.udpTestEnabled, true);
  assert.equal(normalized.config.udpTestTarget, 'example.com@1.1.1.1');
  assert.equal(normalized.config.tcpFastOpen, true);
  assert.equal(normalized.config.connectTimeoutEnabled, true);
  assert.equal(normalized.config.connectTimeoutSeconds, 15);
  assert.equal(normalized.config.addressResolver.strategy, 'dot');
  assert.equal(normalized.config.addressResolver.dohEndpoint, 'tls://dns.alidns.com:853');
  assert.equal(normalized.config.runtimeModeConfirmed, false);
  assert.deepEqual(normalized.config.subscriptionUrls, ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(normalized.config.subscriptionNames, ['Primary', '']);
  assert.equal(normalized.config.mihomo.dnsMode, 'dns');
  assert.deepEqual(normalized.config.mihomo.dnsServers, ['192.0.2.53', '1.1.1.1']);
  assert.equal(normalized.config.mihomo.dohEndpoint, 'https://dns.example/dns-query');
  assert.equal(normalized.config.mihomo.dnsIpv6, false);
  assert.equal(normalized.config.mihomo.tcpConcurrent, false);
});

test('falls back to safe Mihomo DNS defaults for invalid legacy values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-mihomo-dns-defaults-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ mihomo: { dnsMode: 'invalid', dnsServers: [null, '  '] } }), 'utf8');

  const loaded = await loadCliConfig({ cwd: root, configPath });

  assert.equal(loaded.config.mihomo.dnsMode, 'inherit');
  assert.deepEqual(loaded.config.mihomo.dnsServers, []);
  assert.equal(loaded.config.mihomo.dnsIpv6, true);
});

test('keeps an explicit runtime confirmation flag', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-runtime-confirmed-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ runtimeMode: 'external', runtimeModeConfirmed: true }), 'utf8');

  const loaded = await loadCliConfig({ cwd: root, configPath });

  assert.equal(loaded.config.runtimeModeConfirmed, true);
});

test('keeps the Surge native VLESS runtime selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-runtime-native-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ runtimeMode: 'surge-native', runtimeModeConfirmed: true }), 'utf8');

  const loaded = await loadCliConfig({ cwd: root, configPath });

  assert.equal(loaded.config.runtimeMode, 'surge-native');
  assert.equal(loaded.config.runtimeModeConfirmed, true);
});

test('persists one stable controller secret when a Mihomo config first loads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-mihomo-secret-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ runtimeMode: 'mihomo', mihomo: { controllerSecret: '' } }), 'utf8');

  const first = await loadCliConfig({ cwd: root, configPath });
  const persisted = JSON.parse(await readFile(configPath, 'utf8'));
  const second = await loadCliConfig({ cwd: root, configPath });

  assert.ok(first.config.mihomo.controllerSecret.length >= 32);
  assert.equal(persisted.mihomo.controllerSecret, first.config.mihomo.controllerSecret);
  assert.equal(second.config.mihomo.controllerSecret, first.config.mihomo.controllerSecret);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});
