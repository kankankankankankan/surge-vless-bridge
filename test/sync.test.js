const assert = require('node:assert/strict');
const { chmod, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { rebuildSurgeFromLocalConfigs, syncSubscriptionToSurge } = require('../dist/surge.js');
const {
  captureConsole,
  makeConfig,
  nodeConfigFiles,
  policyGroupLine,
  readProfile,
  subscriptionUrl,
  vlessLink,
} = require('./helpers.js');

test('merges several subscriptions into one policy group', async () => {
  const { config } = await makeConfig('multi');
  config.subscriptionUrls = [
    subscriptionUrl([vlessLink(1, 'HK 01'), vlessLink(2, 'JP 01')]),
    subscriptionUrl([vlessLink(3, 'SG 01')]),
  ];

  const result = await syncSubscriptionToSurge(config);

  assert.equal(result.count, 3);
  assert.equal(await policyGroupLine(config), 'VLESS = url-test, HK 01, JP 01, SG 01, no-alert=0, hidden=0');
});

test('writes only documented Surge external policy parameters', async () => {
  const { config } = await makeConfig('surge-external-parameters');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'Boundary')])];
  config.addressResolver.strategy = 'off';

  await syncSubscriptionToSurge(config);
  const line = (await readProfile(config)).split(/\r?\n/).find((entry) => entry.startsWith('Boundary = external,'));
  assert.ok(line);
  const parameters = line.split(',').slice(1).map((entry) => entry.trim().split('=', 1)[0]);
  assert.deepEqual(parameters, ['exec', 'args', 'args', 'args', 'local-port']);
  assert.doesNotMatch(line, /udp-relay/);
  assert.doesNotMatch(line, /test-udp/);
  assert.doesNotMatch(line, /tcp_fast_open|tcp_multi_path|udp_fragment|multiplex|packet_encoding|network_strategy/);
});

test('writes the optional UDP relay parameter during sync and local rebuild', async () => {
  const { config } = await makeConfig('surge-udp-relay');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'UDP Node')])];
  config.addressResolver.strategy = 'off';
  config.udpRelay = true;
  config.udpTestEnabled = true;
  config.udpTestTarget = 'apple.com@8.8.8.8';
  config.tcpFastOpen = true;
  config.connectTimeoutEnabled = true;
  config.connectTimeoutSeconds = 12;

  const preview = await syncSubscriptionToSurge(config, { dryRun: true });
  assert.equal(preview.preview.udpRelay, true);
  assert.equal(preview.preview.udpTestEnabled, true);
  assert.equal(preview.preview.udpTestTarget, 'apple.com@8.8.8.8');
  assert.equal(preview.preview.tcpFastOpen, true);
  assert.equal(preview.preview.connectTimeoutEnabled, true);
  assert.equal(preview.preview.connectTimeoutSeconds, 12);

  await syncSubscriptionToSurge(config);
  assert.match(
    await readProfile(config),
    /^UDP Node = external, .*local-port=2081, udp-relay=true, test-udp=apple\.com@8\.8\.8\.8$/m,
  );
  const [nodeFile] = await nodeConfigFiles(config);
  const nodeConfig = JSON.parse(await readFile(path.join(config.outputDir, nodeFile), 'utf8'));
  assert.equal(nodeConfig.outbounds[0].tcp_fast_open, true);
  assert.equal(nodeConfig.outbounds[0].connect_timeout, '12s');

  await rebuildSurgeFromLocalConfigs(config);
  assert.match(
    await readProfile(config),
    /^UDP Node = external, .*local-port=2081, udp-relay=true, test-udp=apple\.com@8\.8\.8\.8$/m,
  );
});

test('adds the VLESS group to several existing policy groups without changing their parameters', async () => {
  const { config } = await makeConfig('policy-group-targets');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'HK 01')])];
  config.policyGroupTargets = ['Proxy', '自动[选择]', 'Proxy'];
  await writeFile(
    config.surgeConfigPath,
    [
      '[Proxy]',
      'DIRECT = direct',
      '',
      '[Proxy Group]',
      'Proxy = select, DIRECT, include-other-group="A,B", hidden=0 #! REQUIREMENT',
      '自动[选择] = fallback, DIRECT, url=http://example.com/ping, interval=600',
      '',
      '[Rule]',
      'FINAL,Proxy',
      '',
    ].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);
  await syncSubscriptionToSurge(config);
  const profile = await readProfile(config);

  assert.match(profile, /^Proxy = select, DIRECT, include-other-group="A,B,VLESS", hidden=0 #! REQUIREMENT$/m);
  assert.match(profile, /^自动\[选择\] = fallback, DIRECT, VLESS, url=http:\/\/example\.com\/ping, interval=600$/m);
  assert.equal((profile.match(/^Proxy = .*\bVLESS\b.*$/gm) ?? []).length, 1);
});

test('adds VLESS nodes to smart groups through include-other-group and migrates invalid direct members', async () => {
  const { config } = await makeConfig('smart-policy-group-target');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, '🇭🇰 HK 01'), vlessLink(2, '🇯🇵 JP 01')])];
  config.policyGroupTargets = ['🇭🇰 香港线路'];
  await writeFile(
    config.surgeConfigPath,
    [
      '[Proxy]',
      'DIRECT = direct',
      '',
      '[Proxy Group]',
      'HUB = select, DIRECT',
      '🇭🇰 香港线路 = smart, VLESS, include-other-group=HUB, policy-regex-filter=(?i)(🇭🇰|香港|HK), evaluate-before-use=1, hidden=1',
      '',
      '[Rule]',
      'FINAL,🇭🇰 香港线路',
      '',
    ].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);
  await syncSubscriptionToSurge(config);
  const profile = await readProfile(config);

  assert.match(
    profile,
    /^🇭🇰 香港线路 = smart, include-other-group="HUB,VLESS", policy-regex-filter=\(\?i\)\(🇭🇰\|香港\|HK\), evaluate-before-use=1, hidden=1$/m,
  );
  assert.doesNotMatch(profile, /^🇭🇰 香港线路 = smart, VLESS,/m);
});

test('auto mode merges VLESS into a HUB group that already filters nodes by region', async () => {
  const { config } = await makeConfig('hub-auto-merge');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'HK 01')])];
  config.policyGroupTargets = ['HUB'];
  config.policyGroupTargetModes = { HUB: 'auto' };
  await writeFile(
    config.surgeConfigPath,
    [
      '[Proxy]',
      'DIRECT = direct',
      '',
      '[Proxy Group]',
      'Sub-1 = select, DIRECT',
      'HUB = select, include-other-group=Sub-1, policy-regex-filter=(?i)(香港|港|HK|Japan|JP), include-all-proxies=0, hidden=1',
      '',
      '[Rule]',
      'FINAL,HUB',
      '',
    ].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);
  const profile = await readProfile(config);

  assert.match(
    profile,
    /^HUB = select, include-other-group="Sub-1,VLESS", policy-regex-filter=\(\?i\)\(香港\|港\|HK\|Japan\|JP\), include-all-proxies=0, hidden=1$/m,
  );
  assert.doesNotMatch(profile, /^HUB = select, VLESS,/m);
});

test('manual merge mode uses include-other-group for a normal select group', async () => {
  const { config } = await makeConfig('manual-merge');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.policyGroupTargets = ['Proxy'];
  config.policyGroupTargetModes = { Proxy: 'merge' };
  await writeFile(
    config.surgeConfigPath,
    ['[Proxy]', 'DIRECT = direct', '', '[Proxy Group]', 'Proxy = select, DIRECT, hidden=0', '', '[Rule]', 'FINAL,Proxy', ''].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);

  assert.match(await readProfile(config), /^Proxy = select, DIRECT, include-other-group=VLESS, hidden=0$/m);
});

test('manual reference mode adds VLESS as a direct member', async () => {
  const { config } = await makeConfig('manual-reference');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.policyGroupTargets = ['Proxy'];
  config.policyGroupTargetModes = { Proxy: 'reference' };
  await writeFile(
    config.surgeConfigPath,
    ['[Proxy]', 'DIRECT = direct', '', '[Proxy Group]', 'Proxy = select, DIRECT, hidden=0', '', '[Rule]', 'FINAL,Proxy', ''].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);

  assert.match(await readProfile(config), /^Proxy = select, DIRECT, VLESS, hidden=0$/m);
});

test('manual reference mode rejects smart groups before writing files', async () => {
  const { config } = await makeConfig('smart-reference-rejected');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.policyGroupTargets = ['Smart'];
  config.policyGroupTargetModes = { Smart: 'reference' };
  await writeFile(
    config.surgeConfigPath,
    ['[Proxy]', 'DIRECT = direct', '', '[Proxy Group]', 'Smart = smart, include-other-group=HUB, hidden=1', '', '[Rule]', 'FINAL,Smart', ''].join('\n'),
    'utf8',
  );
  const before = await readProfile(config);

  await assert.rejects(syncSubscriptionToSurge(config), /Smart policy group cannot reference VLESS directly/);

  assert.equal(await readProfile(config), before);
  assert.deepEqual(await nodeConfigFiles(config), []);
});

test('dry-run preview returns complete policy group lines before and after the change', async () => {
  const { config } = await makeConfig('policy-group-preview');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.policyGroupTargets = ['HUB'];
  config.policyGroupTargetModes = { HUB: 'auto' };
  const beforeLine = 'HUB = select, include-other-group=Sub-1, policy-regex-filter=(?i)(HK|JP), hidden=1';
  await writeFile(
    config.surgeConfigPath,
    ['[Proxy]', 'DIRECT = direct', '', '[Proxy Group]', beforeLine, '', '[Rule]', 'FINAL,HUB', ''].join('\n'),
    'utf8',
  );

  const result = await syncSubscriptionToSurge(config, { dryRun: true });

  assert.deepEqual(result.preview.policyGroupChanges, [
    {
      name: 'HUB',
      action: 'add',
      mode: 'auto',
      resolvedMode: 'merge',
      before: beforeLine,
      after: 'HUB = select, include-other-group="Sub-1,VLESS", policy-regex-filter=(?i)(HK|JP), hidden=1',
    },
  ]);
  assert.equal(await readProfile(config), ['[Proxy]', 'DIRECT = direct', '', '[Proxy Group]', beforeLine, '', '[Rule]', 'FINAL,HUB', ''].join('\n'));
});

test('removes VLESS from an unchecked smart group during the next sync', async () => {
  const { config } = await makeConfig('smart-policy-group-exclusion');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, '🇭🇰 HK 01')])];
  config.policyGroupExclusions = ['🇭🇰 香港线路'];
  await writeFile(
    config.surgeConfigPath,
    [
      '[Proxy]',
      'DIRECT = direct',
      '',
      '[Proxy Group]',
      'HUB = select, DIRECT',
      'VLESS = url-test, Old Node, interval=600',
      '🇭🇰 香港线路 = smart, include-other-group="HUB,VLESS", policy-regex-filter=(?i)(🇭🇰|香港|HK), hidden=1',
      '',
      '[Rule]',
      'FINAL,🇭🇰 香港线路',
      '',
    ].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);
  const profile = await readProfile(config);

  assert.match(
    profile,
    /^🇭🇰 香港线路 = smart, include-other-group="HUB", policy-regex-filter=\(\?i\)\(🇭🇰\|香港\|HK\), hidden=1$/m,
  );
  assert.doesNotMatch(profile, /include-other-group="HUB,VLESS"/);
});

test('rejects missing target policy groups before changing the profile or node configs', async () => {
  const { config } = await makeConfig('missing-policy-group-target');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.policyGroupTargets = ['Proxy', '不存在'];
  const before = await readProfile(config);

  await assert.rejects(syncSubscriptionToSurge(config), /Policy groups not found.*不存在/);

  assert.equal(await readProfile(config), before);
  assert.deepEqual(await nodeConfigFiles(config), []);
});

test('keeps an existing VLESS member without adding it again', async () => {
  const { config } = await makeConfig('existing-policy-group-member');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  config.policyGroupTargets = ['Proxy'];
  await writeFile(
    config.surgeConfigPath,
    [
      '[Proxy]',
      'DIRECT = direct',
      '',
      '[Proxy Group]',
      'Proxy = select, DIRECT, VLESS, VLESS-A, hidden=0',
      '',
      '[Rule]',
      'FINAL,Proxy',
      '',
    ].join('\n'),
    'utf8',
  );

  await syncSubscriptionToSurge(config);
  const proxyLine = (await readProfile(config)).split('\n').find((line) => line.startsWith('Proxy ='));
  const members = proxyLine.split(',').map((part) => part.trim());

  assert.equal(members.filter((member) => member === 'VLESS').length, 1);
  assert.ok(members.includes('VLESS-A'));
});

test('merges the legacy subscriptionUrl instead of letting subscriptionUrls shadow it', async () => {
  const { config } = await makeConfig('legacy');
  config.subscriptionUrl = subscriptionUrl([vlessLink(1, 'Legacy')]);
  config.subscriptionUrls = [subscriptionUrl([vlessLink(2, 'Added')])];

  await syncSubscriptionToSurge(config);

  assert.equal(await policyGroupLine(config), 'VLESS = url-test, Legacy, Added, no-alert=0, hidden=0');
});

test('does not fetch the same subscription twice when both fields hold it', async () => {
  const { config } = await makeConfig('dedupe-url');
  const shared = subscriptionUrl([vlessLink(1, 'Only')]);
  config.subscriptionUrl = shared;
  config.subscriptionUrls = [shared];

  const result = await syncSubscriptionToSurge(config);

  assert.equal(result.count, 1);
});

test('gives duplicate node names a numeric suffix', async () => {
  const { config } = await makeConfig('duplicate-names');
  config.subscriptionUrls = [
    subscriptionUrl([vlessLink(1, 'HK 01')]),
    subscriptionUrl([vlessLink(2, 'HK 01'), vlessLink(3, 'HK 01')]),
  ];

  await syncSubscriptionToSurge(config);

  assert.equal(await policyGroupLine(config), 'VLESS = url-test, HK 01, HK 01 2, HK 01 3, no-alert=0, hidden=0');
});

test('warns about an empty subscription but still syncs the others', async () => {
  const { config } = await makeConfig('partial-empty');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'Alive')]), subscriptionUrl(['ss://not-a-vless-node'])];

  const warnings = await captureConsole('warn', () => syncSubscriptionToSurge(config));

  assert.match(warnings, /Subscription 2 of 2 returned no VLESS nodes/);
  assert.equal(await policyGroupLine(config), 'VLESS = url-test, Alive, no-alert=0, hidden=0');
});

test('refuses to touch the profile when no source yields a VLESS node', async () => {
  const { config } = await makeConfig('all-empty');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'Alive')])];
  await syncSubscriptionToSurge(config);
  const before = await readProfile(config);

  config.subscriptionUrls = [subscriptionUrl(['ss://not-a-vless-node'])];
  await assert.rejects(syncSubscriptionToSurge(config), /refusing to update the Surge profile/);
  assert.equal(await readProfile(config), before);
});

test('names the failing subscription without leaking its token', async () => {
  const { config } = await makeConfig('failing-url');
  const node = vlessLink(1, 'Alive');
  config.subscriptionUrls = [
    subscriptionUrl([node, node]),
    'https://sub.example.invalid/link/TOKEN-SECRET?flag=surge',
  ];
  config.vlessNodes = [node];

  let result;
  const warnings = await captureConsole('warn', async () => {
    result = await syncSubscriptionToSurge(config);
  });

  assert.match(warnings, /Subscription 2 of 2/);
  assert.match(warnings, /https:\/\/sub\.example\.invalid/);
  assert.doesNotMatch(warnings, /TOKEN-SECRET|flag=surge|\/link\//);
  assert.equal(result.count, 1);
  assert.equal(await policyGroupLine(config), 'VLESS = url-test, Alive, no-alert=0, hidden=0');
});

test('leaves the profile and existing node configs untouched when sing-box rejects a config', async () => {
  const { root, config } = await makeConfig('rejected');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'Kept')])];
  await syncSubscriptionToSurge(config);

  const before = { profile: await readProfile(config), files: await nodeConfigFiles(config) };
  const failingBinary = path.join(root, 'failing-sing-box');
  await writeFile(failingBinary, '#!/bin/sh\necho "invalid config" >&2\nexit 1\n', 'utf8');
  await chmod(failingBinary, 0o700);

  await assert.rejects(
    syncSubscriptionToSurge({
      ...config,
      singBoxBinary: failingBinary,
      subscriptionUrls: [subscriptionUrl([vlessLink(9, 'Replacement')])],
    }),
    /sing-box rejected .*invalid config/,
  );

  assert.equal(await readProfile(config), before.profile);
  assert.deepEqual(await nodeConfigFiles(config), before.files);
});

test('fails before generating anything when the sing-box binary is missing', async () => {
  const { config } = await makeConfig('missing-binary');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'Node')])];

  await assert.rejects(
    syncSubscriptionToSurge({ ...config, singBoxBinary: '/nonexistent/sing-box' }),
    /sing-box binary not found/,
  );
});

test('removes stale node configs and rebuilds only what the manifest lists', async () => {
  const { config } = await makeConfig('stale');
  config.subscriptionUrls = [
    subscriptionUrl([vlessLink(1, 'A'), vlessLink(2, 'B'), vlessLink(3, 'C')]),
  ];
  await syncSubscriptionToSurge(config);
  assert.equal((await nodeConfigFiles(config)).length, 3);

  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  await syncSubscriptionToSurge(config);

  assert.deepEqual(await nodeConfigFiles(config), ['sing-box[2081].json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(config.outputDir, 'manifest.json'), 'utf8')), {
    version: 1,
    files: ['sing-box[2081].json'],
  });

  const rebuilt = await rebuildSurgeFromLocalConfigs(config);
  assert.equal(rebuilt.count, 1);
  assert.equal(await policyGroupLine(config), 'VLESS = url-test, A, no-alert=0, hidden=0');
});

test('leaves no staging directory behind', async () => {
  const { config } = await makeConfig('staging');
  config.subscriptionUrls = [subscriptionUrl([vlessLink(1, 'A')])];
  await syncSubscriptionToSurge(config);

  const { readdir } = require('node:fs/promises');
  assert.deepEqual(
    (await readdir(config.outputDir)).filter((entry) => entry.startsWith('.staging-')),
    [],
  );
});

test('writes an IPv6 node without the brackets URL parsing adds', async () => {
  const { config } = await makeConfig('ipv6');
  config.subscriptionUrls = [
    subscriptionUrl(['vless://00000000-0000-4000-8000-000000000001@[2001:db8::1]:443?encryption=none#IPv6Node']),
  ];
  // A literal address short-circuits before any resolver runs, so this never touches the network.
  config.addressResolver.strategy = 'doh';

  const result = await syncSubscriptionToSurge(config);
  assert.equal(result.count, 1);

  // sing-box reads `server` as an IP or a domain; `[2001:db8::1]` is neither, so it would be
  // treated as a hostname and never resolve.
  const [file] = await nodeConfigFiles(config);
  const json = JSON.parse(await readFile(path.join(config.outputDir, file), 'utf8'));
  assert.equal(json.outbounds[0].server, '2001:db8::1');

  assert.match(await readProfile(config), /^IPv6Node = external, .*addresses=2001:db8::1$/m);
});
