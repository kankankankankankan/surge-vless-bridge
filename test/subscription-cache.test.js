const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readdir, readFile, stat, rm } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { collectVlessNodes, syncSubscriptionToSurge } = require('../dist/surge.js');
const { withBridgeOperation, withDirectoryLock } = require('../dist/utils/operation-lock.js');
const { readSubscriptionStatuses, pruneSubscriptionCache } = require('../dist/utils/subscription-cache.js');
const { makeConfig, vlessLink } = require('./helpers.js');

const fixture = async (t) => {
  const { root, config } = await makeConfig('cache');
  const responses = new Map([
    ['/private-a', { code: 200, body: vlessLink(1, 'A') }],
    ['/private-b', { code: 200, body: vlessLink(2, 'B') }],
  ]);
  const server = createServer((req, res) => {
    const response = responses.get(req.url);
    res.writeHead(response.code);
    res.end(response.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.subscriptionUrls = [...responses.keys()].map(route => `http://127.0.0.1:${server.address().port}${route}`);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, responses };
};

test('failed source retains its own successful nodes while another updates', async t => {
  const { config, responses } = await fixture(t);
  await syncSubscriptionToSurge(config);
  responses.set('/private-a', { code: 503, body: 'private-a credential' });
  responses.set('/private-b', { code: 200, body: vlessLink(3, 'B-new') });
  const nodes = await collectVlessNodes(config);
  assert.deepEqual(nodes, [vlessLink(1, 'A'), vlessLink(3, 'B-new')]);
  await syncSubscriptionToSurge(config);
  const profile = await readFile(config.surgeConfigPath, 'utf8');
  assert.match(profile, /^A = external/m);
  assert.match(profile, /^B-new = external/m);
  assert.doesNotMatch(profile, /^B = external/m);
  const statuses = await readSubscriptionStatuses(config, config.subscriptionUrls);
  assert.equal(statuses[0].state, 'cached');
  assert.ok(statuses[0].lastSuccessAt);
  assert.match(statuses[0].detail, /503/);
  assert.doesNotMatch(JSON.stringify(statuses), /private-a|credential|vless:\/\//);
  responses.set('/private-a', { code: 200, body: vlessLink(4, 'A-new') });
  assert.deepEqual(await collectVlessNodes(config), [vlessLink(4, 'A-new'), vlessLink(3, 'B-new')]);
  assert.equal((await readSubscriptionStatuses(config, config.subscriptionUrls))[0].state, 'fresh');
});

test('valid empty document clears prior nodes and never resurrects them on failure', async t => {
  const { config, responses } = await fixture(t);
  await collectVlessNodes(config);
  responses.set('/private-a', { code: 200, body: 'proxies: []' });
  assert.deepEqual(await collectVlessNodes(config), [vlessLink(2, 'B')]);
  responses.set('/private-a', { code: 500, body: 'error' });
  assert.deepEqual(await collectVlessNodes(config), [vlessLink(2, 'B')]);
});

test('cache is private, source-keyed and removed on explicit source removal', async t => {
  const { config, responses } = await fixture(t);
  await collectVlessNodes(config);
  const dir = path.join(config.outputDir, '.subscription-cache');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const files = await readdir(dir);
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.match(file, /^[a-f0-9]{64}\.json$/);
    assert.equal((await stat(path.join(dir, file))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path.join(dir, file), 'utf8'), /private-a|private-b/);
  }
  const removed = config.subscriptionUrls.shift();
  await pruneSubscriptionCache(config, config.subscriptionUrls);
  assert.equal((await readdir(dir)).length, 1);
  config.subscriptionUrls.unshift(removed);
  responses.set('/private-a', { code: 500, body: 'error' });
  assert.deepEqual(await collectVlessNodes(config), [vlessLink(2, 'B')]);
  assert.equal((await readSubscriptionStatuses(config, config.subscriptionUrls))[0].state, 'failed');
});

test('invalid new payload does not overwrite a valid cache', async t => {
  const { config, responses } = await fixture(t);
  await collectVlessNodes(config);
  responses.set('/private-a', { code: 200, body: '<html>private error</html>' });
  assert.deepEqual(await collectVlessNodes(config), [vlessLink(1, 'A'), vlessLink(2, 'B')]);
  assert.equal((await readSubscriptionStatuses(config, config.subscriptionUrls))[0].state, 'cached');
});

test('cold failures do not modify the Surge profile', async t => {
  const { config, responses } = await fixture(t);
  for (const route of responses.keys()) responses.set(route, { code: 403, body: 'secret' });
  const before = await readFile(config.surgeConfigPath, 'utf8');
  await assert.rejects(syncSubscriptionToSurge(config), /No VLESS nodes/);
  assert.equal(await readFile(config.surgeConfigPath, 'utf8'), before);
});

test('overlapping collection cannot replace another task cache, locks release on failure', async t => {
  const { config } = await fixture(t);
  await withDirectoryLock(path.join(config.outputDir, '.subscription-operation.lock'), async () => {
    await assert.rejects(collectVlessNodes(config), /已有同步/);
  });
  assert.equal((await collectVlessNodes(config)).length, 2);
  await assert.rejects(withBridgeOperation(config, async () => {
    await assert.rejects(withBridgeOperation(config, async () => undefined), /已有同步/);
    throw new Error('fixture');
  }), /fixture/);
  assert.equal(await withBridgeOperation(config, async () => 'released'), 'released');
});
