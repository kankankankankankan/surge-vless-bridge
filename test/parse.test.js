const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const { getVlessSubscriptionNodes, parseSubscriptionNodes } = require('../dist/parse.js');
const { parseVlessNode } = require('../dist/utils/parse-vless-node.js');
const { mapVlessToMihomoProxy } = require('../dist/mihomo/config.js');
const { LEGACY_SUBSCRIPTION_USER_AGENT, subscriptionHeaders } = require('../dist/utils/subscription-headers.js');

test('uses a supported Clash subscription identity for default and legacy browser requests', async t => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers['user-agent']);
    if (request.headers['user-agent'] !== 'clash.meta') {
      response.writeHead(403);
      response.end('only supported proxy clients may fetch subscriptions');
      return;
    }
    response.writeHead(200);
    response.end('proxies: [{name: demo, type: vless, server: example.com, port: 443, uuid: demo}]');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const subscriptionUrl = `http://127.0.0.1:${server.address().port}/private-token`;
  const before = await fetch(subscriptionUrl, { headers: { 'user-agent': LEGACY_SUBSCRIPTION_USER_AGENT } });
  assert.equal(before.status, 403);
  await before.text();
  for (const requestHeaders of [undefined, { 'user-agent': LEGACY_SUBSCRIPTION_USER_AGENT }, { 'User-Agent': LEGACY_SUBSCRIPTION_USER_AGENT }]) {
    assert.equal((await getVlessSubscriptionNodes({ subscriptionUrl, requestHeaders })).length, 1);
  }
  assert.deepEqual(seen.slice(1), ['clash.meta', 'clash.meta', 'clash.meta']);
});

test('preserves custom client and authentication headers without duplicate casing', () => {
  const headers = subscriptionHeaders({ 'user-agent': 'clash.meta', 'User-Agent': 'CustomClient/1', Authorization: 'test-only', 'X-Custom': 'demo' });
  assert.equal(headers['user-agent'], 'CustomClient/1');
  assert.equal(headers.authorization, 'test-only');
  assert.equal(headers['x-custom'], 'demo');
  assert.equal(Object.keys(headers).filter(key => key.toLowerCase() === 'user-agent').length, 1);
});

test('keeps non-UA HTTP 403 failures visible without exposing the response or URL', async t => {
  const server = createServer((_request, response) => { response.writeHead(403); response.end('secret-private-response'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(getVlessSubscriptionNodes({ subscriptionUrl: `http://127.0.0.1:${server.address().port}/secret-private-url` }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /IP 白名单/);
    assert.doesNotMatch(error.message, /secret-private/);
    return true;
  });
});

const serve = async (body) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/yaml' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/subscription` };
};

test('fetches and parses a Clash YAML subscription', async () => {
  const { server, url } = await serve(`
proxies:
  - name: Clash VLESS
    type: vless
    server: node.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    tls: true
`);

  try {
    const nodes = await getVlessSubscriptionNodes({ subscriptionUrl: url });
    assert.equal(nodes.length, 1);
    assert.match(nodes[0], /^vless:\/\/.*@node\.example\.com:443\?/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fetches and parses a Base64 encoded Clash subscription', async () => {
  const yaml = `
proxies:
  - name: Encoded Clash VLESS
    type: vless
    server: encoded.example.com
    port: 8443
    uuid: 22222222-2222-2222-2222-222222222222
`;
  const { server, url } = await serve(Buffer.from(yaml, 'utf8').toString('base64'));

  try {
    const nodes = await getVlessSubscriptionNodes({ subscriptionUrl: url });
    assert.equal(nodes.length, 1);
    assert.match(nodes[0], /^vless:\/\/.*@encoded\.example\.com:8443\?/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('preserves literal link punctuation, IPv6 and Base64 variants without scraping comments', () => {
  const link = 'vless://u@[2001:db8::1]:443?security=tls&alpn=h2,http/1.1#HK(1),end.';
  for (const body of [link, Buffer.from(link).toString('base64'), Buffer.from(link).toString('base64url')]) {
    assert.deepEqual(parseSubscriptionNodes(body), [link]);
  }
  assert.deepEqual(parseSubscriptionNodes(`# vless://secret@example.com:443\n${link}\r\n${link}`), [link]);
  assert.throws(() => parseSubscriptionNodes(`<html>${link}</html>`), /HTML/);
  assert.deepEqual(parseSubscriptionNodes(`proxies: []\n# ${link}`), []);
});

test('preserves JSON Reality, TLS, ALPN and encoded names through both backends', () => {
  const proxy = {
    name: '🇭🇰 HK, 100%20 (1)', type: 'vless', server: '2001:db8::1', port: 443, uuid: 'u',
    tls: true, servername: 'sni.example', 'skip-cert-verify': true, alpn: ['h2', 'http/1.1'],
    'client-fingerprint': 'chrome', flow: 'xtls-rprx-vision', 'packet-encoding': 'xudp',
    'reality-opts': { 'public-key': 'PUBLIC', 'short-id': '0012' },
  };
  const [link] = parseSubscriptionNodes(JSON.stringify({ proxies: [proxy, { type: 'ss' }], rules: ['MATCH,DIRECT'] }));
  const outbound = parseVlessNode(link, 0);
  assert.equal(outbound.tag, proxy.name);
  assert.equal(outbound.server, proxy.server);
  assert.equal(outbound.tls.insecure, true);
  assert.deepEqual(outbound.tls.alpn, proxy.alpn);
  const mapped = mapVlessToMihomoProxy(outbound, outbound.tag, { udpRelay: true, tcpFastOpen: false });
  for (const key of ['name', 'server', 'port', 'uuid', 'tls', 'servername', 'skip-cert-verify', 'alpn', 'client-fingerprint', 'flow', 'packet-encoding', 'reality-opts']) {
    assert.deepEqual(mapped[key], proxy[key], key);
  }
});

test('preserves unquoted Reality short IDs through YAML, JSON, Base64 and both backends', () => {
  for (const literal of ['0012', '0000000000000000', '9999999999999999', '1e10', '12', 'abcd', '"0012"']) {
    const expected = literal.replaceAll('"', '');
    const yaml = `proxies: [{type: vless, server: example.com, port: 443, uuid: u, reality-opts: {public-key: PUBLIC, short-id: ${literal}}}]`;
    const json = `{"proxies":[{"type":"vless","server":"example.com","port":443,"uuid":"u","reality-opts":{"public-key":"PUBLIC","short-id":${/^[1-9][0-9]*$/.test(literal) ? literal : JSON.stringify(expected)}}}]}`;
    for (const body of [yaml, json, Buffer.from(yaml).toString('base64')]) {
      const outbound = parseVlessNode(parseSubscriptionNodes(body)[0], 0);
      assert.equal(outbound.tls.reality.short_id, expected);
      assert.equal(mapVlessToMihomoProxy(outbound, 'demo', {})['reality-opts']['short-id'], expected);
      assert.equal(outbound.server_port, 443);
    }
  }
});

test('preserves numeric Reality short IDs in scalar aliases and merged maps', () => {
  const body = `
sid: &sid 0012
reality: &reality
  public-key: PUBLIC
  short-id: *sid
proxies:
  - type: vless
    server: example.com
    port: 443
    uuid: u
    reality-opts:
      <<: *reality
`;
  assert.equal(parseVlessNode(parseSubscriptionNodes(body)[0], 0).tls.reality.short_id, '0012');
  const anchored = `proxies:
  - &node {type: vless, server: example.com, port: 443, uuid: u, reality-opts: {public-key: PUBLIC, short-id: &sid 0012}}
  - <<: *node
    name: second
    reality-opts: {public-key: PUBLIC, short-id: *sid}
`;
  assert.deepEqual(parseSubscriptionNodes(anchored).map(link => parseVlessNode(link, 0).tls.reality.short_id), ['0012', '0012']);
});

test('rejects ambiguous numeric and non-text Reality short IDs without leaking content', () => {
  for (const literal of ['true', 'null', '-12', '+12', '1.2', '0x12', '[12]', '{secret: value}']) {
    const body = `proxies: [{type: vless, name: SECRET, server: example.com, port: 443, uuid: u, reality-opts: {public-key: PUBLIC, short-id: ${literal}}}]`;
    assert.throws(() => parseSubscriptionNodes(body), error => {
      assert.match(error.message, /short-id/);
      assert.doesNotMatch(error.message, /SECRET|PUBLIC|example/);
      return true;
    });
  }
});

test('handles Clash YAML anchors and preserves gRPC service and HTTP2 ALPN', () => {
  const [link] = parseSubscriptionNodes(`
defaults: &defaults
  type: vless
  server: grpc.example
  port: 443
  uuid: u
  tls: true
proxies:
  - <<: *defaults
    name: GRPC
    network: grpc
    grpc-opts:
      grpc-service-name: service
`);
  const outbound = parseVlessNode(link, 0);
  assert.deepEqual(outbound.tls.alpn, ['h2']);
  assert.equal(outbound.transport.service_name, 'service');
});

test('preserves WS early data and maps Clash HTTP Upgrade without confusing it with H2', () => {
  const proxy = {
    name: 'WS', type: 'vless', server: 'ws.example', port: 443, uuid: 'u', network: 'ws', tls: true,
    'ws-opts': { path: '/ws?x=1,2', headers: { Host: 'cdn.example' }, 'max-early-data': 2048, 'early-data-header-name': 'Sec-WebSocket-Protocol' },
  };
  const convert = () => parseVlessNode(parseSubscriptionNodes(JSON.stringify({ proxies: [proxy] }))[0], 0);
  const ws = convert();
  assert.equal(ws.transport.max_early_data, 2048);
  assert.equal(ws.tls.server_name, 'cdn.example');
  assert.deepEqual(mapVlessToMihomoProxy(ws, 'WS', {})['ws-opts'], proxy['ws-opts']);
  proxy['ws-opts'] = { path: '/up', headers: { Host: 'cdn.example' }, 'v2ray-http-upgrade': true };
  const upgraded = convert();
  assert.equal(upgraded.transport.type, 'httpupgrade');
  assert.deepEqual(mapVlessToMihomoProxy(upgraded, 'WS', {})['ws-opts'], proxy['ws-opts']);
  for (const network of ['http', 'h2', 'xhttp']) {
    proxy.network = network;
    assert.throws(convert, /network/);
  }
});

test('reports provider-only, malformed, and unrecognized content without echoing secrets', () => {
  const cases = [
    ['proxy-providers:\n  private: {url: "https://sub.example/SECRET"}', /provider/],
    ['proxies: [SECRET', /语法错误/],
    ['SECRET random response!', /无法识别/],
    [Buffer.from([255, 254, 253, 252]).toString('base64'), /Base64/],
    ['', /响应为空/],
  ];
  for (const [body, expected] of cases) {
    assert.throws(() => parseSubscriptionNodes(body), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
  const invalid = { type: 'vless', name: 'SECRET', server: 'node.example', port: 443 };
  assert.throws(() => parseSubscriptionNodes(JSON.stringify({ proxies: [invalid] })), /uuid/);
});

test('HTTP and fetch errors do not expose provider-controlled status text or URLs', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403, statusText: 'SECRET' }));
  const options = { subscriptionUrl: 'https://sub.example/private/SECRET?token=SECRET' };
  await assert.rejects(getVlessSubscriptionNodes(options), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  mock.mock.mockImplementation(async () => { throw new Error(options.subscriptionUrl); });
  await assert.rejects(getVlessSubscriptionNodes(options), (error) => {
    assert.match(error.message, /下载失败/);
    assert.doesNotMatch(error.message, /SECRET|private/);
    return true;
  });
});
