const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { loadCliConfig } = require('../dist/configuration.js');
const { DesktopService } = require('../dist/desktop/service.js');
const { collectVlessNodes, runCommonDoctorChecks } = require('../dist/surge.js');
const { parseSubscriptionNodes } = require('../dist/parse.js');
const { readSubscriptionCache, readSubscriptionStatuses } = require('../dist/utils/subscription-cache.js');
const { filterSubscriptionNodes, normalizeSubscriptionOptions } = require('../dist/utils/subscription-options.js');
const { makeConfig, vlessLink } = require('./helpers.js');

const supported = { type: 'vless', server: 'example.com', port: 443, uuid: 'u', name: 'JP valid' };
const incompatible = { ...supported, name: 'SECRET', 'dialer-proxy': 'SECRET-UPSTREAM' };
const payload = JSON.stringify({ proxies: [supported, incompatible] });

const fixture = async t => {
  const { root, config } = await makeConfig('subscription-controls');
  let body = [vlessLink(1, 'HK A'), vlessLink(2, 'HK B'), vlessLink(3, 'JP C')].join('\n');
  let code = 200;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(code);
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.subscriptionUrls = [`http://127.0.0.1:${server.address().port}/private-token`];
  config.subscriptionOptions = [normalizeSubscriptionOptions()];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, setBody: value => { body = value; }, setCode: value => { code = value; }, requests: () => requests };
};

test('name filters are literal, case insensitive and exclusion wins', () => {
  const links = [vlessLink(1, 'HK [01]'), vlessLink(2, 'HK 02'), vlessLink(3, 'JP')];
  assert.deepEqual(filterSubscriptionNodes(links, normalizeSubscriptionOptions({ include: 'hk', exclude: '02' })), [links[0]]);
  assert.deepEqual(filterSubscriptionNodes(links, normalizeSubscriptionOptions({ include: '[01]' })), [links[0]]);
  assert.deepEqual(filterSubscriptionNodes(links, normalizeSubscriptionOptions({ enabled: false })), []);
});

test('unsupported Clash nodes require opt-in and report only safe reasons', () => {
  assert.throws(() => parseSubscriptionNodes(payload), /dialer-proxy/);
  const reasons = [];
  const nodes = parseSubscriptionNodes(payload, { skipUnsupported: true, onSkipped: reason => reasons.push(reason) });
  assert.equal(nodes.length, 1);
  assert.match(reasons[0], /第 2 个节点.*dialer-proxy/);
  assert.doesNotMatch(reasons.join('\n'), /SECRET|example|uuid/);
  assert.throws(() => parseSubscriptionNodes(JSON.stringify({ proxies: [incompatible] }), { skipUnsupported: true }), /没有可用/);
  assert.throws(() => parseSubscriptionNodes(JSON.stringify({ proxies: [supported, { ...supported, port: 0 }] }), { skipUnsupported: true }), /port/);
  assert.throws(() => parseSubscriptionNodes('proxies: [', { skipUnsupported: true }), /语法错误/);
});

test('filters retain a full snapshot and disabling retains cache without fetching', async t => {
  const f = await fixture(t);
  f.config.subscriptionOptions[0].include = 'HK';
  assert.equal((await collectVlessNodes(f.config)).length, 2);
  assert.equal((await readSubscriptionCache(f.config, f.config.subscriptionUrls[0])).nodes.length, 3);
  const statuses = await readSubscriptionStatuses(f.config, f.config.subscriptionUrls);
  assert.equal(statuses[0].sourceCount, 3);
  assert.equal(statuses[0].filteredCount, 1);
  f.config.subscriptionOptions[0].enabled = false;
  f.config.vlessNodes = [vlessLink(4, 'Direct')];
  const before = f.requests();
  assert.deepEqual(await collectVlessNodes(f.config), f.config.vlessNodes);
  assert.equal(f.requests(), before);
  assert.equal((await readSubscriptionCache(f.config, f.config.subscriptionUrls[0])).nodes.length, 3);
  f.config.subscriptionOptions[0] = normalizeSubscriptionOptions();
  f.setCode(503);
  assert.equal((await collectVlessNodes(f.config)).length, 4);
});

test('partial caches cannot silently bypass a later strict import', async t => {
  const f = await fixture(t);
  f.setBody(payload);
  f.config.subscriptionOptions[0].skipUnsupported = true;
  assert.equal((await collectVlessNodes(f.config)).length, 1);
  const cache = await readSubscriptionCache(f.config, f.config.subscriptionUrls[0]);
  assert.equal(cache.sourceCount, 2);
  assert.equal(cache.skippedCount, 1);
  f.config.subscriptionOptions[0].skipUnsupported = false;
  await assert.rejects(collectVlessNodes(f.config), /No VLESS nodes/);
  assert.equal((await readSubscriptionStatuses(f.config, f.config.subscriptionUrls))[0].state, 'failed');
  f.setCode(503);
  f.config.subscriptionOptions[0].skipUnsupported = true;
  assert.equal((await collectVlessNodes(f.config)).length, 1);
});

test('zero matches refuse replacement while preserving the unfiltered snapshot', async t => {
  const f = await fixture(t);
  f.config.subscriptionOptions[0].include = 'does-not-exist';
  const profile = await readFile(f.config.surgeConfigPath, 'utf8');
  await assert.rejects(collectVlessNodes(f.config), /筛选后没有匹配/);
  assert.equal(await readFile(f.config.surgeConfigPath, 'utf8'), profile);
  assert.equal((await readSubscriptionCache(f.config, f.config.subscriptionUrls[0])).nodes.length, 3);
});

test('doctor reports no usable source when all subscriptions are disabled', async t => {
  const f = await fixture(t);
  f.config.subscriptionOptions[0].enabled = false;
  const checks = await runCommonDoctorChecks(f.config);
  const sources = checks.find(check => check.label === 'nodeSources');
  assert.equal(sources.level, 'fail');
  assert.match(sources.detail, /^0 active subscription URLs, 0 direct VLESS nodes$/);
  assert.equal(f.requests(), 0);
});

test('config normalization keeps options aligned when blank source rows are removed', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.root, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...f.config, subscriptionUrls: ['', f.config.subscriptionUrls[0]],
    subscriptionOptions: [{ enabled: false }, { include: ' HK ', skipUnsupported: true }] }));
  const { config } = await loadCliConfig({ configPath, cwd: f.root });
  assert.equal(config.subscriptionUrls.length, 1);
  assert.deepEqual(config.subscriptionOptions, [normalizeSubscriptionOptions({ include: 'HK', skipUnsupported: true })]);
});

test('desktop filtering preview uses private cache without fetching and wizard saves retain options', async t => {
  const f = await fixture(t);
  await collectVlessNodes(f.config);
  const configPath = path.join(f.root, 'config.json');
  f.config.subscriptionOptions[0] = normalizeSubscriptionOptions({ include: 'HK', enabled: false });
  await writeFile(configPath, JSON.stringify(f.config));
  const service = new DesktopService({ configPath, executablePath: process.execPath, scheduledEntryPath: '/unused' });
  service.getState = async () => ({});
  const before = f.requests();
  assert.deepEqual(await service.previewSourceFilters({ subscriptionUrl: f.config.subscriptionUrls[0], options: normalizeSubscriptionOptions({ include: 'hk', exclude: 'B' }) }),
    { available: true, total: 3, matched: 1, skipped: 0 });
  assert.equal(f.requests(), before);
  await service.saveSources({ subscriptionUrls: f.config.subscriptionUrls, subscriptionNames: ['Renamed'], vlessNodes: [] });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.subscriptionOptions, f.config.subscriptionOptions);
  assert.ok(await readSubscriptionCache(f.config, f.config.subscriptionUrls[0]));
  await service.saveSources({ subscriptionUrls: [], vlessNodes: [] });
  assert.equal(await readSubscriptionCache(f.config, f.config.subscriptionUrls[0]), undefined);
});
