const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { parse } = require('yaml');
const { planStablePorts, stableNodeIdentity, stablePortFile } = require('../dist/utils/stable-ports.js');
const { syncSubscriptionToSurge } = require('../dist/surge.js');
const { syncMihomoToSurge } = require('../dist/mihomo/sync.js');
const { cleanMihomoArtifacts } = require('../dist/mihomo/sync.js');
const surgeCli = require('../dist/utils/surge-cli.js');
const { makeConfig, subscriptionUrl, vlessLink } = require('./helpers.js');

const identity = name => stableNodeIdentity({ name, server: 'example.com', serverPort: 443, uuid: name });

test('port plans preserve identities on reorder and skip occupied new ports without writing until committed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'svb-port-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = stablePortFile(root, 'external');
  const ids = ['a', 'b', 'c'].map(identity);
  const options = { filePath, portStart: 41000, available: async port => port !== 41001 };
  const first = await planStablePorts({ ...options, identities: ids.slice(0, 2) });
  assert.deepEqual(first.ports, [41000, 41002]);
  assert.deepEqual(await readdir(root), []);
  await first.commit();
  const reordered = await planStablePorts({ ...options, identities: [ids[1], ids[2], ids[0]] });
  assert.deepEqual(reordered.ports, [41002, 41003, 41000]);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).entries.length, 2);
  await reordered.commit();
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const moved = await planStablePorts({ ...options, portStart: 42000, identities: ids });
  assert.deepEqual(moved.ports, [42000, 42001, 42002]);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /example\.com/);
});

test('port migration retains old generated assignments and refuses corrupt maps or occupied orphan assignments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'svb-port-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = stablePortFile(root, 'mihomo');
  const id = identity('a');
  const plan = await planStablePorts({ filePath, portStart: 40000, identities: [id], previous: [{ id, port: 40017 }], available: async () => false });
  assert.deepEqual(plan.ports, [40017]);
  await plan.commit();
  await assert.rejects(planStablePorts({ filePath, portStart: 40000, identities: [id], available: async () => false }), /占用/);
  await writeFile(filePath, '{}');
  await assert.rejects(planStablePorts({ filePath, portStart: 40000, identities: [id] }), /端口记录/);
});

test('External preserves endpoint ports after reorder, addition and migration and leaves plans untouched on rejected previews', async t => {
  const { root, config } = await makeConfig('stable-external');
  t.after(() => rm(root, { recursive: true, force: true }));
  const check = t.mock.method(surgeCli, 'validateSurgeProfile', async () => ({ checked: true }));
  config.portStart = 43000;
  const a = vlessLink(1, 'A'); const b = vlessLink(2, 'B'); const c = vlessLink(3, 'C');
  config.subscriptionUrls = [subscriptionUrl([a, b])];
  await syncSubscriptionToSurge(config);
  const map = stablePortFile(config.outputDir, 'external');
  const before = await readFile(config.surgeConfigPath, 'utf8');
  const previousPorts = Object.fromEntries([...before.matchAll(/^(\w+) = external, .*local-port=(\d+)/gm)].map(match => [match[1], Number(match[2])]));
  await rm(map);
  config.subscriptionUrls = [subscriptionUrl([b, c, a])];
  const preview = await syncSubscriptionToSurge(config, { dryRun: true });
  assert.deepEqual(preview.preview.nodes.filter(node => node.name !== 'C').map(node => [node.name, node.port]), [['A', previousPorts.A], ['B', previousPorts.B]]);
  await assert.rejects(readFile(map), { code: 'ENOENT' });
  await syncSubscriptionToSurge(config);
  const committed = await readFile(map, 'utf8');
  const profile = await readFile(config.surgeConfigPath, 'utf8');
  check.mock.mockImplementation(async () => { throw new Error('native check rejected'); });
  config.subscriptionUrls = [subscriptionUrl([a, vlessLink(4, 'D')])];
  await assert.rejects(syncSubscriptionToSurge(config), /native check/);
  assert.equal(await readFile(map, 'utf8'), committed);
  assert.equal(await readFile(config.surgeConfigPath, 'utf8'), profile);
});

const mihomoFixture = async t => {
  const { root, config } = await makeConfig('stable-mihomo');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(surgeCli, 'validateSurgeProfile', async () => ({ checked: true }));
  config.runtimeMode = 'mihomo';
  config.portStart = 45000;
  config.mihomo.binary = '/usr/bin/true';
  config.mihomo.dataDir = join(root, 'mihomo');
  config.vlessNodes = [vlessLink(1, 'A'), vlessLink(2, 'B')];
  let running = false;
  let starts = 0;
  let checks = 0;
  let healthy = true;
  const status = async () => ({ installed: running, loaded: running, pid: running ? 123 : undefined, controllerReady: running, serviceMatchesConfig: running, runningVersion: '1.0.0' });
  const operations = {
    status, wait: status, readVersion: async () => '1.0.0', definitionMatches: async () => true,
    start: async () => { starts++; running = true; healthy = true; return 'test.plist'; },
    stop: async () => { running = false; },
    verify: async () => { checks++; if (!healthy) throw new Error('stale runtime'); },
  };
  return { root, config, operations, starts: () => starts, checks: () => checks, unhealthy: () => { healthy = false; } };
};

test('Mihomo unchanged and reordered subscriptions verify runtime without rewriting config, profile or restarting', async t => {
  const f = await mihomoFixture(t);
  await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(f.starts(), 1);
  const configPath = join(f.config.mihomo.dataDir, 'config.yaml');
  const beforeConfig = await readFile(configPath, 'utf8');
  const beforeProfile = await readFile(f.config.surgeConfigPath, 'utf8');
  const configMtime = (await stat(configPath)).mtimeMs;
  const profileMtime = (await stat(f.config.surgeConfigPath)).mtimeMs;
  f.config.vlessNodes.reverse();
  const result = await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(result.unchanged, true);
  assert.equal(result.backupPath, undefined);
  assert.equal(f.starts(), 1);
  assert.equal(f.checks(), 2);
  assert.equal(await readFile(configPath, 'utf8'), beforeConfig);
  assert.equal(await readFile(f.config.surgeConfigPath, 'utf8'), beforeProfile);
  assert.equal((await stat(configPath)).mtimeMs, configMtime);
  assert.equal((await stat(f.config.surgeConfigPath)).mtimeMs, profileMtime);
  const doc = parse(beforeConfig);
  assert.deepEqual(doc.listeners.map(node => node.proxy), ['A', 'B']);
  f.config.tcpFastOpen = true;
  await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(f.starts(), 2);
});

test('Mihomo repairs unhealthy unchanged runtime and refuses an unrelated controller', async t => {
  const f = await mihomoFixture(t);
  await syncMihomoToSurge(f.config, { operations: f.operations });
  f.unhealthy();
  await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(f.starts(), 2);
  await assert.rejects(syncMihomoToSurge(f.config, { operations: { ...f.operations,
    status: async () => ({ installed: false, loaded: false, controllerReady: true }),
  } }), /未确认归属/);
  assert.equal(f.starts(), 2);
});

test('Mihomo failed start does not commit a new allocation', async t => {
  const f = await mihomoFixture(t);
  await mkdir(f.config.mihomo.dataDir, { recursive: true });
  await writeFile(join(f.config.mihomo.dataDir, 'config.previous.yaml'), 'stale previous config');
  await assert.rejects(syncMihomoToSurge(f.config, { operations: { ...f.operations,
    start: async () => { throw new Error('startup failed'); },
  } }), /startup failed/);
  await assert.rejects(readFile(stablePortFile(f.config.outputDir, 'mihomo')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.config.mihomo.dataDir, 'config.yaml')), { code: 'ENOENT' });
});

test('Mihomo unchanged-runtime persistence failure restores the previous profile without restarting', async t => {
  const f = await mihomoFixture(t);
  await syncMihomoToSurge(f.config, { operations: f.operations });
  const before = await readFile(f.config.surgeConfigPath, 'utf8');
  const mapPath = stablePortFile(f.config.outputDir, 'mihomo');
  await rm(mapPath);
  f.config.policyGroupName = 'Changed';
  const fsUtils = require('../dist/utils/fs.js');
  const write = fsUtils.writeTextFile;
  t.mock.method(fsUtils, 'writeTextFile', async (path, value) => {
    if (path === mapPath) throw new Error('disk write failed');
    return write(path, value);
  });
  await assert.rejects(syncMihomoToSurge(f.config, { operations: f.operations }), /disk write failed/);
  assert.equal(await readFile(f.config.surgeConfigPath, 'utf8'), before);
  assert.equal(f.starts(), 1);
  await assert.rejects(readFile(mapPath), { code: 'ENOENT' });
});

test('preview reports missing native Surge verification without claiming both validators passed', async t => {
  const f = await mihomoFixture(t);
  t.mock.method(surgeCli, 'validateSurgeProfile', async () => ({ checked: false, warning: 'Surge native check unavailable' }));
  const result = await syncMihomoToSurge(f.config, { dryRun: true, operations: f.operations });
  assert.match(result.preview.validationSummary, /Surge native check unavailable/);
  assert.equal(f.starts(), 0);
});

test('Mihomo cleanup validates the candidate before stopping the service', async t => {
  const f = await mihomoFixture(t);
  t.mock.method(surgeCli, 'validateSurgeProfile', async () => { throw new Error('invalid Surge profile'); });
  let stopped = false;
  await assert.rejects(cleanMihomoArtifacts(f.config, { stopService: async () => { stopped = true; } }), /invalid Surge/);
  assert.equal(stopped, false);
});

test('duplicate-name additions preserve existing node names and ports without colliding with explicit suffixes', async t => {
  const { root, config } = await makeConfig('stable-duplicates');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(surgeCli, 'validateSurgeProfile', async () => ({ checked: true }));
  config.portStart = 47000;
  config.vlessNodes = [vlessLink(1, 'HK'), vlessLink(2, 'HK'), vlessLink(3, 'HK 2')];
  await syncSubscriptionToSurge(config);
  const readNodes = async () => {
    const files = (await readdir(config.outputDir)).filter(file => /^sing-box\[/.test(file));
    return Promise.all(files.map(async file => {
      const node = JSON.parse(await readFile(join(config.outputDir, file), 'utf8')).outbounds[0];
      return { uuid: node.uuid, name: node.tag, file };
    }));
  };
  const before = await readNodes();
  assert.equal(new Set(before.map(node => node.name)).size, 3);
  config.vlessNodes = [vlessLink(4, 'HK'), ...config.vlessNodes.reverse()];
  await syncSubscriptionToSurge(config);
  const after = await readNodes();
  for (const node of before) assert.deepEqual(after.find(entry => entry.uuid === node.uuid), node);
  assert.equal(new Set(after.map(node => node.name)).size, 4);
});

test('External unnamed links preserve legacy numbered names and ports across reorder and generate deterministic new names', async t => {
  const { root, config } = await makeConfig('stable-unnamed-external');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(surgeCli, 'validateSurgeProfile', async () => ({ checked: true }));
  config.portStart = 48000;
  config.vlessNodes = [vlessLink(1, 'vless-1'), vlessLink(2, 'vless-2')];
  await syncSubscriptionToSurge(config);
  const before = await readFile(config.surgeConfigPath, 'utf8');
  await rm(stablePortFile(config.outputDir, 'external'));
  config.vlessNodes = [vlessLink(2, ''), vlessLink(1, '')];
  await syncSubscriptionToSurge(config);
  assert.equal(await readFile(config.surgeConfigPath, 'utf8'), before);
  config.vlessNodes.unshift(vlessLink(3, ' '));
  await syncSubscriptionToSurge(config);
  const added = await readFile(config.surgeConfigPath, 'utf8');
  assert.match(added, /^vless-[a-f0-9]{12} = external/m);
  config.vlessNodes.reverse();
  await syncSubscriptionToSurge(config);
  assert.equal(await readFile(config.surgeConfigPath, 'utf8'), added);
});

test('Mihomo unnamed links migrate legacy names and preserve runtime config on reorder', async t => {
  const f = await mihomoFixture(t);
  f.config.vlessNodes = [vlessLink(1, 'vless-1'), vlessLink(2, 'vless-2')];
  await syncMihomoToSurge(f.config, { operations: f.operations });
  const configPath = join(f.config.mihomo.dataDir, 'config.yaml');
  const before = await readFile(configPath, 'utf8');
  await rm(stablePortFile(f.config.outputDir, 'mihomo'));
  f.config.vlessNodes = [vlessLink(2, ''), vlessLink(1, '')];
  const migrated = await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(migrated.unchanged, true);
  assert.equal(await readFile(configPath, 'utf8'), before);
  assert.equal(f.starts(), 1);
  f.config.vlessNodes.unshift(vlessLink(3, ''));
  await syncMihomoToSurge(f.config, { operations: f.operations });
  const added = await readFile(configPath, 'utf8');
  assert.match(added, /name: vless-[a-f0-9]{12}/);
  f.config.vlessNodes.reverse();
  await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(await readFile(configPath, 'utf8'), added);
  assert.equal(f.starts(), 2);
});

const variantLink = variant => `${vlessLink(1, 'Same').split('#')[0]}&type=ws&path=/${variant}#Same`;

test('External same-name and same-endpoint transport variants never exchange their ports', async t => {
  const { root, config } = await makeConfig('stable-transport-external');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(surgeCli, 'validateSurgeProfile', async () => ({ checked: true }));
  config.portStart = 49000;
  config.vlessNodes = [variantLink('one'), variantLink('two')];
  const snapshot = async () => {
    const files = (await readdir(config.outputDir)).filter(file => /^sing-box\[/.test(file));
    const entries = await Promise.all(files.map(async file => {
      const node = JSON.parse(await readFile(join(config.outputDir, file), 'utf8')).outbounds[0];
      return [node.transport.path, { name: node.tag, file }];
    }));
    return Object.fromEntries(entries);
  };
  await syncSubscriptionToSurge(config);
  const before = await snapshot();
  await rm(stablePortFile(config.outputDir, 'external'));
  config.vlessNodes.reverse();
  await syncSubscriptionToSurge(config);
  assert.deepEqual(await snapshot(), before);
  config.vlessNodes.unshift(variantLink('zero'));
  await syncSubscriptionToSurge(config);
  const added = await snapshot();
  for (const variant of ['/one', '/two']) assert.deepEqual(added[variant], before[variant]);
});

test('Mihomo same-name and same-endpoint transport variants retain correct names and listeners', async t => {
  const f = await mihomoFixture(t);
  f.config.vlessNodes = [variantLink('one'), variantLink('two')];
  const configPath = join(f.config.mihomo.dataDir, 'config.yaml');
  const snapshot = async () => {
    const document = parse(await readFile(configPath, 'utf8'));
    return Object.fromEntries(document.proxies.map(proxy => [proxy['ws-opts'].path,
      { name: proxy.name, port: document.listeners.find(listener => listener.proxy === proxy.name).port }]));
  };
  await syncMihomoToSurge(f.config, { operations: f.operations });
  const before = await snapshot();
  await rm(stablePortFile(f.config.outputDir, 'mihomo'));
  f.config.vlessNodes.reverse();
  const reordered = await syncMihomoToSurge(f.config, { operations: f.operations });
  assert.equal(reordered.unchanged, true);
  assert.deepEqual(await snapshot(), before);
  assert.equal(f.starts(), 1);
  f.config.vlessNodes.unshift(variantLink('zero'));
  await syncMihomoToSurge(f.config, { operations: f.operations });
  const added = await snapshot();
  for (const variant of ['/one', '/two']) assert.deepEqual(added[variant], before[variant]);
});
