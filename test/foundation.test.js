const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { writeTextFile, writeBinaryFile } = require('../dist/utils/fs.js');
const { findSurgeCli, validateSurgeProfile } = require('../dist/utils/surge-cli.js');
const { parseVlessNode } = require('../dist/utils/parse-vless-node.js');
const { mapVlessToMihomoProxy } = require('../dist/mihomo/config.js');

const fixture = async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'surge-foundation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test('new private files and directories are restricted while existing modes are preserved', async t => {
  const root = await fixture(t);
  await fs.chmod(root, 0o755);
  const path = join(root, 'private', 'nested', 'config.json');
  await writeTextFile(path, 'first');
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(root, 'private'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o755);
  await fs.chmod(path, 0o640);
  await writeTextFile(path, 'second');
  assert.equal(await fs.readFile(path, 'utf8'), 'second');
  assert.equal((await fs.stat(path)).mode & 0o777, 0o640);
});

test('atomic writes follow relative chained symlinks and preserve the links', async t => {
  const root = await fixture(t);
  const path = join(root, 'profile.conf');
  const firstLink = join(root, 'first.conf');
  const secondLink = join(root, 'second.conf');
  await fs.writeFile(path, 'old', { mode: 0o640 });
  await fs.symlink('profile.conf', firstLink);
  await fs.symlink('first.conf', secondLink);
  const before = await fs.stat(path);
  await writeBinaryFile(secondLink, Buffer.from('new'));
  assert.equal(await fs.readFile(path, 'utf8'), 'new');
  assert.equal((await fs.stat(path)).mode & 0o777, 0o640);
  assert.notEqual((await fs.stat(path)).ino, before.ino);
  assert.equal(await fs.readlink(firstLink), 'profile.conf');
  assert.equal(await fs.readlink(secondLink), 'first.conf');
  const dangling = join(root, 'dangling.conf');
  await fs.symlink('missing.conf', dangling);
  await assert.rejects(writeTextFile(dangling, 'must not replace link'), { code: 'ENOENT' });
  assert.equal(await fs.readlink(dangling), 'missing.conf');
});

test('a failed atomic rename leaves the previous file intact and removes its temporary file', async t => {
  const root = await fixture(t);
  const path = join(root, 'profile.conf');
  await fs.writeFile(path, 'original');
  const mock = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('blocked'), { code: 'EACCES' }); });
  await assert.rejects(writeTextFile(path, 'replacement'), { code: 'EACCES' });
  mock.mock.restore();
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(root), ['profile.conf']);
});

test('Reality supplies Chrome only when no explicit fingerprint is present', () => {
  for (const [query, expected] of [['', 'chrome'], ['&fp=', 'chrome'], ['&fp=firefox', 'firefox']]) {
    const outbound = parseVlessNode(`vless://u@example.com:443?security=reality&pbk=PUBLIC${query}`, 0);
    assert.deepEqual(outbound.tls.utls, { enabled: true, fingerprint: expected });
    assert.equal(mapVlessToMihomoProxy(outbound, 'demo', {})['client-fingerprint'], expected);
  }
  assert.equal(parseVlessNode('vless://u@example.com:443?security=tls', 0).tls.utls, undefined);
});

test('Surge CLI discovery finds bundles without PATH and falls back to executable PATH entries', async t => {
  const root = await fixture(t);
  const bundle = join(root, 'Applications', 'Surge.app', 'Contents', 'Applications', 'surge-cli');
  const pathCli = join(root, 'bin', 'surge-cli');
  await fs.mkdir(dirname(bundle), { recursive: true });
  await fs.mkdir(dirname(pathCli));
  await fs.writeFile(bundle, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(pathCli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const options = { applicationDirs: [join(root, 'Applications')], pathEnv: dirname(pathCli) };
  assert.equal(await findSurgeCli(options), bundle);
  await fs.chmod(bundle, 0o600);
  assert.equal(await findSurgeCli(options), pathCli);
  assert.equal(await findSurgeCli({ applicationDirs: [], pathEnv: '' }), undefined);
});

test('native candidate checks resolve beside the symlink target and remove private candidates', async t => {
  const root = await fixture(t);
  const realDirectory = join(root, 'actual');
  await fs.mkdir(realDirectory);
  const resolvedDirectory = await fs.realpath(realDirectory);
  const profile = join(realDirectory, 'profile.conf');
  await fs.writeFile(profile, 'original');
  const link = join(root, 'profile.conf');
  await fs.symlink(profile, link);
  const cli = join(root, 'surge-cli');
  await fs.writeFile(cli, `#!${process.execPath}\nconst fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict'); assert.equal(process.argv[2],'--check'); const candidate=process.argv[3]; assert.equal(path.dirname(candidate),${JSON.stringify(resolvedDirectory)}); assert.equal(process.cwd(),${JSON.stringify(resolvedDirectory)}); assert.equal(fs.statSync(candidate).mode & 511,384); assert.equal(fs.readFileSync(candidate,'utf8'),'candidate');\n`, { mode: 0o700 });
  assert.deepEqual(await validateSurgeProfile('candidate', link, { cliPath: cli }), { checked: true });
  assert.equal(await fs.readFile(profile, 'utf8'), 'original');
  assert.equal(await fs.readlink(link), profile);
  assert.deepEqual(await fs.readdir(realDirectory), ['profile.conf']);
});

test('native rejection retains only the line number and leaves the profile untouched', async t => {
  const root = await fixture(t);
  const profile = join(root, 'profile.conf');
  await fs.writeFile(profile, 'original');
  const cli = join(root, 'surge-cli');
  await fs.writeFile(cli, `#!${process.execPath}\nconsole.error('Failed: Invalid line in SECRET.conf at #5\\nLine: SECRET = https://private/token');process.exit(1);\n`, { mode: 0o700 });
  await assert.rejects(validateSurgeProfile('candidate', profile, { cliPath: cli }), error => {
    assert.match(error.message, /第 5 行/);
    assert.doesNotMatch(error.message, /SECRET|private|token/);
    return true;
  });
  assert.equal(await fs.readFile(profile, 'utf8'), 'original');
  assert.deepEqual((await fs.readdir(root)).sort(), ['profile.conf', 'surge-cli']);
  const warning = t.mock.method(console, 'warn', () => {});
  const result = await validateSurgeProfile('candidate', profile, { cliPath: null });
  assert.equal(result.checked, false);
  assert.match(result.warning, /未执行/);
  assert.equal(warning.mock.calls.length, 1);
});
