const assert = require('node:assert/strict');
const { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DesktopService } = require('../dist/desktop/service.js');
const {
  compareVersions,
  inspectSingBoxVersion,
  normalizeSingBoxVersion,
  rollbackOfficialSingBox,
  selectOfficialAsset,
} = require('../dist/desktop/dependencies.js');
const { renderLaunchAgentPlist } = require('../dist/desktop/scheduler.js');
const { readLogTail } = require('../dist/desktop/storage.js');
const { assertRuntimeModeConfirmed } = require('../dist/runtime-mode.js');
const { PROFILE_TEXT, subscriptionUrl, vlessLink } = require('./helpers.js');

test('renders an escaped launchd job for interval schedules', () => {
  const plist = renderLaunchAgentPlist({
    schedule: {
      enabled: true,
      kind: 'interval',
      intervalHours: 3,
      hour: 8,
      minute: 0,
      runAtLoad: true,
    },
    executablePath: '/Applications/Surge VLESS Bridge.app/Contents/MacOS/Surge VLESS Bridge',
    scheduledEntryPath: '/tmp/a&b/scheduled-run.js',
    configPath: '/Users/test/.config/surge-vless-bridge/config.json',
    logPath: '/Users/test/.config/surge-vless-bridge/desktop/scheduler.log',
  });

  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>10800<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /a&amp;b\/scheduled-run\.js/);
  assert.match(plist, /ELECTRON_RUN_AS_NODE/);
});

test('rejects custom intervals outside the supported range', () => {
  const createPlist = (intervalHours) =>
    renderLaunchAgentPlist({
      schedule: {
        enabled: true,
        kind: 'interval',
        intervalHours,
        hour: 8,
        minute: 0,
        runAtLoad: false,
      },
      executablePath: '/usr/bin/node',
      scheduledEntryPath: '/tmp/scheduled-run.js',
      configPath: '/tmp/config.json',
      logPath: '/tmp/scheduler.log',
    });

  assert.throws(() => createPlist(0), /1 到 168/);
  assert.throws(() => createPlist(169), /1 到 168/);
  assert.throws(() => createPlist(1.5), /1 到 168/);
});

test('renders a calendar trigger for daily schedules', () => {
  const plist = renderLaunchAgentPlist({
    schedule: {
      enabled: true,
      kind: 'daily',
      intervalHours: 12,
      hour: 7,
      minute: 35,
      runAtLoad: false,
    },
    executablePath: '/usr/bin/node',
    scheduledEntryPath: '/tmp/scheduled-run.js',
    configPath: '/tmp/config.json',
    logPath: '/tmp/scheduler.log',
  });

  assert.match(plist, /<key>Hour<\/key><integer>7<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>35<\/integer>/);
  assert.doesNotMatch(plist, /StartInterval/);
});

test('desktop service preserves CLI config and runs the shared sync core', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  const outputDir = path.join(root, 'nodes');
  const backupDir = path.join(root, 'backups');
  await writeFile(profilePath, PROFILE_TEXT, 'utf8');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        runtimeModeConfirmed: true,
        subscriptionUrls: [],
        vlessNodes: [],
        surgeConfigPath: profilePath,
        singBoxBinary: '/usr/bin/true',
        outputDir,
        backupDir,
        subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
        policyGroupTargets: ['Proxy'],
        autoReload: false,
        addressResolver: 'off',
      },
      null,
      2,
    ),
  );

  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });
  const doctorBeforeSetup = await service.runAction('doctor');
  assert.equal(doctorBeforeSetup.success, false);
  assert.match(doctorBeforeSetup.message, /发现 1 项问题/);

  const source = subscriptionUrl([vlessLink(1, 'Desktop Node')]);
  await service.saveSources({ subscriptionUrls: [source], subscriptionNames: ['主力订阅'], vlessNodes: [] });

  const preview = await service.runAction('preview');
  assert.equal(preview.success, true);
  assert.equal(preview.count, 1);
  assert.equal(preview.preview.count, 1);
  assert.equal(preview.preview.added, 1);
  assert.equal(preview.preview.removed, 0);
  assert.equal(preview.preview.profileChanged, true);
  assert.deepEqual(preview.preview.policyGroupTargets, ['Proxy']);
  assert.equal(preview.preview.nodes[0].name, 'Desktop Node');
  assert.equal(preview.preview.nodes[0].port, 2081);
  assert.match(preview.output, /Would write 1 nodes/);

  const synced = await service.runAction('sync');
  assert.equal(synced.success, true);
  assert.equal(synced.count, 1);

  const state = await service.getState();
  assert.equal(state.nodeCount, 1);
  assert.equal(state.config.subscriptionUrls[0], source);
  assert.equal(state.config.subscriptionNames[0], '主力订阅');
  assert.equal(state.history[0].action, 'sync');
  assert.equal(state.history[0].success, true);
  assert.deepEqual(state.policyGroups, [
    {
      name: 'Proxy',
      containsPolicyGroup: true,
      membershipMode: 'reference',
      groupType: 'select',
      hasIncludeOtherGroup: false,
      hasPolicyRegexFilter: false,
      recommendedMode: 'reference',
    },
  ]);
  assert.match(await readFile(profilePath, 'utf8'), /^Desktop Node = external,/m);
});

test('unconfirmed runtime blocks writes and schedule activation until External is confirmed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-runtime-confirmation-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  await writeFile(profilePath, PROFILE_TEXT, 'utf8');
  await writeFile(
    configPath,
    JSON.stringify({
      runtimeMode: 'external',
      runtimeModeConfirmed: false,
      vlessNodes: [vlessLink(1, 'Blocked')],
      surgeConfigPath: profilePath,
      singBoxBinary: '/usr/bin/true',
      outputDir: path.join(root, 'nodes'),
      backupDir: path.join(root, 'backups'),
      subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
      addressResolver: 'off',
      autoReload: false,
    }),
    'utf8',
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  const preview = await service.runAction('preview');
  assert.equal(preview.success, false);
  assert.equal(preview.message, '请先选择并确认运行引擎。');
  await assert.rejects(
    service.saveSchedule({ enabled: true, kind: 'interval', intervalHours: 12, hour: 8, minute: 0, runAtLoad: false }),
    /请先选择并确认运行引擎/,
  );
  assert.throws(() => assertRuntimeModeConfirmed({ runtimeModeConfirmed: false }), /请先选择并确认运行引擎/);
  assert.doesNotThrow(() => assertRuntimeModeConfirmed({ runtimeModeConfirmed: true }));

  const confirmed = await service.switchEngine('external');
  assert.equal(confirmed.success, true);
  assert.equal((await service.getState()).runtimeModeConfirmed, true);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).runtimeModeConfirmed, true);
});

test('engine switch restores config, Surge text and an installed stopped service when saving fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-switch-rollback-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  const originalConfig = `${JSON.stringify(
    {
      runtimeMode: 'external',
      runtimeModeConfirmed: true,
      mihomo: {
        binary: '/usr/bin/true',
        dataDir: path.join(root, 'mihomo'),
        controllerSecret: 'test-controller-secret',
      },
      vlessNodes: [vlessLink(1, 'Rollback')],
      surgeConfigPath: profilePath,
      singBoxBinary: '/usr/bin/true',
      outputDir: path.join(root, 'nodes'),
      backupDir: path.join(root, 'backups'),
      subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
      addressResolver: 'off',
      autoReload: false,
    },
    null,
    2,
  )}\n`;
  const originalSurge = PROFILE_TEXT;
  await writeFile(configPath, originalConfig, 'utf8');
  await writeFile(profilePath, originalSurge, 'utf8');
  const syncCalls = [];
  const serviceCalls = [];
  let configWriteCount = 0;
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
    dependencies: {
      switchSync: async (config, options = {}) => {
        syncCalls.push({ runtimeMode: config.runtimeMode, runtimeModeConfirmed: config.runtimeModeConfirmed, dryRun: Boolean(options.dryRun) });
        if (!options.dryRun) await writeFile(profilePath, 'changed during switch\n', 'utf8');
        return { count: 1 };
      },
      readMihomoServiceStatus: async () => ({ installed: true, loaded: false, controllerReady: false }),
      installMihomoService: async () => {
        serviceCalls.push('install');
        return '/tmp/test.plist';
      },
      stopMihomoService: async () => {
        serviceCalls.push('stop');
      },
      writeConfigFile: async (targetPath, text) => {
        configWriteCount += 1;
        if (configWriteCount === 1) throw new Error('simulated config save failure');
        await writeFile(targetPath, text, 'utf8');
      },
    },
  });

  const result = await service.switchEngine('mihomo');

  assert.equal(result.success, false);
  assert.match(result.message, /simulated config save failure/);
  assert.deepEqual(syncCalls, [
    { runtimeMode: 'mihomo', runtimeModeConfirmed: false, dryRun: true },
    { runtimeMode: 'mihomo', runtimeModeConfirmed: false, dryRun: false },
  ]);
  assert.deepEqual(serviceCalls, ['install', 'stop']);
  assert.equal(await readFile(profilePath, 'utf8'), originalSurge);
  assert.equal(await readFile(configPath, 'utf8'), originalConfig);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).runtimeMode, 'external');
});

test('desktop log hides the known Electron launchd warning and keeps useful sync output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-log-'));
  const logPath = path.join(root, 'scheduler.log');
  await writeFile(
    logPath,
    [
      '[1023/041922.929268:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)',
      '[2026-10-22T20:19:22.968Z] Scheduled sync started.',
      'Surge profile reloaded via http-api.',
      '定时同步已完成，共 31 个节点。',
    ].join('\n'),
    'utf8',
  );

  const visibleLog = await readLogTail(logPath);
  assert.doesNotMatch(visibleLog, /codesign_util/);
  assert.match(visibleLog, /Scheduled sync started/);
  assert.match(visibleLog, /31 个节点/);
});

test('desktop reads policy groups from the currently entered profile path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-policy-groups-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  await writeFile(
    profilePath,
    ['[Proxy Group]', 'Proxy = select, DIRECT', '自动选择 = url-test, VLESS, interval=600', 'VLESS = select, DIRECT', ''].join('\n'),
    'utf8',
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  assert.deepEqual(await service.inspectPolicyGroups({ surgeConfigPath: profilePath, policyGroupName: 'VLESS' }), [
    {
      name: 'Proxy',
      containsPolicyGroup: false,
      membershipMode: undefined,
      groupType: 'select',
      hasIncludeOtherGroup: false,
      hasPolicyRegexFilter: false,
      recommendedMode: 'reference',
    },
    {
      name: '自动选择',
      containsPolicyGroup: true,
      membershipMode: 'reference',
      groupType: 'url-test',
      hasIncludeOtherGroup: false,
      hasPolicyRegexFilter: false,
      recommendedMode: 'reference',
    },
  ]);
});

test('desktop detects VLESS referenced by a smart group include-other-group parameter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-smart-policy-group-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  await writeFile(
    profilePath,
    ['[Proxy Group]', 'VLESS = url-test, HK 01', '香港线路 = smart, include-other-group="HUB,VLESS", hidden=1', ''].join('\n'),
    'utf8',
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  assert.deepEqual(await service.inspectPolicyGroups({ surgeConfigPath: profilePath, policyGroupName: 'VLESS' }), [
    {
      name: '香港线路',
      containsPolicyGroup: true,
      membershipMode: 'merge',
      groupType: 'smart',
      hasIncludeOtherGroup: true,
      hasPolicyRegexFilter: false,
      recommendedMode: 'merge',
    },
  ]);
});

test('desktop policy group controls expose bulk selection and task-specific workflow icons', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const app = await readFile(path.join(__dirname, '..', 'desktop', 'app.js'), 'utf8');
  assert.match(html, /id="select-all-policy-groups"/);
  assert.match(html, /id="clear-policy-groups"/);
  assert.match(html, /策略组成员关系/);
  assert.match(app, /同步时移除 VLESS/);
  assert.match(app, /policyGroupExclusions/);
  assert.match(html, /data-workflow="sources"[^>]*>[\s\S]*?data-lucide="rss"/);
  assert.match(html, /data-workflow="schedule"[^>]*>[\s\S]*?data-lucide="calendar-clock"/);
  assert.match(html, /class="brand-mark"><i data-lucide="cable"/);
  assert.match(html, /id="check-sing-box-update"/);
  assert.match(html, /id="rollback-sing-box"/);
  assert.match(html, /id="sing-box-current-version"/);
  assert.match(html, /id="sing-box-latest-version"/);
  assert.match(html, /id="udp-relay" type="checkbox"/);
  assert.match(html, /id="udp-test-enabled" type="checkbox"/);
  assert.match(html, /id="udp-test-target" type="text"/);
  assert.match(html, /id="tcp-fast-open" type="checkbox"/);
  assert.match(html, /id="connect-timeout-enabled" type="checkbox"/);
  assert.match(html, /id="connect-timeout-seconds" type="number"/);
  assert.match(app, /updateConnectionOptionFields/);
});

test('desktop package collects renderer assets from stable source paths', async () => {
  const packageJson = JSON.parse(await readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const main = await readFile(path.join(__dirname, '..', 'src', 'desktop', 'main.ts'), 'utf8');
  const packagedSmoke = await readFile(path.join(__dirname, '..', 'scripts', 'smoke-packaged-scheduler.mjs'), 'utf8');
  const entitlements = await readFile(path.join(__dirname, '..', 'desktop', 'entitlements.mac.plist'), 'utf8');
  const resources = packageJson.build.extraResources;

  assert.deepEqual(resources[0], {
    from: 'desktop',
    to: 'renderer',
    filter: ['index.html', 'styles.css', 'app.js', 'boot.js'],
  });
  assert.deepEqual(resources[1], {
    from: 'node_modules/lucide/dist/umd/lucide.min.js',
    to: 'renderer/vendor/lucide.js',
  });
  assert.match(main, /process\.resourcesPath, 'renderer', 'index\.html'/);
  assert.match(main, /界面资源加载失败/);
  assert.match(packagedSmoke, /runtimeMode: 'external'/);
  assert.match(packagedSmoke, /runtimeModeConfirmed: true/);
  assert.equal(packageJson.build.mac.identity, '-');
  assert.equal(packageJson.build.mac.entitlements, 'desktop/entitlements.mac.plist');
  assert.equal(packageJson.build.mac.entitlementsInherit, 'desktop/entitlements.mac.plist');
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
});

test('macOS workflow publishes verified version-tag builds to GitHub Releases', async () => {
  const workflow = await readFile(path.join(__dirname, '..', '.github', 'workflows', 'build-macos.yml'), 'utf8');
  assert.match(workflow, /release:\n    name: Publish GitHub Release/);
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /expected_tag="v\$\{version\}"/);
  assert.match(workflow, /actions\/download-artifact@v7/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
});

test('desktop custom interval uses a full-width second row', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'desktop', 'styles.css'), 'utf8');
  assert.match(html, /class="field-grid schedule-grid"/);
  assert.match(html, /id="schedule-custom-interval" class="custom-interval-row hidden"/);
  assert.match(css, /\.interval-controls \{ display: grid; gap: 8px; min-width: 0; \}/);
  assert.match(css, /\.field-grid\.two \{[^}]*align-items: start;/);
  assert.match(css, /\.schedule-grid \{ grid-template-columns: 160px minmax\(300px, 1fr\); align-items: start; \}/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.schedule-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.custom-interval-row \{[^}]*grid-template-columns: auto minmax\(0, 1fr\)/);
  assert.match(css, /\.number-suffix \{[^}]*width: 100%;/);
  assert.doesNotMatch(css, /\.number-suffix \{[^}]*width: 160px;/);
});

test('desktop exposes named subscriptions, inline engine switching and install progress', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'desktop', 'styles.css'), 'utf8');
  const app = await readFile(path.join(__dirname, '..', 'desktop', 'app.js'), 'utf8');
  const preload = await readFile(path.join(__dirname, '..', 'src', 'desktop', 'preload.ts'), 'utf8');
  const main = await readFile(path.join(__dirname, '..', 'src', 'desktop', 'main.ts'), 'utf8');

  assert.match(html, /id="confirm-engine-switch"/);
  assert.match(html, /id="sing-box-install-progress"/);
  assert.match(html, /id="mihomo-install-progress"/);
  assert.match(html, /<details class="section-block advanced-settings">/);
  assert.match(app, /data-source-name/);
  assert.match(app, /subscriptionNames/);
  assert.doesNotMatch(css, /\.source-row:focus-within[^}]*box-shadow: inset 3px 0/);
  assert.match(css, /\.source-fields input:focus \{[^}]*box-shadow:/);
  assert.match(preload, /desktop:install-progress/);
  assert.match(main, /webContents\.send\('desktop:install-progress'/);
});

test('desktop startup is recoverable and topbar button labels have stable centering', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'desktop', 'styles.css'), 'utf8');
  const app = await readFile(path.join(__dirname, '..', 'desktop', 'app.js'), 'utf8');
  const boot = await readFile(path.join(__dirname, '..', 'desktop', 'boot.js'), 'utf8');

  assert.match(html, /id="reload-app"[^>]*class="button secondary hidden"/);
  assert.match(html, /<script src="boot\.js"><\/script>/);
  assert.match(boot, /读取配置超时，请重试/);
  assert.match(css, /\.topbar-actions \.button > span \{ display: inline-flex; align-items: center; line-height: 1; \}/);
  assert.match(css, /\.loading-cover\.failed \{ flex-direction: column; \}/);
  assert.match(app, /const STARTUP_TIMEOUT_MS = 12000;/);
  assert.match(app, /showStartupError\(message\)/);
});

test('desktop preview keeps its controls and columns inside narrow windows', async () => {
  const css = await readFile(path.join(__dirname, '..', 'desktop', 'styles.css'), 'utf8');
  assert.match(css, /\.preview-sheet \{[^}]*width: min\(820px, calc\(100vw - 56px\)\);[^}]*min-width: 0;/);
  assert.match(css, /\.preview-sheet \{[^}]*grid-template-rows: auto auto auto auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.preview-header \{ grid-row: 1;/);
  assert.match(css, /\.preview-node-table \{ grid-row: 5;/);
  assert.match(css, /\.preview-footer \{ grid-row: 6;/);
  assert.match(css, /\.preview-overlay \{[^}]*padding: 28px 28px max\(88px, env\(safe-area-inset-bottom\)\);/);
  assert.match(css, /\.preview-sheet \{[^}]*height: min\(700px, calc\(100vh - 144px\)\);[^}]*min-height: 460px;/);
  assert.match(css, /\.preview-sheet > \* \{ min-width: 0; \}/);
  assert.match(css, /\.preview-header > div \{ min-width: 0; \}/);
  assert.match(css, /grid-template-columns: minmax\(0, 1\.1fr\) minmax\(0, 1fr\) minmax\(72px, 90px\)/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.preview-metrics \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.preview-footer \{[^}]*flex-direction: column/);
});

test('desktop prioritizes engine selection and keeps narrow layouts usable', async () => {
  const html = await readFile(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'desktop', 'styles.css'), 'utf8');
  const app = await readFile(path.join(__dirname, '..', 'desktop', 'app.js'), 'utf8');

  assert.match(html, /id="engine-onboarding"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="confirm-engine-choice"[^>]*disabled/);
  assert.match(css, /\.engine-onboarding \{ position: fixed; inset: 0; z-index: 110;/);
  assert.match(css, /\.engine-onboarding-panel \{[^}]*max-height: calc\(100vh - 64px\);[^}]*overflow: auto;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.app-shell \{ grid-template-columns: 76px 1fr; \}/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.nav-item span \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.engine-choice-grid, \.engine-switch-grid, \.field-grid\.two \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.engine-summary strong, \.service-status strong \{[^}]*overflow-wrap: anywhere;/);
  assert.match(app, /document\.body\.classList\.toggle\('engine-choice-required', visible\)/);
  assert.match(app, /if \(!onboardingDraftMode\) return;/);
});

test('desktop settings preserve editable DNS resolver values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-dns-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  await writeFile(profilePath, PROFILE_TEXT, 'utf8');
  await writeFile(
    configPath,
    JSON.stringify({
      subscriptionUrls: ['data:text/plain,vless%3A%2F%2Fexample'],
      surgeConfigPath: profilePath,
      singBoxBinary: '/usr/bin/true',
      outputDir: path.join(root, 'nodes'),
      backupDir: path.join(root, 'backups'),
      subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
      autoReload: false,
    }),
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  const before = await service.getState();
  await service.saveSettings({
    ...before.config,
    policyGroupTargets: [' Proxy ', 'Proxy', 'VLESS', '自动选择'],
    policyGroupExclusions: [' 香港线路 ', '香港线路', 'Proxy'],
    addressResolverStrategy: 'dns',
    addressResolverDohEndpoint: 'https://dns.google/resolve',
    addressResolverDnsServers: ['9.9.9.9', '2620:fe::fe'],
    addressResolverFilterSurgeFakeIp: false,
    udpRelay: true,
    udpTestEnabled: true,
    udpTestTarget: 'example.com@1.1.1.1',
    tcpFastOpen: true,
    connectTimeoutEnabled: true,
    connectTimeoutSeconds: 20,
  });

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.addressResolver, {
    strategy: 'dns',
    dohEndpoint: 'https://dns.google/resolve',
    dnsServers: ['9.9.9.9', '2620:fe::fe'],
    filterSurgeFakeIp: false,
  });
  assert.deepEqual(saved.policyGroupTargets, ['Proxy', '自动选择']);
  assert.deepEqual(saved.policyGroupExclusions, ['香港线路']);
  assert.equal(saved.udpRelay, true);
  assert.equal(saved.udpTestEnabled, true);
  assert.equal(saved.udpTestTarget, 'example.com@1.1.1.1');
  assert.equal(saved.tcpFastOpen, true);
  assert.equal(saved.connectTimeoutEnabled, true);
  assert.equal(saved.connectTimeoutSeconds, 20);
});

test('desktop environment repair creates directories and backs up section changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-repair-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  const outputDir = path.join(root, 'nodes');
  const backupDir = path.join(root, 'backups');
  await writeFile(profilePath, '[General]\nloglevel = notify\n', 'utf8');
  await writeFile(
    configPath,
    JSON.stringify({
      subscriptionUrls: ['data:text/plain,vless%3A%2F%2Fexample'],
      surgeConfigPath: profilePath,
      singBoxBinary: '/usr/bin/true',
      outputDir,
      backupDir,
      subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
      autoReload: false,
    }),
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  assert.equal((await service.repairCheck('outputDir')).success, true);
  assert.equal((await service.repairCheck('backupDir')).success, true);
  assert.equal((await service.repairCheck('proxy-group-section')).success, true);
  assert.equal((await service.repairCheck('proxy-section')).success, true);

  const profile = await readFile(profilePath, 'utf8');
  assert.match(profile, /\[Proxy Group\]/);
  assert.match(profile, /\[Proxy\]/);
  const state = await service.getState();
  assert.equal(state.doctor.checks.find((check) => check.label === 'outputDir').level, 'ok');
  assert.equal(state.doctor.checks.find((check) => check.label === 'backupDir').level, 'ok');
  assert.equal(state.backups.length, 2);
});

test('desktop Mihomo repair creates only the active engine data directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-mihomo-repair-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  const mihomoDataDir = path.join(root, 'mihomo-data');
  const outputDir = path.join(root, 'external-nodes');
  await writeFile(profilePath, PROFILE_TEXT, 'utf8');
  await writeFile(
    configPath,
    JSON.stringify({
      runtimeMode: 'mihomo',
      mihomo: { binary: '/usr/bin/true', dataDir: mihomoDataDir, controllerSecret: '' },
      vlessNodes: [vlessLink(1, 'Mihomo Repair')],
      surgeConfigPath: profilePath,
      outputDir,
      backupDir: path.join(root, 'backups'),
      subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
      autoReload: false,
    }),
    'utf8',
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  assert.equal((await service.repairCheck('mihomo-data-dir')).success, true);
  assert.ok((await readdir(root)).includes('mihomo-data'));
  assert.ok(!(await readdir(root)).includes('external-nodes'));
});

test('desktop maintenance clears history and keeps the latest backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-desktop-maintenance-'));
  const configPath = path.join(root, 'config.json');
  const profilePath = path.join(root, 'profile.conf');
  const backupDir = path.join(root, 'backups');
  await writeFile(profilePath, '[General]\nloglevel = notify\n', 'utf8');
  await writeFile(
    configPath,
    JSON.stringify({
      subscriptionUrls: [],
      vlessNodes: [],
      surgeConfigPath: profilePath,
      singBoxBinary: '/usr/bin/true',
      outputDir: path.join(root, 'nodes'),
      backupDir,
      subscriptionOutputPath: path.join(root, 'vless_nodes.txt'),
      autoReload: false,
      backupKeep: 10,
    }),
  );
  const service = new DesktopService({
    configPath,
    executablePath: '/usr/bin/node',
    scheduledEntryPath: path.join(root, 'scheduled-run.js'),
  });

  await service.runAction('doctor');
  assert.equal(await service.clearHistory(), 1);
  assert.deepEqual((await service.getState()).history, []);

  await service.repairCheck('proxy-group-section');
  await service.repairCheck('proxy-section');
  const before = await service.getState();
  assert.equal(before.backups.length, 2);

  const result = await service.cleanOldBackups();
  assert.equal(result.deletedCount, 1);
  assert.equal(result.backups.length, 1);
  assert.equal(result.backups[0].name, before.backups[0].name);
  assert.deepEqual(await readdir(backupDir), [result.backups[0].name]);
});

test('official sing-box installer selects the native macOS archive and requires a digest', () => {
  const release = {
    tag_name: 'v1.2.3',
    assets: [
      {
        name: 'sing-box-1.2.3-darwin-amd64.tar.gz',
        browser_download_url: 'https://github.com/SagerNet/sing-box/releases/example-amd64',
        digest: 'sha256:abc',
        size: 10,
      },
      {
        name: 'sing-box-1.2.3-darwin-arm64.tar.gz',
        browser_download_url: 'https://github.com/SagerNet/sing-box/releases/example-arm64',
        digest: 'sha256:def',
        size: 10,
      },
    ],
  };

  assert.equal(selectOfficialAsset(release, 'arm64').name, 'sing-box-1.2.3-darwin-arm64.tar.gz');
  assert.equal(selectOfficialAsset(release, 'x64').name, 'sing-box-1.2.3-darwin-amd64.tar.gz');
  assert.throws(
    () => selectOfficialAsset({ ...release, assets: [{ ...release.assets[0], digest: undefined }] }, 'x64'),
    /SHA-256/,
  );
});

test('sing-box version management compares semantic versions and detects managed installs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-sing-box-version-'));
  const installDir = path.join(root, 'bin');
  const managedPath = path.join(installDir, 'sing-box');
  await mkdir(installDir, { recursive: true });
  await writeFile(managedPath, '#!/bin/sh\necho "sing-box version 1.14.3"\n', 'utf8');
  await writeFile(`${managedPath}.previous`, '#!/bin/sh\necho "sing-box version 1.13.4"\n', 'utf8');
  await chmod(managedPath, 0o755);
  await chmod(`${managedPath}.previous`, 0o755);

  assert.equal(normalizeSingBoxVersion('sing-box version 1.14.3'), '1.14.3');
  assert.equal(normalizeSingBoxVersion('v1.14.3'), '1.14.3');
  assert.equal(compareVersions('1.14.3', '1.9.9'), 1);
  assert.equal(compareVersions('1.14.3', '1.14.3'), 0);
  assert.equal(compareVersions('1.13.9', '1.14.0'), -1);

  const status = await inspectSingBoxVersion({ binaryPath: managedPath, managedPath });
  assert.equal(status.installed, true);
  assert.equal(status.currentVersion, '1.14.3');
  assert.equal(status.source, 'managed');
  assert.equal(status.rollbackAvailable, true);
});

test('managed sing-box rollback validates configs and preserves the replaced version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-sing-box-rollback-'));
  const installDir = path.join(root, 'bin');
  const outputDir = path.join(root, 'nodes');
  const managedPath = path.join(installDir, 'sing-box');
  const binary = (version) => `#!/bin/sh\nif [ "$1" = "version" ]; then echo "sing-box version ${version}"; exit 0; fi\nif [ "$1" = "check" ]; then exit 0; fi\nexit 1\n`;
  await mkdir(installDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(managedPath, binary('1.14.3'), 'utf8');
  await writeFile(`${managedPath}.previous`, binary('1.13.4'), 'utf8');
  await writeFile(path.join(outputDir, 'sing-box[2081].json'), '{}\n', 'utf8');
  await chmod(managedPath, 0o755);
  await chmod(`${managedPath}.previous`, 0o755);

  const result = await rollbackOfficialSingBox(installDir, outputDir);
  assert.equal(result.version, '1.13.4');
  assert.equal(result.previousVersion, '1.14.3');
  assert.match(await readFile(managedPath, 'utf8'), /1\.13\.4/);
  assert.match(await readFile(`${managedPath}.previous`, 'utf8'), /1\.14\.3/);
});
