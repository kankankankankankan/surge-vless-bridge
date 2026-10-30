const assert = require('node:assert/strict');
const test = require('node:test');

const { parseClashVlessNodes } = require('../dist/utils/parse-clash-vless.js');

test('converts Clash VLESS YAML into a VLESS link', () => {
  const [node] = parseClashVlessNodes(`
proxies:
  - name: 🇭🇰 Hong Kong
    type: vless
    server: hk.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    tls: true
    servername: hk.example.com
    network: ws
    ws-opts:
      path: /ray
      headers:
        Host: cdn.example.com
`);

  assert.ok(node.startsWith('vless://'));
  const url = new URL(node);
  assert.equal(decodeURIComponent(url.hash.slice(1)), '🇭🇰 Hong Kong');
  assert.equal(url.hostname, 'hk.example.com');
  assert.equal(url.searchParams.get('security'), 'tls');
  assert.equal(url.searchParams.get('type'), 'ws');
  assert.equal(url.searchParams.get('path'), '/ray');
  assert.equal(url.searchParams.get('host'), 'cdn.example.com');
});

test('converts Clash Reality and gRPC options', () => {
  const [node] = parseClashVlessNodes(`
proxies:
  - name: Reality
    type: vless
    server: 2001:db8::1
    port: 443
    uuid: u
    flow: xtls-rprx-vision
    network: grpc
    tls: true
    reality-opts:
      public-key: public-key
      short-id: abcd
    grpc-opts:
      grpc-service-name: edge
`);

  const url = new URL(node);
  assert.equal(url.hostname, '[2001:db8::1]');
  assert.equal(url.searchParams.get('security'), 'reality');
  assert.equal(url.searchParams.get('pbk'), 'public-key');
  assert.equal(url.searchParams.get('sid'), 'abcd');
  assert.equal(url.searchParams.get('flow'), 'xtls-rprx-vision');
  assert.equal(url.searchParams.get('type'), 'grpc');
  assert.equal(url.searchParams.get('serviceName'), 'edge');
});
