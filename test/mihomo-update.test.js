const assert = require('node:assert/strict');
const { mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { installAndVerifyMihomo } = require('../dist/mihomo/update.js');
const { matchesMihomoLaunchService } = require('../dist/mihomo/launch-agent.js');
const { installOfficialMihomo } = require('../dist/mihomo/dependencies.js');
const { makeConfig } = require('./helpers.js');

async function fixture(t, running = true) {
  const { root, config } = await makeConfig('mihomo-update');
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'bin');
  await mkdir(installDir);
  config.mihomo = { ...config.mihomo, binary: path.join(installDir, 'mihomo'), dataDir: path.join(root, 'mihomo') };
  await mkdir(config.mihomo.dataDir);
  await writeFile(path.join(config.mihomo.dataDir, 'config.yaml'), 'proxies: []\n');
  await writeFile(config.mihomo.binary, 'old-binary');
  await writeFile(`${config.mihomo.binary}.previous`, 'older-binary');
  const events = [];
  const options = { config, installDir, method: 'direct', saveBinaryPath: async (binary) => events.push(`save:${binary}`) };
  const operations = {
    status: async () => ({ loaded: running, pid: running ? 12345 : undefined, installed: true,
      controllerReady: running, serviceMatchesConfig: true }),
    readVersion: async () => '1.0.0',
    validate: async () => events.push('validate'),
    restart: async (next) => { events.push(`restart:${next.mihomo.binary}`); },
    stop: async () => events.push('stop'),
    verify: async (_, version) => events.push(`verify:${version}`),
    installOfficial: async (_, __, validate) => {
      events.push('install');
      await validate('candidate');
      await writeFile(config.mihomo.binary, 'new-binary');
      await writeFile(`${config.mihomo.binary}.previous`, 'old-binary');
      return { path: config.mihomo.binary, version: '2.0.0', output: 'installed' };
    },
  };
  return { options, operations, events, config, root, installDir };
}

test('managed Mihomo update verifies old identity and new runtime before saving', async (t) => {
  const f = await fixture(t);
  const result = await installAndVerifyMihomo(f.options, f.operations);
  assert.equal(result.runtimeVerified, true);
  assert.deepEqual(f.events, ['verify:1.0.0', 'install', 'validate', `restart:${f.config.mihomo.binary}`,
    'verify:2.0.0', `save:${f.config.mihomo.binary}`]);
  assert.equal(await readFile(f.config.mihomo.binary, 'utf8'), 'new-binary');
  assert.equal((await readdir(f.installDir)).includes('.mihomo-update.lock'), false);
});

test('failed runtime verification restores exact binary and rollback slot before restarting', async (t) => {
  const f = await fixture(t);
  f.operations.verify = async (_, version) => {
    f.events.push(`verify:${version}`);
    if (version === '2.0.0') throw new Error('private upstream detail');
    assert.equal(await readFile(f.config.mihomo.binary, 'utf8'), 'old-binary');
  };
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /已恢复更新前文件和服务状态/);
  assert.equal(await readFile(`${f.config.mihomo.binary}.previous`, 'utf8'), 'older-binary');
  assert.equal(f.events.some((item) => item.startsWith('save:')), false);
  assert.deepEqual(f.events.slice(-3), ['stop', `restart:${f.config.mihomo.binary}`, 'verify:1.0.0']);
});

test('save failure restores old custom binary path and running service', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.root, 'custom-mihomo');
  f.config.mihomo.binary = original;
  await writeFile(original, 'custom-binary');
  const managed = path.join(f.installDir, 'mihomo');
  f.operations.installOfficial = async (_, __, validate) => {
    await validate('candidate');
    await writeFile(managed, 'new-binary');
    return { path: managed, version: '2.0.0', output: '' };
  };
  f.options.saveBinaryPath = async (binary) => {
    f.events.push(`save:${binary}`);
    if (binary === managed) throw new Error('disk full');
  };
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /已恢复/);
  assert.equal(await readFile(managed, 'utf8'), 'old-binary');
  assert.equal(await readFile(original, 'utf8'), 'custom-binary');
  assert.ok(f.events.includes(`save:${original}`));
  assert.ok(f.events.includes(`restart:${original}`));
});

test('stopped service remains stopped after installation', async (t) => {
  const f = await fixture(t, false);
  const result = await installAndVerifyMihomo(f.options, f.operations);
  assert.equal(result.runtimeVerified, false);
  assert.match(result.output, /未启动服务/);
  assert.equal(f.events.some((item) => /restart:|verify:/.test(item)), false);
});

test('candidate validation failure does not restart the old runtime', async (t) => {
  const f = await fixture(t);
  f.operations.validate = async () => { throw new Error('private yaml'); };
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /校验或安装失败/);
  assert.equal(await readFile(f.config.mihomo.binary, 'utf8'), 'old-binary');
  assert.equal(f.events.some((item) => item.startsWith('restart:')), false);
});

test('rollback failure retains recovery files and blocks a second update', async (t) => {
  const f = await fixture(t);
  let verifyCount = 0;
  f.operations.verify = async () => { if (++verifyCount > 1) throw new Error('unready'); };
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /备份保留/);
  assert.equal(await readFile(path.join(f.installDir, '.mihomo-update.lock', 'binary'), 'utf8'), 'old-binary');
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /待恢复事务/);
});

test('an unrelated service is rejected before downloading or changing files', async (t) => {
  const f = await fixture(t);
  f.operations.status = async () => ({ loaded: true, pid: 42, serviceMatchesConfig: false });
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /服务与当前配置不匹配/);
  assert.deepEqual(f.events, []);
});

test('a loaded job without a PID cannot bypass runtime verification', async (t) => {
  const f = await fixture(t);
  f.operations.status = async () => ({ loaded: true, serviceMatchesConfig: true, controllerReady: false });
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /已加载但没有运行进程/);
  assert.deepEqual(f.events, []);
});

test('an unmanaged controller is rejected before updating files', async (t) => {
  const f = await fixture(t, false);
  f.operations.status = async () => ({ loaded: false, controllerReady: true });
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /未确认归属/);
  assert.deepEqual(f.events, []);
});

test('Homebrew failure states binary rollback limits without claiming success', async (t) => {
  const f = await fixture(t, false);
  f.options.method = 'homebrew';
  f.operations.installHomebrew = async () => { throw new Error('private output'); };
  await assert.rejects(installAndVerifyMihomo(f.options, f.operations), /二进制无法自动回退/);
  assert.equal(f.events.some((item) => item.startsWith('save:')), false);
});

test('launchd identity requires both executable and active data/config arguments', () => {
  const config = { mihomo: { binary: '/Applications/Test Bridge/mihomo', dataDir: '/tmp/test bridge' } };
  const print = `gui/501/service = {
    program = /Applications/Test Bridge/mihomo
    arguments = {
      /Applications/Test Bridge/mihomo
      -d
      /tmp/test bridge
      -f
      /tmp/test bridge/config.yaml
    }
    pid = 12345
  }`;
  assert.equal(matchesMihomoLaunchService(print, config), true);
  assert.equal(matchesMihomoLaunchService(print.replace('program = /Applications/Test Bridge/mihomo', 'program = /tmp/other'), config), false);
  assert.equal(matchesMihomoLaunchService(print.replace('-d', '-other'), config), false);
  assert.equal(matchesMihomoLaunchService(print.replace('/tmp/test bridge/config.yaml', '/tmp/other.yaml'), config), false);
});

async function mockRelease(t, version = '2.0.0') {
  const bytes = gzipSync(Buffer.from(`#!/bin/sh\nprintf 'Mihomo Meta v${version} test\\n'\n`));
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64-compatible';
  const release = { tag_name: 'v2.0.0', assets: [{ name: `mihomo-darwin-${arch}-v2.0.0.gz`,
    browser_download_url: 'https://example.test/mihomo.gz', size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] };
  const original = global.fetch;
  global.fetch = async (url) => String(url).endsWith('/releases/latest')
    ? new Response(JSON.stringify(release)) : new Response(bytes);
  t.after(() => { global.fetch = original; });
}

test('official candidate rejection preserves installed binary and cleans staged executable', async (t) => {
  const f = await fixture(t, false);
  await mockRelease(t);
  let checked = false;
  await assert.rejects(installOfficialMihomo(f.installDir, undefined, async (candidate) => {
    checked = true;
    assert.match(await readFile(candidate, 'utf8'), /v2.0.0/);
    throw new Error('fixture configuration rejected');
  }), /fixture configuration rejected/);
  assert.equal(checked, true);
  assert.equal(await readFile(f.config.mihomo.binary, 'utf8'), 'old-binary');
  assert.equal(await readFile(`${f.config.mihomo.binary}.previous`, 'utf8'), 'older-binary');
  assert.equal((await readdir(f.installDir)).includes('mihomo.next'), false);
});

test('official installer rejects a release binary whose reported version differs from its tag', async (t) => {
  const f = await fixture(t, false);
  await mockRelease(t, '1.9.0');
  await assert.rejects(installOfficialMihomo(f.installDir), /文件版本与官方发布版本不一致/);
  assert.equal(await readFile(f.config.mihomo.binary, 'utf8'), 'old-binary');
  assert.equal((await readdir(f.installDir)).includes('mihomo.next'), false);
});
