const assert = require('node:assert/strict');
const { readdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { cleanManagedArtifacts, runDoctor, syncSubscriptionToSurge } = require('../dist/surge.js');
const { parseHttpApiSettings } = require('../dist/utils/surge-reload.js');
const { captureConsole, makeConfig, nodeConfigFiles, readProfile, subscriptionUrl, vlessLink } = require('./helpers.js');

test('keeps only the configured number of backups', async () => {
  const { config } = await makeConfig('backup-keep');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.backupKeep = 3;

  for (let run = 0; run < 5; run += 1) {
    await syncSubscriptionToSurge(config);
  }

  const backups = (await readdir(config.backupDir)).filter((entry) => entry.endsWith('.conf'));
  assert.equal(backups.length, 3);
});

test('dry run reports the plan without writing anything', async () => {
  const { config } = await makeConfig('dry-run');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A'), vlessLink(2, 'B')])];
  config.policyGroupTargets = ['Proxy'];
  const before = await readProfile(config);

  const output = await captureConsole('log', async () => {
    const result = await syncSubscriptionToSurge(config, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.preview.policyGroupTargets, ['Proxy']);
  });

  assert.match(output, /Would write 2 nodes/);
  assert.match(output, /2081\s+A/);
  assert.match(output, /Surge profile would change/);
  assert.match(output, /Add VLESS to policy groups: Proxy/);
  assert.equal(await readProfile(config), before);
  assert.deepEqual(await nodeConfigFiles(config), []);
  assert.deepEqual(
    (await readdir(config.outputDir)).filter((entry) => entry.startsWith('.staging-')),
    [],
  );
});

test('clean removes the managed block, the policy group and the node configs', async () => {
  const { config } = await makeConfig('clean');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A'), vlessLink(2, 'B')])];
  config.policyGroupTargets = ['Proxy'];
  await syncSubscriptionToSurge(config);
  assert.equal((await nodeConfigFiles(config)).length, 2);

  const result = await cleanManagedArtifacts(config);
  const profile = await readProfile(config);

  assert.equal(result.removedConfigs, 2);
  assert.deepEqual(await nodeConfigFiles(config), []);
  assert.doesNotMatch(profile, /# vless start/);
  assert.doesNotMatch(profile, /# vless end/);
  assert.doesNotMatch(profile, /^VLESS =/m);
  // Untouched parts of the profile survive.
  assert.match(profile, /\[Proxy\]/);
  assert.match(profile, /DIRECT = direct/);
  assert.match(profile, /^Proxy = select, DIRECT$/m);
  assert.match(profile, /FINAL,Proxy/);
});

test('clean removes VLESS from smart group include-other-group references', async () => {
  const { config } = await makeConfig('clean-smart-policy-group');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, '🇭🇰 HK 01')])];
  config.policyGroupTargets = ['香港线路'];
  await writeFile(
    config.surgeConfigPath,
    [
      '[Proxy]',
      'DIRECT = direct',
      '',
      '[Proxy Group]',
      'HUB = select, DIRECT',
      '香港线路 = smart, include-other-group=HUB, policy-regex-filter=(?i)(香港|HK)',
      '',
      '[Rule]',
      'FINAL,香港线路',
      '',
    ].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);
  await cleanManagedArtifacts(config);
  const profile = await readProfile(config);

  assert.match(profile, /^香港线路 = smart, include-other-group="HUB", policy-regex-filter=\(\?i\)\(香港\|HK\)$/m);
  assert.doesNotMatch(profile, /include-other-group="[^"]*VLESS/);
});

test('clean backs the profile up before editing it', async () => {
  const { config } = await makeConfig('clean-backup');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  await syncSubscriptionToSurge(config);
  const beforeClean = await readProfile(config);

  const { backupPath } = await cleanManagedArtifacts(config);

  assert.equal(await readFile(backupPath, 'utf8'), beforeClean);
});

test('doctor warns instead of failing before the first sync', async () => {
  const { config } = await makeConfig('doctor-fresh');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];

  const output = await captureConsole('log', async () => {
    const { failures, warnings } = await runDoctor(config);
    assert.equal(failures, 0);
    assert.ok(warnings >= 2);
  });

  assert.match(output, /WARN outputDir: .*not created yet/);
  assert.match(output, /WARN backupDir: .*not created yet/);
});

test('doctor fails when a required path is missing', async () => {
  const { config } = await makeConfig('doctor-fail');
  const { failures } = await runDoctor({ ...config, singBoxBinary: '/nonexistent/sing-box' });

  assert.ok(failures >= 2); // no node sources configured, and no sing-box binary
});

test('doctor reports the ports in use once nodes exist', async () => {
  const { config } = await makeConfig('doctor-ports');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  await syncSubscriptionToSurge(config);

  const output = await captureConsole('log', () => runDoctor(config));

  assert.match(output, /OK ports: 2081/);
});

test('parses the Surge HTTP API settings', () => {
  const profile = ['[General]', 'skip-proxy = 127.0.0.1', 'http-api = secret@0.0.0.0:6171', '', '[Proxy]'].join('\n');

  assert.deepEqual(parseHttpApiSettings(profile), { key: 'secret', origin: 'http://127.0.0.1:6171' });
});

test('honours http-api-tls when building the API origin', () => {
  const profile = ['[General]', 'http-api = secret@127.0.0.1:6171', 'http-api-tls = true', '', '[Proxy]'].join('\n');

  assert.equal(parseHttpApiSettings(profile).origin, 'https://127.0.0.1:6171');
});

test('returns nothing when the HTTP API is not configured', () => {
  assert.equal(parseHttpApiSettings(['[General]', 'dns-server = 1.1.1.1', '', '[Proxy]'].join('\n')), undefined);
  assert.equal(parseHttpApiSettings('[Proxy]\nDIRECT = direct'), undefined);
});

test('doctor points at the HTTP API when it is not enabled', async () => {
  const { config } = await makeConfig('doctor-api');
  const output = await captureConsole('log', () => runDoctor({ ...config, autoReload: true }));

  assert.match(output, /WARN surge-http-api: not enabled/);
});

test('doctor accepts a missing HTTP API when automatic reload is disabled', async () => {
  const { config } = await makeConfig('doctor-api-disabled');
  const result = await runDoctor({ ...config, autoReload: false });
  const check = result.checks.find((entry) => entry.label === 'surge-http-api');

  assert.equal(check.level, 'ok');
  assert.match(check.detail, /disabled by config/);
});

test('doctor confirms the HTTP API when the profile enables it', async () => {
  const { config } = await makeConfig('doctor-api-on');
  const profile = await readProfile(config);
  await writeFile(config.surgeConfigPath, `[General]\nhttp-api = secret@127.0.0.1:6171\n\n${profile}`, 'utf8');

  const output = await captureConsole('log', () => runDoctor({ ...config, autoReload: true }));

  assert.match(output, /OK surge-http-api: http:\/\/127\.0\.0\.1:6171/);
});
