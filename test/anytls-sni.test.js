/**
 * [INPUT]: 合成 AnyTLS 订阅、隔离配置和编译后的核心与桌面服务。
 * [OUTPUT]: SNI 校验、单端点作用域、缓存保留、持久化与同步回归。
 * [POS]: AnyTLS TLS 身份设置验收，不连接真实节点或修改用户配置。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { normalizeAnyTlsSniOverrides, applyAnyTlsSniOverride, anyTlsEndpointKey } = require('../dist/native/anytls-sni.js');
const { parseNativeProxy } = require('../dist/native/proxy.js');
const { syncNativeSurgeToSurge } = require('../dist/surge.js');
const { loadCliConfig } = require('../dist/configuration.js');
const { DesktopService } = require('../dist/desktop/service.js');
const { readSubscriptionCache } = require('../dist/utils/subscription-cache.js');
const { makeConfig, subscriptionUrl } = require('./helpers.js');
const originalLink = 'anytls://SYNTHETIC_PASSWORD@node.example:443?alpn=h2%2Chttp%2F1.1#AnyTLS';
const override = { server: 'node.example', port: 443, sni: 'cert.example' };

test('normalizes explicit SNI overrides and rejects malformed or ambiguous server identities', () => {
  assert.deepEqual(normalizeAnyTlsSniOverrides(undefined), []);
  assert.deepEqual(normalizeAnyTlsSniOverrides([{ ...override, server: 'NODE.EXAMPLE.', sni: 'CERT.EXAMPLE.' }]), [override]);
  assert.deepEqual(normalizeAnyTlsSniOverrides([{ ...override, sni: '' }]), []);
  assert.equal(anyTlsEndpointKey('[2001:db8::1]', 443), anyTlsEndpointKey('2001:0db8:0:0:0:0:0:1', 443));
  for (const sni of ['https://cert.example', 'cert.example/path', 'cert.example:443', '*.example', '127.0.0.1', 'cert.example\n,skip-cert-verify=true']) {
    assert.throws(() => normalizeAnyTlsSniOverrides([{ ...override, sni }]), /SNI/);
  }
  assert.throws(() => normalizeAnyTlsSniOverrides([{ ...override, port: 0 }]), /端口/);
  assert.throws(() => normalizeAnyTlsSniOverrides([override, { ...override, sni: 'other.example' }]), /同一/);
});

test('SNI applies only to the chosen AnyTLS endpoint and preserves credentials, verification and input nodes', () => {
  const node = parseNativeProxy(originalLink, 0);
  const fixed = applyAnyTlsSniOverride(node, [override]);
  assert.equal(fixed.parameters.sni, override.sni);
  assert.equal(fixed.parameters.password, node.parameters.password);
  assert.equal(fixed.parameters['skip-cert-verify'], undefined);
  assert.equal(node.parameters.sni, undefined);
  assert.equal(applyAnyTlsSniOverride({ ...node, server_port: 8443 }, [override]).parameters.sni, undefined);
  assert.equal(applyAnyTlsSniOverride({ ...node, type: 'trojan' }, [override]).parameters.sni, undefined);
  assert.equal(applyAnyTlsSniOverride({ ...node, server: 'different.example' }, [override]).parameters.sni, undefined);
});

test('preview, sync, node renaming and clearing a saved SNI preserve source data and strict TLS', async t => {
  const { root, config } = await makeConfig('anytls-sni-sync');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  Object.assign(config, { runtimeMode: 'surge-native', subscriptionUrls: [subscriptionUrl([originalLink])], anytlsSniOverrides: [override] });
  const before = await fs.readFile(config.surgeConfigPath, 'utf8');
  await syncNativeSurgeToSurge(config, { dryRun: true });
  assert.equal(await fs.readFile(config.surgeConfigPath, 'utf8'), before);
  await syncNativeSurgeToSurge(config);
  let profile = await fs.readFile(config.surgeConfigPath, 'utf8');
  assert.match(profile, /^AnyTLS = anytls,.*sni=cert\.example/m);
  assert.doesNotMatch(profile, /skip-cert-verify/);
  assert.deepEqual((await readSubscriptionCache(config, config.subscriptionUrls[0])).nodes, [originalLink]);
  config.subscriptionUrls = [subscriptionUrl([originalLink.replace('#AnyTLS', '#Renamed')])];
  await syncNativeSurgeToSurge(config);
  assert.match(await fs.readFile(config.surgeConfigPath, 'utf8'), /^Renamed = anytls,.*sni=cert\.example/m);
  config.anytlsSniOverrides = [];
  await syncNativeSurgeToSurge(config);
  profile = await fs.readFile(config.surgeConfigPath, 'utf8');
  assert.doesNotMatch(profile, /sni=cert\.example/);
});

test('certificate verification name and reuse can be overridden independently from SNI', () => {
  const node = parseNativeProxy(originalLink.replace('#AnyTLS', '&vcn=source-cert.example&reuse=true#AnyTLS'), 0);
  const settings = normalizeAnyTlsSniOverrides([{ ...override, sni: '', certificateVerifyName: 'CERT.EXAMPLE.', reuse: false }]);
  const fixed = applyAnyTlsSniOverride(node, settings);
  assert.equal(fixed.parameters.sni, undefined);
  assert.equal(fixed.parameters['server-cert-verify-name'], 'cert.example');
  assert.equal(fixed.parameters.reuse, 'false');
  assert.equal(fixed.parameters['skip-cert-verify'], undefined);
  assert.equal(node.parameters.reuse, 'true');
  assert.equal(normalizeAnyTlsSniOverrides([{ ...override, sni: '', reuse: false }])[0].reuse, false);
  for (const value of ['true', null, 0]) assert.throws(() => normalizeAnyTlsSniOverrides([{ ...override, reuse: value }]), /布尔/);
  assert.throws(() => normalizeAnyTlsSniOverrides([{ ...override, certificateVerifyName: 'https://bad.example' }]), /证书校验名称/);
});

test('desktop saves SNI independently, omits credentials from node settings and restores the source SNI when cleared', async t => {
  const { root, config } = await makeConfig('anytls-sni-desktop');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  Object.assign(config, { runtimeMode: 'surge-native', vlessNodes: [originalLink.replace('?alpn=', '?sni=source.example&alpn=')] });
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const service = new DesktopService({ configPath, executablePath: process.execPath, scheduledEntryPath: '/unused' });
  let state = await service.getState();
  assert.equal(state.anytlsNodes.length, 1);
  assert.equal(state.anytlsNodes[0].sourceSni, 'source.example');
  assert.equal(state.anytlsNodes[0].sourceCertificateVerifyName, '');
  assert.equal(state.anytlsNodes[0].sourceReuse, true);
  assert.doesNotMatch(JSON.stringify(state.anytlsNodes), /SYNTHETIC_PASSWORD/);
  await service.saveSettings({ ...state.config, anytlsSniOverrides: [override] });
  await service.saveSources({ subscriptionUrls: [], vlessNodes: config.vlessNodes });
  const stored = await loadCliConfig({ cwd: root, configPath });
  assert.deepEqual(stored.config.anytlsSniOverrides, [override]);
  assert.equal((await service.runAction('sync')).success, true);
  assert.match(await fs.readFile(config.surgeConfigPath, 'utf8'), /sni=cert\.example/);
  const rawBefore = await fs.readFile(configPath, 'utf8');
  await assert.rejects(service.saveSettings({ ...state.config, anytlsSniOverrides: [{ ...override, sni: 'bad,skip-cert-verify=true' }] }), /SNI/);
  assert.equal(await fs.readFile(configPath, 'utf8'), rawBefore);
  state = await service.getState();
  await service.saveSettings({ ...state.config, anytlsSniOverrides: [] });
  await service.runAction('sync');
  assert.match(await fs.readFile(config.surgeConfigPath, 'utf8'), /sni=source\.example/);
  await service.saveSettings({ ...state.config, anytlsSniOverrides: [{ ...override, sni: '', certificateVerifyName: 'cert.example', reuse: false }] });
  await service.runAction('sync');
  const independent = await fs.readFile(config.surgeConfigPath, 'utf8');
  assert.match(independent, /sni=source\.example/);
  assert.match(independent, /server-cert-verify-name=cert\.example/);
  assert.match(independent, /reuse=false/);
  assert.doesNotMatch(independent, /skip-cert-verify/);
});
