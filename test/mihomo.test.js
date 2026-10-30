const assert = require('node:assert/strict');
const { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('yaml');

const { loadCliConfig } = require('../dist/configuration.js');
const { doctorBridge } = require('../dist/engines/index.js');
const {
  buildMihomoSurgeProxyLine,
  mapVlessToMihomoProxy,
  renderMihomoConfig,
} = require('../dist/mihomo/config.js');
const { selectMihomoAsset } = require('../dist/mihomo/dependencies.js');
const { renderMihomoLaunchAgentPlist } = require('../dist/mihomo/launch-agent.js');
const { cleanMihomoArtifacts, syncMihomoToSurge } = require('../dist/mihomo/sync.js');
const { buildSurgeProfile } = require('../dist/surge.js');
const { parseVlessNode } = require('../dist/utils/parse-vless-node.js');
const { makeConfig, subscriptionUrl, vlessLink } = require('./helpers.js');

test('legacy configuration defaults to the external runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-runtime-mode-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ policyGroupName: 'VLESS' }), 'utf8');
  const loaded = await loadCliConfig({ cwd: root, configPath });
  assert.equal(loaded.config.runtimeMode, 'external');
  assert.equal(loaded.config.runtimeModeConfirmed, false);
  assert.equal(loaded.config.mihomo.controllerHost, '127.0.0.1');
  assert.ok(loaded.config.mihomo.controllerSecret.length >= 32);
});

test('maps TLS REALITY and supported connection options to a Mihomo VLESS proxy', async () => {
  const { config } = await makeConfig('mihomo-reality');
  config.udpRelay = true;
  config.tcpFastOpen = true;
  config.connectTimeoutEnabled = true;
  config.connectTimeoutSeconds = 12;
  const outbound = parseVlessNode(
    'vless://uuid-1@a.example:443?security=reality&pbk=PUBLIC&sid=abcd&fp=chrome&sni=sni.example&flow=xtls-rprx-vision&packetEncoding=xudp#R',
    0,
  );
  const proxy = mapVlessToMihomoProxy(outbound, 'R', config);
  assert.equal(proxy.tls, true);
  assert.equal(proxy.servername, 'sni.example');
  assert.equal(proxy['client-fingerprint'], 'chrome');
  assert.deepEqual(proxy['reality-opts'], { 'public-key': 'PUBLIC', 'short-id': 'abcd' });
  assert.equal(proxy.flow, 'xtls-rprx-vision');
  assert.equal(proxy['packet-encoding'], 'xudp');
  assert.equal(proxy.udp, true);
  assert.equal(proxy.tfo, true);
  assert.equal(proxy['connect-timeout'], undefined);
});

test('maps websocket, grpc and http upgrade transports', async () => {
  const { config } = await makeConfig('mihomo-transports');
  const ws = mapVlessToMihomoProxy(
    parseVlessNode('vless://u@a.example:443?type=ws&path=/ray&host=cdn.example#WS', 0),
    'WS',
    config,
  );
  const grpc = mapVlessToMihomoProxy(
    parseVlessNode('vless://u@a.example:443?type=grpc&serviceName=svc#GRPC', 0),
    'GRPC',
    config,
  );
  const httpupgrade = mapVlessToMihomoProxy(
    parseVlessNode('vless://u@a.example:443?type=httpupgrade&path=/up&host=cdn.example#HU', 0),
    'HU',
    config,
  );
  assert.deepEqual(ws['ws-opts'], { path: '/ray', headers: { Host: 'cdn.example' } });
  assert.deepEqual(grpc['grpc-opts'], { 'grpc-service-name': 'svc' });
  assert.deepEqual(httpupgrade['httpupgrade-opts'], { path: '/up', host: 'cdn.example' });
});

test('renders loopback-only listeners and SOCKS5 Surge options', async () => {
  const { config } = await makeConfig('mihomo-render');
  config.mihomo.controllerSecret = 'local-secret';
  config.udpRelay = true;
  config.udpTestEnabled = true;
  config.udpTestTarget = 'apple.com@8.8.8.8';
  config.tcpFastOpen = true;
  const outbound = parseVlessNode(vlessLink(1, 'Tokyo'), 0);
  const nodes = [{ name: 'Tokyo', port: 2081, server: outbound.server, proxy: mapVlessToMihomoProxy(outbound, 'Tokyo', config) }];
  const document = parse(renderMihomoConfig({ nodes, config }));
  assert.equal(document['external-controller'], '127.0.0.1:19090');
  assert.equal(document.secret, 'local-secret');
  assert.deepEqual(document.listeners[0], {
    name: 'surge-vless-2081',
    type: 'socks',
    listen: '127.0.0.1',
    port: 2081,
    udp: true,
    proxy: 'Tokyo',
  });
  assert.equal(
    buildMihomoSurgeProxyLine({ name: 'Tokyo', port: 2081, config }),
    'Tokyo = socks5, 127.0.0.1, 2081, udp-relay=true, test-udp=apple.com@8.8.8.8, tfo=true',
  );
});

test('manages the Mihomo process rule without touching user rules', async () => {
  const { config } = await makeConfig('mihomo-rule');
  config.runtimeMode = 'mihomo';
  const enabled = await buildSurgeProfile({ config, proxyLines: ['A = socks5, 127.0.0.1, 2081'], nodeNames: ['A'] });
  assert.match(enabled.updated, /# surge-vless-bridge mihomo rule start\nPROCESS-NAME,mihomo,DIRECT/);
  assert.match(enabled.updated, /FINAL,Proxy/);
  await writeFile(config.surgeConfigPath, enabled.updated, 'utf8');
  config.runtimeMode = 'external';
  const disabled = await buildSurgeProfile({ config, proxyLines: ['A = external, exec=x'], nodeNames: ['A'] });
  assert.doesNotMatch(disabled.updated, /surge-vless-bridge mihomo rule/);
  assert.match(disabled.updated, /FINAL,Proxy/);
});

test('uses the configured Mihomo binary basename in the managed process rule', async () => {
  const { config } = await makeConfig('mihomo-custom-process-rule');
  config.runtimeMode = 'mihomo';
  config.mihomo.binary = '/tmp/custom/SurgeMihomoCore';

  const profile = await buildSurgeProfile({
    config,
    proxyLines: ['A = socks5, 127.0.0.1, 2081'],
    nodeNames: ['A'],
  });

  assert.match(profile.updated, /PROCESS-NAME,SurgeMihomoCore,DIRECT/);
  assert.doesNotMatch(profile.updated, /PROCESS-NAME,mihomo,DIRECT/);
});

test('selects compatible Intel and native Apple Silicon release assets', () => {
  const release = {
    tag_name: 'v1.2.3',
    assets: [
      { name: 'mihomo-darwin-amd64-v1.2.3.gz', browser_download_url: 'x', digest: 'sha256:a', size: 1 },
      { name: 'mihomo-darwin-amd64-compatible-v1.2.3.gz', browser_download_url: 'x', digest: 'sha256:b', size: 1 },
      { name: 'mihomo-darwin-arm64-v1.2.3.gz', browser_download_url: 'x', digest: 'sha256:c', size: 1 },
    ],
  };
  assert.match(selectMihomoAsset(release, 'x64').name, /amd64-compatible/);
  assert.match(selectMihomoAsset(release, 'arm64').name, /arm64/);
});

test('renders a private background LaunchAgent', () => {
  const plist = renderMihomoLaunchAgentPlist({
    binary: '/tmp/a&b/mihomo',
    dataDir: '/tmp/data',
    configPath: '/tmp/data/config.yaml',
    autoStart: true,
  });
  assert.match(plist, /com\.chen86860\.surge-vless-bridge\.mihomo/);
  assert.match(plist, /a&amp;b\/mihomo/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /mihomo-error\.log/);
});

test('disables both LaunchAgent auto-start keys when Mihomo autoStart is off', () => {
  const plist = renderMihomoLaunchAgentPlist({
    binary: '/tmp/mihomo',
    dataDir: '/tmp/data',
    configPath: '/tmp/data/config.yaml',
    autoStart: false,
  });

  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.doesNotMatch(plist, /<key>(?:RunAtLoad|KeepAlive)<\/key><true\/>/);
});

test('Mihomo clean removes only managed configs and uses the injected service stop', async () => {
  const { root, config } = await makeConfig('mihomo-clean-boundary');
  const dataDir = path.join(root, 'mihomo-data');
  const binDir = path.join(root, 'bin');
  const appConfigPath = path.join(root, 'config.json');
  config.runtimeMode = 'mihomo';
  config.mihomo.dataDir = dataDir;
  config.mihomo.binary = path.join(binDir, 'mihomo');
  await mkdir(path.join(dataDir, 'logs'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(dataDir, 'config.yaml'), 'managed\n', 'utf8');
  await writeFile(path.join(dataDir, 'config.previous.yaml'), 'managed previous\n', 'utf8');
  await writeFile(path.join(dataDir, '.candidate-test.yaml'), 'candidate\n', 'utf8');
  await writeFile(path.join(dataDir, 'logs', 'mihomo.log'), 'log\n', 'utf8');
  await writeFile(path.join(dataDir, 'user-settings.yaml'), 'keep\n', 'utf8');
  await writeFile(config.mihomo.binary, 'binary\n', 'utf8');
  await writeFile(appConfigPath, '{"keep":true}\n', 'utf8');
  const stopCalls = [];

  const result = await cleanMihomoArtifacts(config, {
    stopService: async (options) => {
      stopCalls.push(options);
    },
  });

  assert.deepEqual(stopCalls, [{ uninstall: true }]);
  assert.equal(result.removedMihomoConfigs, 3);
  assert.deepEqual((await readdir(dataDir)).sort(), ['logs', 'user-settings.yaml']);
  assert.equal(await readFile(path.join(dataDir, 'logs', 'mihomo.log'), 'utf8'), 'log\n');
  assert.equal(await readFile(config.mihomo.binary, 'utf8'), 'binary\n');
  assert.equal(await readFile(appConfigPath, 'utf8'), '{"keep":true}\n');
});

test('desktop exposes runtime controls without exposing the controller secret', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const app = await readFile(path.join(__dirname, '..', 'desktop', 'app.js'), 'utf8');
  const main = await readFile(path.join(__dirname, '..', 'src', 'desktop', 'main.ts'), 'utf8');
  const types = await readFile(path.join(__dirname, '..', 'src', 'desktop', 'types.ts'), 'utf8');
  assert.match(html, /id="runtime-mode-control"/);
  assert.match(html, /id="runtime-mode-external"/);
  assert.match(html, /id="runtime-mode-mihomo"/);
  assert.match(html, /id="mihomo-settings"/);
  assert.match(html, /id="mihomo-service-state"/);
  assert.match(html, /id="engine-onboarding"/);
  assert.match(html, /id="engine-onboarding-external"/);
  assert.match(html, /id="engine-onboarding-mihomo"/);
  assert.match(html, /id="confirm-engine-choice"/);
  assert.match(html, /id="onboarding-install-mihomo-direct"/);
  assert.match(html, /id="onboarding-install-mihomo-brew"/);
  assert.match(html, /id="onboarding-choose-mihomo"/);
  assert.match(html, /id="onboarding-install-sing-box-direct"/);
  assert.match(html, /id="onboarding-install-sing-box-brew"/);
  assert.match(html, /id="onboarding-choose-sing-box"/);
  assert.match(html, /配置向导/);
  assert.match(html, /保留 Surge external 写法/);
  assert.match(html, /由单个 Mihomo 后台进程承载全部节点/);
  assert.match(html, /适合节点较多，需要统一后台管理/);
  assert.match(html, /class="engine-switch-option"/);
  assert.match(html, /data-requires-engine/);
  assert.match(app, /api\.switchEngine/);
  assert.match(app, /state\.runtimeModeConfirmed/);
  assert.match(app, /const selectedMode = onboardingDraftMode;/);
  assert.match(app, /setupWizardOpen/);
  assert.match(app, /api\.saveSources\(sources\)/);
  assert.match(app, /api\.runAction\('sync'\)/);
  assert.match(main, /minWidth:\s*720/);
  assert.doesNotMatch(types, /DesktopConfigView[\s\S]*controllerSecret:/);
});

test('desktop keeps shared generation settings visible and scopes resolver settings to External', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const app = await readFile(path.join(__dirname, '..', 'desktop', 'app.js'), 'utf8');
  const sharedSection = html.match(/<section id="shared-generation-settings"[\s\S]*?<\/section>/)?.[0] ?? '';
  const resolverSection = html.match(/<section id="external-resolver-settings"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(sharedSection, /<h2>生成选项<\/h2>/);
  assert.match(sharedSection, /id="policy-group-name"/);
  assert.match(sharedSection, /id="port-start"/);
  assert.match(resolverSection, /<h2>节点服务器域名解析<\/h2>/);
  assert.match(app, /\$\('#external-resolver-settings'\)\.classList\.toggle\('hidden', engineDraftMode !== 'external'\)/);
  assert.doesNotMatch(app, /\$\('#shared-generation-settings'\)\.classList\.toggle\('hidden'/);
});

test('Mihomo dry run validates the candidate and leaves the profile untouched', async () => {
  const { root, config } = await makeConfig('mihomo-dry-run');
  const binary = path.join(root, 'mihomo');
  await writeFile(binary, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(binary, 0o755);
  config.runtimeMode = 'mihomo';
  config.mihomo.binary = binary;
  config.mihomo.dataDir = path.join(root, 'mihomo-data');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'Tokyo')])];
  const before = await readFile(config.surgeConfigPath, 'utf8');
  const result = await syncMihomoToSurge(config, { dryRun: true });
  assert.equal(result.count, 1);
  assert.equal(result.preview.runtimeMode, 'mihomo');
  assert.equal(result.preview.proxyFormat, 'SOCKS5');
  assert.equal(await readFile(config.surgeConfigPath, 'utf8'), before);
});

test('Mihomo doctor uses engine-specific checks without requiring sing-box', async () => {
  const { root, config } = await makeConfig('mihomo-doctor');
  const binary = path.join(root, 'mihomo');
  await writeFile(binary, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(binary, 0o755);
  config.runtimeMode = 'mihomo';
  config.singBoxBinary = '/missing/sing-box';
  config.vlessNodes = [vlessLink(1, 'Doctor')];
  config.mihomo.binary = binary;
  config.mihomo.dataDir = path.join(root, 'mihomo-data');
  config.mihomo.controllerPort = 65431;

  const result = await doctorBridge(config);
  const labels = result.checks.map((check) => check.label);
  assert.ok(labels.includes('mihomoBinary'));
  assert.ok(labels.includes('mihomo-config'));
  assert.ok(labels.includes('mihomo-launch-agent'));
  assert.ok(labels.includes('mihomo-controller'));
  assert.ok(labels.includes('mihomo-listeners'));
  assert.ok(!labels.includes('singBoxBinary'));
  assert.ok(!labels.includes('outputDir'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(config.mihomo.controllerSecret));
});
