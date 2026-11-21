/**
 * [INPUT]: Synthetic protocol links, Clash records and isolated bridge profiles.
 * [OUTPUT]: Native conversion, field rejection, cache isolation and desktop lifecycle checks.
 * [POS]: Multi-protocol acceptance boundary; never changes live proxy profiles or services.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseSubscriptionNodes } = require('../dist/parse.js');
const { parseNativeProxy, buildNativeProxyLine } = require('../dist/native/proxy.js');
const { collectVlessNodes, syncNativeSurgeToSurge, runNativeDoctor } = require('../dist/surge.js');
const { readSubscriptionCache } = require('../dist/utils/subscription-cache.js');
const { filterSubscriptionNodes, normalizeSubscriptionOptions } = require('../dist/utils/subscription-options.js');
const { validateSurgeProfile } = require('../dist/utils/surge-cli.js');
const { DesktopService } = require('../dist/desktop/service.js');
const { makeConfig, subscriptionUrl, vlessLink } = require('./helpers.js');

const uuid = '00000000-0000-4000-8000-000000000001';
const vmess = (extra = {}) => 'vmess://' + Buffer.from(JSON.stringify({
  v: '2', ps: 'VMess Name', add: 'vmess.example', port: 443, id: uuid, aid: 0,
  scy: 'auto', tls: 'tls', ...extra,
})).toString('base64url');
const examples = [
  ['ss', `ss://${Buffer.from('aes-128-gcm:synthetic-secret').toString('base64url')}@ss.example:443#SS`],
  ['vmess', vmess()],
  ['trojan', 'trojan://synthetic-secret@trojan.example:443?sni=tls.example#Trojan'],
  ['anytls', 'anytls://synthetic-secret@anytls.example:443?alpn=h2%2Chttp%2F1.1&fp=safari&reuse=false#AnyTLS'],
  ['hysteria2', 'hy2://hy2.example:443?auth=synthetic-secret&sni=tls.example&insecure=1&mport=443,8443-8445#HY2'],
  ['tuic', 'tuic://synthetic-token@tuic.example:443?version=4&alpn=h3#TUIC4'],
  ['tuic-v5', `tuic://${uuid}:synthetic-secret@tuic.example:443?alpn=h3#TUIC5`],
];

for (const [type, link] of examples) {
  test(`native ${type} imports its own protocol and passes Surge syntax validation`, async t => {
    const notices = [];
    const links = parseSubscriptionNodes(Buffer.from(link).toString('base64'), { native: true, onNotice: value => notices.push(value) });
    assert.deepEqual(links, [link]);
    const node = parseNativeProxy(links[0], 0);
    assert.equal(node.type, type);
    const line = buildNativeProxyLine('Node', node, false, true);
    assert.match(line, new RegExp(`^Node = ${type},`));
    assert.doesNotMatch(line, /= vless,/);
    if (type === 'anytls') {
      assert.match(line, /password=synthetic-secret/);
      assert.match(line, /reuse=false/);
      assert.match(notices.join('\n'), /TLS 指纹/);
      assert.doesNotMatch(line, /fp=|safari/);
    }
    if (type === 'vmess') assert.match(line, /vmess-aead=true/);
    if (type === 'hysteria2') {
      assert.match(line, /password=synthetic-secret/);
      assert.match(line, /port-hopping="443;8443-8445"/);
      assert.match(line, /skip-cert-verify=true/);
    }
    const { root, config } = await makeConfig('native-syntax');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await validateSurgeProfile(`[Proxy]\n${line}\n[Proxy Group]\nProxy = select, Node\n[Rule]\nFINAL,Proxy\n`, config.surgeConfigPath);
    assert.equal(typeof result.checked, 'boolean');
  });
}

test('native SS supports legacy links, simple-obfs and encoded punctuation without losing credentials', () => {
  const raw = `ss://${Buffer.from('aes-256-gcm:secret:ss@ss.example:443').toString('base64')}#Legacy`;
  const legacy = parseNativeProxy(raw, 0);
  assert.equal(legacy.parameters.password, 'secret:ss');
  const link = `ss://${Buffer.from('aes-256-gcm:secret, "quoted"\\tail').toString('base64url')}@ss.example:443?plugin=${encodeURIComponent('obfs-local;obfs=tls;obfs-host=cdn.example')}#SS`;
  const node = parseNativeProxy(link, 0);
  assert.equal(node.parameters['obfs-host'], 'cdn.example');
  assert.match(buildNativeProxyLine('SS', node, true, true), /encrypt-method=aes-256-gcm/);
  assert.equal(parseNativeProxy('ss://none:@ss.example:443#None', 0).parameters['encrypt-method'], 'none');
});

test('native VMess retains display-name filtering, TLS and WebSocket transport', () => {
  const link = vmess({ net: 'ws', path: '/ws?ed=1024', host: 'cdn.example', sni: 'tls.example', scy: 'chacha20-poly1305' });
  const node = parseNativeProxy(link, 0);
  assert.equal(node.tag, 'VMess Name');
  assert.equal(node.parameters['encrypt-method'], 'chacha20-ietf-poly1305');
  assert.equal(node.parameters['ws-path'], '/ws?ed=1024');
  assert.equal(node.parameters['ws-headers'], 'Host:cdn.example');
  assert.deepEqual(filterSubscriptionNodes([link], normalizeSubscriptionOptions({ include: 'vmess name' })), [link]);
});

test('native conversion rejects unsupported transport and parameters without exposing credentials', () => {
  const invalid = [vmess({ net: 'grpc' }), vmess({ aid: 8 }), vmess({ scy: 'none' }),
    'anytls://SECRET@peer.example:443?type=grpc',
    'anytls://SECRET@peer.example:443?security=none',
    'hy2://SECRET@peer.example:443?obfs=unknown',
    'hy2://SECRET@peer.example:443?mport=65536',
    'hy2://SECRET@peer.example:443?obfs=salamander',
    `ss://${Buffer.from('aes-128-gcm:SECRET').toString('base64url')}@ss.example:443?plugin=v2ray-plugin`,
    'anytls://SECRET%0Aline@peer.example:443'];
  for (const link of invalid) {
    assert.throws(() => parseSubscriptionNodes(link, { native: true }), error => {
      assert.doesNotMatch(error.message, /SECRET|peer\.example|ss\.example/);
      return true;
    });
  }
});

test('native Clash adapters preserve supported fields and reject unmapped plugin and ECH settings', () => {
  const proxies = [
    { type: 'ss', name: 'SS', server: 'ss.example', port: 443, cipher: 'aes-128-gcm', password: 'test-secret', plugin: 'obfs', 'plugin-opts': { mode: 'tls', host: 'cdn.example' } },
    { type: 'vmess', name: 'VMess', server: 'vmess.example', port: 443, uuid, alterId: 0, cipher: 'auto', tls: true, network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'cdn.example' } } },
    { type: 'trojan', name: 'Trojan', server: 'trojan.example', port: 443, password: 'test-secret', sni: 'tls.example' },
    { type: 'anytls', name: 'AnyTLS', server: 'anytls.example', port: 443, password: 'test-secret', 'skip-cert-verify': true },
    { type: 'hysteria2', name: 'HY2', server: 'hy2.example', port: 443, password: 'test-secret', obfs: 'salamander', 'obfs-password': 'padding', down: '100 Mbps' },
    { type: 'tuic', name: 'TUIC', server: 'tuic.example', port: 443, uuid, password: 'test-secret', alpn: ['h3'] },
  ];
  const text = JSON.stringify({ proxies });
  for (const raw of [text, Buffer.from(text).toString('base64'), 'proxies:\n' + proxies.map(p => ' - ' + JSON.stringify(p)).join('\n')]) {
    const nodes = parseSubscriptionNodes(raw, { native: true }).map((link, i) => parseNativeProxy(link, i));
    assert.deepEqual(nodes.map(node => node.type), ['ss', 'vmess', 'trojan', 'anytls', 'hysteria2', 'tuic-v5']);
    assert.equal(nodes[3].parameters['skip-cert-verify'], 'true');
    assert.equal(nodes[4].parameters['salamander-password'], 'padding');
  }
  assert.throws(() => parseSubscriptionNodes(JSON.stringify({ proxies: [{ ...proxies[3], 'ech-opts': { enabled: true } }] }), { native: true }), /未映射/);
});

test('native import reports unsupported protocols and opt-in skipped fields with safe diagnostics', () => {
  const notices = [], skipped = [];
  const links = parseSubscriptionNodes([vlessLink(1, 'VLESS'), 'ssr://SECRET', 'hysteria://SECRET',
    'future+protocol://SECRET', vmess({ net: 'grpc' })].join('\n'), {
    native: true, skipUnsupported: true, onNotice: message => notices.push(message), onSkipped: message => skipped.push(message),
  });
  assert.equal(links.length, 1);
  assert.equal(notices.length, 3);
  assert.equal(skipped.length, 1);
  assert.doesNotMatch([...notices, ...skipped].join('\n'), /SECRET/);
  assert.throws(() => parseSubscriptionNodes(vmess({ net: 'grpc' }), { native: true, skipUnsupported: true }), /配置与缓存/);
});

test('native cache migration reuses a legacy snapshot once and never revives explicitly empty native data', async t => {
  const { root, config } = await makeConfig('native-cache-migration');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  config.subscriptionUrls = ['https://example.invalid/subscription'];
  let body = vlessLink(1, 'Legacy');
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }));
  await collectVlessNodes(config);
  const native = { ...config, runtimeMode: 'surge-native' };
  assert.equal((await readSubscriptionCache(native, config.subscriptionUrls[0])).nodes.length, 1);
  body = 'ssr://test-only';
  await assert.rejects(collectVlessNodes(native), /没有可转换/);
  assert.equal((await readSubscriptionCache(native, config.subscriptionUrls[0])).nodes.length, 0);
  assert.equal((await readSubscriptionCache(config, config.subscriptionUrls[0])).nodes.length, 1);
});

test('native preview, sync, node count, duplicate names and mode-specific cache remain consistent', async t => {
  const { root, config } = await makeConfig('native-mixed');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  config.runtimeMode = 'surge-native';
  const allLinks = [vlessLink(1, 'VLESS'), ...examples.map(([, link]) => link)];
  config.subscriptionUrls = [subscriptionUrl(allLinks)];
  const original = await fs.readFile(config.surgeConfigPath, 'utf8');
  const preview = await syncNativeSurgeToSurge(config, { dryRun: true });
  assert.equal(preview.count, 8);
  assert.ok(preview.preview.nodes.some(node => node.name === 'VLESS 2'));
  assert.equal(await fs.readFile(config.surgeConfigPath, 'utf8'), original);
  assert.equal((await syncNativeSurgeToSurge(config)).count, 8);
  const doctor = await runNativeDoctor(config);
  assert.match(doctor.checks.find(check => check.label === 'surge-native').detail, /^8 native proxy/);
  const source = config.subscriptionUrls[0];
  const nativeCache = await readSubscriptionCache(config, source);
  assert.equal(nativeCache.nodes.length, 8);
  assert.equal((await collectVlessNodes({ ...config, runtimeMode: 'external' })).length, 1);
  assert.equal((await readSubscriptionCache(config, source)).nodes.length, 8);
  assert.equal((await readSubscriptionCache({ ...config, runtimeMode: 'external' }, source)).nodes.length, 1);
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const service = new DesktopService({ configPath, executablePath: process.execPath, scheduledEntryPath: '/unused' });
  const state = await service.getState();
  assert.equal(state.nodeCount, 8);
  assert.equal(state.subscriptionStatuses[0].count, 8);
  await service.saveSources({ subscriptionUrls: [], vlessNodes: [examples[3][1]] });
  assert.equal((await service.runAction('sync')).count, 1);
  assert.match(await fs.readFile(config.surgeConfigPath, 'utf8'), /^AnyTLS = anytls,/m);
  await assert.rejects(collectVlessNodes({ ...config, runtimeMode: 'external', subscriptionUrls: [], vlessNodes: [examples[3][1]] }), /直接节点包含/);
});
