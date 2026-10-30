const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const { getVlessSubscriptionNodes, parseSubscriptionNodes } = require('../dist/parse.js');
const { parseVlessNode } = require('../dist/utils/parse-vless-node.js');
const { mapVlessToMihomoProxy } = require('../dist/mihomo/config.js');

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
