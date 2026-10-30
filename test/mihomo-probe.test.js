const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { createSocket } = require('node:dgram');
const { once } = require('node:events');
const test = require('node:test');
const { diagnoseMihomoNode } = require('../dist/mihomo/probe.js');

async function read(socket, size) {
  for (;;) {
    const bytes = socket.read(size);
    if (bytes) return bytes;
    if (socket.destroyed || socket.readableEnded) throw new Error('closed');
    await once(socket, 'readable');
  }
}

async function fixture(t, { fragment = false, mode = 'success', dnsMode = 'success' } = {}) {
  const sockets = new Set();
  let udpRequests = 0;
  const udp = createSocket('udp4');
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  udp.on('message', (packet, remote) => {
    udpRequests++;
    if (dnsMode === 'timeout') return;
    const reply = Buffer.from(packet);
    reply.writeUInt16BE(0x8180, 12);
    if (dnsMode === 'wrong-id') reply[10] ^= 1;
    if (dnsMode === 'wrong-question') reply[23] ^= 1;
    if (dnsMode === 'fragment') reply[2] = 1;
    if (dnsMode === 'wrong-origin') reply[4] = 1;
    udp.send(reply, remote.port, remote.address);
  });
  const send = async (socket, bytes) => {
    if (!fragment) return socket.write(bytes);
    for (const byte of bytes) {
      socket.write(Buffer.from([byte]));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    void (async () => {
      await read(socket, 3);
      if (mode === 'greeting-timeout') return;
      if (mode === 'authentication') return socket.end(Buffer.from([5, 2]));
      await send(socket, Buffer.from([5, 0]));
      const header = await read(socket, 4);
      if (header[3] === 1) await read(socket, 4);
      else if (header[3] === 3) await read(socket, (await read(socket, 1))[0]);
      await read(socket, 2);
      if (mode === 'outbound') return socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      const reply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
      reply.writeUInt16BE(udp.address().port, 8);
      await send(socket, reply);
      if (header[1] === 3) return;
      if (mode === 'http-timeout') { socket.resume(); return; }
      await read(socket, 1);
      socket.resume();
      if (mode === 'tls') return socket.end('invalid TLS private-token-value');
      socket.end(mode === 'http-error' ? 'HTTP/1.1 503 unavailable\r\nX-Secret: private-token-value\r\n\r\n' : 'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    })().catch(() => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    udp.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, udpRequests: () => udpRequests, socketCount: () => sockets.size };
}

test('Mihomo diagnostic traverses fragmented SOCKS replies and receives TCP and UDP responses', async (t) => {
  const backend = await fixture(t, { fragment: true });
  const result = await diagnoseMihomoNode({ port: backend.port, udpEnabled: true, tcpTarget: 'http://example.com/probe', timeoutMs: 1000 });
  assert.equal(result.tcp.success, true);
  assert.equal(result.udp.success, true);
  assert.equal(result.tcp.stage, 'complete');
  assert.equal(result.udp.stage, 'complete');
  assert.equal(backend.udpRequests(), 1);
  assert.ok(!Number.isNaN(Date.parse(result.testedAt)));
});

test('Mihomo diagnostic distinguishes disabled UDP from failure', async (t) => {
  const backend = await fixture(t);
  const result = await diagnoseMihomoNode({ port: backend.port, udpEnabled: false, tcpTarget: 'http://example.com' });
  assert.equal(result.tcp.success, true);
  assert.equal(result.udp.skipped, true);
  assert.equal(result.udp.stage, 'skipped');
  assert.equal(backend.udpRequests(), 0);
});

for (const [mode, stage] of [['authentication', 'authentication'], ['outbound', 'outbound'], ['http-error', 'http'], ['tls', 'tls'], ['greeting-timeout', 'authentication'], ['http-timeout', 'http']]) {
  test(`Mihomo diagnostic reports safe ${mode} failure`, async (t) => {
    const backend = await fixture(t, { mode });
    const result = await diagnoseMihomoNode({ port: backend.port, udpEnabled: false, tcpTarget: `${mode === 'tls' ? 'https' : 'http'}://example.com`, timeoutMs: 150 });
    assert.equal(result.tcp.success, false);
    assert.equal(result.tcp.stage, stage);
    assert.ok(result.tcp.latencyMs < 1500);
    assert.doesNotMatch(JSON.stringify(result), /private-token-value/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(backend.socketCount(), 0);
  });
}

for (const dnsMode of ['wrong-id', 'wrong-question', 'fragment', 'wrong-origin', 'timeout']) {
  test(`Mihomo diagnostic rejects ${dnsMode} UDP response`, async (t) => {
    const backend = await fixture(t, { dnsMode });
    const result = await diagnoseMihomoNode({ port: backend.port, udpEnabled: true, tcpTarget: 'http://example.com', timeoutMs: 150 });
    assert.equal(result.tcp.success, true);
    assert.equal(result.udp.success, false);
    assert.equal(result.udp.stage, dnsMode === 'timeout' ? 'udp_outbound' : 'dns');
    assert.ok(result.udp.latencyMs < 1500);
  });
}

test('Mihomo diagnostic rejects invalid targets without echoing supplied credentials', async () => {
  for (const options of [
    { port: -1 },
    { timeoutMs: 0 },
    { tcpTarget: 'http://user:private-token-value@example.com' },
    { tcpTarget: 'file:///private-token-value' },
    { udpTarget: 'a@999.0.0.1' },
    { udpTarget: 'a@8.8.8.8@private-token-value' },
  ]) {
    await assert.rejects(diagnoseMihomoNode({ port: 12345, udpEnabled: true, ...options }), (error) => {
      assert.doesNotMatch(error.message, /private-token-value/);
      return true;
    });
  }
});

test('Mihomo diagnostic reports a closed local listener as gateway failure', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const result = await diagnoseMihomoNode({ port, udpEnabled: true, timeoutMs: 150 });
  assert.equal(result.tcp.stage, 'gateway');
  assert.equal(result.udp.stage, 'gateway');
});
