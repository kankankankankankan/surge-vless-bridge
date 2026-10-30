const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const test = require('node:test');

const { getVlessSubscriptionNodes } = require('../dist/parse.js');

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
