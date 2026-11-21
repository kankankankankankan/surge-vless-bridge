/**
 * [INPUT]: 合成 Clash 记录、TLS 参数与 XHTTP extra。
 * [OUTPUT]: 通用参数、别名、证书格式与官方 CLI 的回归证据。
 * [POS]: 原生参数兼容验收，不连接真实节点。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { parseSubscriptionNodes } = require('../dist/parse.js');
const { parseNativeProxy, buildNativeProxyLine } = require('../dist/native/proxy.js');
const { parseVlessNode } = require('../dist/utils/parse-vless-node.js');
const { nativeXhttpParameters } = require('../dist/native/xhttp.js');
const { nativePolicyParameters } = require('../dist/native/parameters.js');
const { buildNativeVlessProxyLine, syncNativeSurgeToSurge } = require('../dist/surge.js');
const { validateSurgeProfile } = require('../dist/utils/surge-cli.js');
const { makeConfig } = require('./helpers.js');
const digest = 'ab'.repeat(32);
const uuid = '00000000-0000-4000-8000-000000000001';
const common = { 'ip-version': 'dual', tfo: false, 'block-quic': 'adaptive', 'test-url': 'https://www.gstatic.com/generate_204', 'test-timeout': 8, 'test-udp': 'example.com@1.1.1.1' };
const linkFor = proxy => parseSubscriptionNodes(JSON.stringify({ proxies: [proxy] }), { native: true })[0];
const hy2 = { name: 'HY2', type: 'hysteria2', server: 'hy2.example', port: 60000, ports: '60000-65530', mport: '60000-65530',
  udp: true, 'skip-cert-verify': true, sni: 'cert.example', password: 'SYNTHETIC_SECRET', fingerprint: digest };

test('Hysteria2 accepts matching ports/mport and preserves TLS and hopping; rejects conflicting aliases', () => {
  const node = parseNativeProxy(linkFor(hy2), 0);
  assert.equal(node.parameters['port-hopping'], '60000-65530');
  assert.equal(node.parameters['server-cert-fingerprint-sha256'], digest);
  assert.equal(node.parameters['skip-cert-verify'], 'true');
  assert.equal(node.parameters.sni, 'cert.example');
  assert.throws(() => linkFor({ ...hy2, mport: '60001-65530' }), /ports 与 mport/);
  assert.throws(() => linkFor({ ...hy2, fingerprint: 'PUBLIC_KEY_NOT_A_CERTIFICATE' }), error => {
    assert.match(error.message, /SHA-256/);
    assert.doesNotMatch(error.message, /PUBLIC_KEY_NOT_A_CERTIFICATE|SYNTHETIC_SECRET/);
    return true;
  });
});

test('native TLS retains independent verification name, certificate pin and ALPN across protocols', () => {
  for (const type of ['anytls', 'trojan', 'hysteria2', 'tuic-v5', 'vmess']) {
    const node = parseNativeProxy(linkFor({ name: type, type, server: 'tls.example', port: 443, password: 'SYNTHETIC_SECRET',
      ...(['vmess', 'tuic-v5'].includes(type) ? { uuid } : {}), tls: true, sni: 'sni.example', 'name-cert-verify': 'verify.example', fingerprint: digest.toUpperCase().match(/../g).join(':'), alpn: ['h2', 'http/1.1'] }), 0);
    assert.equal(node.parameters['server-cert-verify-name'], 'verify.example');
    assert.equal(node.parameters['server-cert-fingerprint-sha256'], digest);
    assert.equal(node.parameters.alpn, 'h2,http/1.1');
    assert.equal(node.parameters['skip-cert-verify'], undefined);
  }
});

test('native common policy options survive imports and override global defaults', () => {
  const node = parseNativeProxy(linkFor({ ...hy2, ...common }), 0);
  const line = buildNativeProxyLine('HY2', node, true, true);
  assert.match(line, /tfo=false/);
  assert.match(line, /ip-version=dual/);
  assert.equal((line.match(/ip-version=/g) || []).length, 1);
  assert.throws(() => linkFor({ ...hy2, 'underlying-proxy': 'Entry' }), /端口跳跃/);
  for (const invalid of [{ 'test-url': 'file:///tmp/private' }, { tos: 256 }, { 'test-timeout': 0 }, { 'ip-version': 'invalid' }]) {
    assert.throws(() => nativePolicyParameters(invalid), /格式无效/);
  }
});

test('native VLESS maps certificate parameters and gRPC fields without changing External support', () => {
  const proxy = { name: 'VLESS', type: 'vless', server: 'node.example', port: 443, uuid, tls: true,
    fingerprint: digest, 'name-cert-verify': 'verify.example', network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'edge', authority: 'grpc.example', mode: 'multi' } };
  const node = parseVlessNode(linkFor(proxy), 0);
  const line = buildNativeVlessProxyLine({ nodeName: 'VLESS', outbound: node, config: { tcpFastOpen: false } });
  assert.match(line, /server-cert-verify-name=verify\.example/);
  assert.match(line, /grpc-authority=grpc\.example/);
  assert.match(line, /grpc-mode=multi/);
  assert.throws(() => parseSubscriptionNodes(JSON.stringify({ proxies: [proxy] })), /暂不支持 fingerprint/);
  assert.throws(() => buildNativeVlessProxyLine({ nodeName: 'Bad', outbound: { ...node, uuid: 'malformed-long-identifier-'.repeat(2) }, config: {} }), /用户 ID/);
});

test('native VLESS keeps XHTTP automatic ALPN and gRPC h2 unless the source explicitly overrides them', () => {
  for (const type of ['xhttp', 'grpc']) {
    const link = `vless://${uuid}@node.example:443?security=tls&type=${type}&client-cert=existing-cert`;
    const node = parseVlessNode(link, 0);
    assert.deepEqual(node.tls.alpn, type === 'grpc' ? ['h2'] : []);
    const line = buildNativeVlessProxyLine({ nodeName: 'Node', outbound: node, config: {},
      policyParameters: nativePolicyParameters(new URL(link).searchParams) });
    assert.match(line, /client-cert=existing-cert/);
    assert.doesNotMatch(line, /alpn=http\/1\.1/);
    const explicit = parseVlessNode(`vless://${uuid}@node.example:443?security=tls&type=${type}&alpn=http%2F1.1`, 0);
    assert.deepEqual(explicit.tls.alpn, ['http/1.1']);
  }
});

test('XHTTP extra maps documented fields and rejects unknown or unsupported settings', async t => {
  const values = { xPaddingBytes: '100-1000', xPaddingObfsMode: true, xPaddingKey: 'padding', xPaddingHeader: 'X-Padding',
    xPaddingPlacement: 'queryInHeader', xPaddingMethod: 'tokenish', uplinkHTTPMethod: 'POST',
    sessionIDPlacement: 'path', sessionIDKey: 'session', sessionIDTable: uuid, sessionIDLength: 36,
    seqPlacement: 'query', seqKey: 'seq', uplinkDataPlacement: 'body', uplinkDataKey: 'data', uplinkChunkSize: 4096,
    noGRPCHeader: true, scMaxEachPostBytes: 1000000, scMinPostsIntervalMs: '30-50',
    headers: { 'User-Agent': 'chrome', 'X-Client': 'example' },
    xmux: { maxConcurrency: '8-16', cMaxReuseTimes: 5, hMaxRequestTimes: '600-900', hMaxReusableSecs: '1800-3000', hKeepAlivePeriod: 30 } };
  const result = nativeXhttpParameters(JSON.stringify(values));
  assert.equal(Object.keys(result).length, 25);
  assert.equal(nativeXhttpParameters('{"xmux":{"maxConnections":3}}')['xhttp-xmux-max-connections'], '3');
  assert.equal(result['xhttp-headers'], 'User-Agent:chrome|X-Client:example');
  assert.equal(result['xhttp-min-posts-interval'], '30-50');
  for (const value of [{ downloadSettings: {} }, { futureSetting: true }, { xmux: { future: 1 } }, { scMaxEachPostBytes: '9-2' },
    { headers: { Host: 'invalid.example' } }, { uplinkHTTPMethod: 'GET' },
    { xmux: { maxConnections: 3, maxConcurrency: 8 } }, { sessionIDTable: 'abcd' }]) {
    assert.throws(() => nativeXhttpParameters(JSON.stringify(value)), /XHTTP extra/);
  }
  assert.equal(nativeXhttpParameters('{"uplinkHTTPMethod":"GET"}', 'packet-up')['xhttp-uplink-method'], 'GET');
  const { root, config } = await makeConfig('xhttp-all-parameters');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const node = parseVlessNode(`vless://${uuid}@xhttp.example:443?security=tls&type=xhttp&extra=${encodeURIComponent(JSON.stringify(values))}`, 0);
  const line = buildNativeVlessProxyLine({ nodeName: 'XHTTP', outbound: node, config: {} });
  await validateSurgeProfile(`[Proxy]\n${line}\n[Proxy Group]\nProxy = select, XHTTP\n[Rule]\nFINAL,Proxy\n`, config.surgeConfigPath);
  const single = { ...node, transport: { ...node.transport, extra: '{"xmux":{"maxConnections":3}}' } };
  const singleLine = buildNativeVlessProxyLine({ nodeName: 'XHTTP', outbound: single, config: {} });
  await validateSurgeProfile(`[Proxy]\n${singleLine}\n[Rule]\nFINAL,XHTTP\n`, config.surgeConfigPath);
});

test('VLESS Reality sample structure retains Vision/SNI/key/short-id and reports the fixed native fingerprint', async t => {
  const notices = [];
  const record = { name: 'Reality', type: 'vless', server: 'node.example', port: 443, uuid, udp: true, tls: true,
    'skip-cert-verify': false, flow: 'xtls-rprx-vision', 'client-fingerprint': 'ios', servername: 'www.example.com',
    'reality-opts': { 'public-key': 'A'.repeat(43), 'short-id': '3206e665' } };
  const [link] = parseSubscriptionNodes(JSON.stringify({ proxies: [record] }), { native: true, onNotice: value => notices.push(value) });
  const node = parseVlessNode(link, 0);
  const line = buildNativeVlessProxyLine({ nodeName: 'Reality', outbound: node, config: {} });
  assert.match(line, /flow=xtls-rprx-vision/);
  assert.match(line, /reality-short-id=3206e665/);
  assert.match(line, /sni=www\.example\.com/);
  assert.doesNotMatch(line, /ios|skip-cert-verify/);
  assert.match(notices.join(' '), /TLS 指纹/);
  const { root, config } = await makeConfig('reality-sample-structure');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await validateSurgeProfile(`[Proxy]\n${line}\n[Proxy Group]\nProxy = select, Reality\n[Rule]\nFINAL,Proxy\n`, config.surgeConfigPath);
  assert.throws(() => buildNativeVlessProxyLine({ nodeName: 'BadSNI', outbound: { ...node, tls: { ...node.tls, server_name: 'www\\.example.com' } }, config: {} }), /SNI/);
});

test('new AnyTLS TLS, Hysteria2 aliases and XHTTP parameters pass installed Surge syntax check', async t => {
  const { root, config } = await makeConfig('native-parameter-syntax');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const anytls = parseNativeProxy(linkFor({ name: 'AnyTLS', type: 'anytls', server: 'anytls.example', port: 443,
    password: 'SYNTHETIC_SECRET', sni: 'sni.example', 'name-cert-verify': 'verify.example', reuse: false, ...common }), 0);
  const xhttp = parseVlessNode(linkFor({ name: 'XHTTP', type: 'vless', server: 'xhttp.example', port: 443, uuid, tls: true,
    network: 'xhttp', 'xhttp-opts': { path: '/xhttp', mode: 'packet-up', extra: {
      scMaxEachPostBytes: 1000000, scMinPostsIntervalMs: 30, xPaddingBytes: '100-1000',
      headers: { 'User-Agent': 'chrome' }, xmux: { maxConcurrency: '8-16' } } } }), 0);
  const lines = [buildNativeProxyLine('AnyTLS', anytls, false, true),
    buildNativeProxyLine('HY2', parseNativeProxy(linkFor(hy2), 0), false, true),
    buildNativeVlessProxyLine({ nodeName: 'XHTTP', outbound: xhttp, config: {} })];
  const result = await validateSurgeProfile(`[Proxy]\n${lines.join('\n')}\n[Proxy Group]\nProxy = select, AnyTLS, HY2, XHTTP\n[Rule]\nFINAL,Proxy\n`, config.surgeConfigPath);
  if (!result.checked) t.diagnostic('Surge CLI unavailable; syntax validation skipped');
  assert.equal(typeof result.checked, 'boolean');
});

test('VLESS per-node common settings survive preview and repeat sync without mutating the live profile on failure', async t => {
  const { root, config } = await makeConfig('native-parameter-sync');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  Object.assign(config, { runtimeMode: 'surge-native', tcpFastOpen: true, vlessNodes: [linkFor({
    name: 'VLESS', type: 'vless', server: 'node.example', port: 443, uuid, ...common,
  })] });
  const before = await fs.readFile(config.surgeConfigPath, 'utf8');
  await syncNativeSurgeToSurge(config, { dryRun: true });
  assert.equal(await fs.readFile(config.surgeConfigPath, 'utf8'), before);
  await syncNativeSurgeToSurge(config);
  const saved = await fs.readFile(config.surgeConfigPath, 'utf8');
  assert.match(saved, /tfo=false/);
  assert.match(saved, /ip-version=dual/);
  await syncNativeSurgeToSurge(config);
  assert.equal(await fs.readFile(config.surgeConfigPath, 'utf8'), saved);
  config.vlessNodes[0] = config.vlessNodes[0].replace('test-timeout=8', 'test-timeout=0');
  await assert.rejects(syncNativeSurgeToSurge(config), /格式无效/);
  assert.equal(await fs.readFile(config.surgeConfigPath, 'utf8'), saved);
});
