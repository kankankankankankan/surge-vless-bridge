const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

// Exercise the real renderer and preload against local IPC fixtures without modifying user settings.
const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
const sourceOptions = () => ({ enabled: true, include: '', exclude: '', skipUnsupported: false });
const dependency = { installed: true, source: 'managed', currentVersion: '1.19.33', latestVersion: '1.19.33', rollbackAvailable: false };
const state = {
  configPath: '/tmp/bridge-fixture/config.json', configExists: true, runtimeModeConfirmed: true,
  config: {
    runtimeMode: 'mihomo', subscriptionUrls: ['https://example.invalid/one', 'https://example.invalid/two'],
    subscriptionNames: ['主订阅', '备用订阅'], subscriptionOptions: [sourceOptions(), sourceOptions()], vlessNodes: [],
    surgeConfigPath: '/tmp/bridge-fixture/profile.conf', singBoxBinary: '/tmp/bridge-fixture/sing-box', mihomoBinary: '/tmp/bridge-fixture/mihomo',
    mihomoDataDir: '/tmp/bridge-fixture/mihomo-data', mihomoControllerPort: 19090, mihomoAutoStart: true, mihomoLogLevel: 'info',
    policyGroupName: 'VLESS', policyGroupTargets: [], policyGroupExclusions: [], policyGroupTargetModes: {},
    portStart: 2081, backupKeep: 20, autoReload: true, udpRelay: true, udpTestEnabled: false, udpTestTarget: 'dns.google@8.8.8.8',
    tcpFastOpen: false, connectTimeoutEnabled: false, connectTimeoutSeconds: 5,
    addressResolverStrategy: 'off', addressResolverDohEndpoint: '', addressResolverDnsServers: [], addressResolverFilterSurgeFakeIp: true,
  },
  doctor: { checks: ['nodeSources', 'surgeConfigPath', 'mihomoBinary', 'proxy-group-section', 'proxy-section', 'rule-section', 'mihomo-config', 'mihomo-launch-agent', 'mihomo-controller', 'mihomo-listeners'].map(label => ({ label, level: 'ok', detail: '检查通过' })), failures: 0, warnings: 0 },
  nodeCount: 3, subscriptionStatuses: [], diagnosticNodes: [
    { name: 'HK 香港 长名称 '.repeat(6), port: 2081 }, { name: 'HK 香港 02', port: 2082 }, { name: 'JP 日本 01', port: 2083 },
  ],
  backups: [], history: [], profiles: [], policyGroups: [], schedulerLog: '',
  schedule: { enabled: false, kind: 'interval', intervalHours: 12, hour: 8, minute: 0, runAtLoad: false },
  environment: { managedSingBoxPath: '/tmp/bridge-fixture/sing-box', managedMihomoPath: '/tmp/bridge-fixture/mihomo',
    singBox: { ...dependency, currentVersion: '1.14.4' }, mihomo: dependency,
    mihomoService: { installed: true, loaded: true, running: true, controllerReady: true, serviceMatchesConfig: true, pid: 12345 }, controllerSecretConfigured: true },
};
let saved;
const diagnosed = [];
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
let root;
const evaluate = code => window.webContents.executeJavaScript(code);
const until = async code => {
  for (let index = 0; index < 100; index++) { if (await evaluate(code)) return; await wait(50); }
  throw new Error(`UI condition timed out: ${code}`);
};
const input = (selector, value) => evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const screenshot = async name => {
  if (!output) return;
  await wait(220);
  await writeFile(join(output, name), (await window.webContents.capturePage()).toPNG());
};

(async () => {
  root = await mkdtemp(join(tmpdir(), 'svb-ui-controls-'));
  app.setPath('userData', root);
  if (output) await mkdir(output, { recursive: true });
  ipcMain.handle('desktop:get-version', () => require('../package.json').version);
  ipcMain.handle('desktop:get-state', () => state);
  ipcMain.handle('desktop:inspect-policy-groups', () => []);
  ipcMain.handle('desktop:check-mihomo-update', () => dependency);
  ipcMain.handle('desktop:check-sing-box-update', () => state.environment.singBox);
  ipcMain.handle('desktop:preview-source-filters', (_event, { options }) => ({ available: true, total: 3, matched: options.include ? 2 : 3, skipped: 0 }));
  ipcMain.handle('desktop:save-sources', (_event, value) => { saved = value; Object.assign(state.config, value); return state; });
  ipcMain.handle('desktop:diagnose-node', async (_event, node) => {
    diagnosed.push(node); await wait(300);
    const part = { success: true, skipped: false, detail: '测试通过', target: 'fixture.invalid', latencyMs: 12 };
    return { testedAt: new Date().toISOString(), tcp: part, udp: node.port === 2082 ? { ...part, success: false, detail: '等待 DNS 响应超时' } : part };
  });
  await app.whenReady();
  window = new BrowserWindow({ width: 1180, height: 780, show: false,
    webPreferences: { preload: resolve('dist/desktop/preload.js'), contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(resolve('dist/desktop/renderer/index.html'));
  await until(`document.querySelector('#loading-cover').classList.contains('hidden') && document.querySelectorAll('[data-diagnostic-port]').length===3`);
  await input('#diagnostic-search', 'HK');
  await click('#diagnostic-select-all');
  assert.equal(await evaluate(`document.querySelectorAll('[data-diagnostic-port]:checked').length`), 2);
  await click('#diagnose-node');
  await until(`!document.querySelector('#diagnostic-stop').disabled`);
  await click('#diagnostic-stop');
  await until(`document.querySelector('#diagnostic-progress').textContent.includes('已停止')`);
  assert.equal(diagnosed.length, 1);
  await click('#diagnose-node');
  await until(`document.querySelector('#diagnostic-progress').textContent.includes('检测完成')`);
  assert.equal(diagnosed.length, 3);
  assert.equal(await evaluate(`document.querySelectorAll('.diagnostic-outcome.status-warning').length`), 1);
  await evaluate(`document.querySelector('#node-diagnostics').scrollIntoView({block:'start',behavior:'instant'})`);
  await wait(150);
  await screenshot('diagnostics-1180.png');
  await click('[data-view="sources"]');
  assert.equal(await evaluate(`document.querySelector('.main-content').scrollTop`), 0);
  await input('[data-source-option="include"][data-source-index="0"]', 'HK');
  await click('[data-source-option="skipUnsupported"][data-source-index="0"]');
  await click('[data-source-option="enabled"][data-source-index="1"]');
  await until(`document.querySelector('[data-source-filter-preview="0"]').textContent.includes('2 / 3')`);
  await evaluate(`document.querySelector('#sources-form').requestSubmit()`);
  await until(`document.querySelector('#loading-cover').classList.contains('hidden') && !document.querySelector('#sources-form button[type="submit"]').disabled`);
  assert.equal(saved.subscriptionOptions[0].include, 'HK');
  assert.equal(saved.subscriptionOptions[0].skipUnsupported, true);
  assert.equal(saved.subscriptionOptions[1].enabled, false);
  for (const width of [1180, 720]) {
    window.setContentSize(width, width === 720 ? 680 : 780);
    await wait(100);
    await screenshot(`sources-${width}.png`);
    const overflow = await evaluate(`Array.from(document.querySelectorAll('#view-sources input, #view-sources button, #view-sources summary')).filter(el=>el.getClientRects().length).filter(el=>{const r=el.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1}).map(el=>el.outerHTML.slice(0,100))`);
    assert.deepEqual(overflow, []);
  }
  await click('[data-source-remove="subscription"][data-source-index="0"]');
  assert.equal(await evaluate(`document.querySelector('[data-source-option="enabled"]').checked`), false);
  await click('[data-view="overview"]');
  await until(`document.querySelector('#view-overview').classList.contains('active')`);
  await evaluate(`document.querySelector('#node-diagnostics').scrollIntoView({block:'start',behavior:'instant'})`);
  await wait(150);
  await screenshot('diagnostics-720.png');
  const overflow = await evaluate(`document.querySelector('#node-diagnostics').scrollWidth > document.querySelector('#node-diagnostics').clientWidth`);
  assert.equal(overflow, false);
  if (output) {
    await until(`!document.querySelector('#toast').classList.contains('show')`);
    for (const width of [1180, 960, 720]) {
      window.setContentSize(width, width === 720 ? 680 : 780);
      for (const view of ['overview', 'schedule', 'history', 'settings']) {
        await click(`[data-view="${view}"]`);
        await wait(150);
        await screenshot(`${view}-${width}.png`);
        const outside = await evaluate(`Array.from(document.querySelectorAll('.view.active input, .view.active button, .view.active select, .topbar button')).filter(el=>el.getClientRects().length).filter(el=>{const r=el.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1}).map(el=>el.id || el.textContent)`);
        assert.deepEqual(outside, [], `${view} at ${width}px`);
        assert.equal(await evaluate(`document.querySelectorAll('.view.active i[data-lucide]').length`), 0, 'All visible icons must render');
        const centers = await evaluate(`Array.from(document.querySelectorAll('.topbar-actions .button')).map(button=>{const r=button.getBoundingClientRect(); const children=Array.from(button.children).map(el=>el.getBoundingClientRect()); return Math.abs((Math.min(...children.map(r=>r.top))+Math.max(...children.map(r=>r.bottom)))/2-(r.top+r.bottom)/2);})`);
        assert.ok(centers.every(offset => offset < 2), 'Toolbar content must remain vertically centered');
        if (view === 'schedule') {
          await click('#schedule-enabled');
          await evaluate(`document.querySelector('#schedule-interval-preset').value='custom';document.querySelector('#schedule-interval-preset').dispatchEvent(new Event('change',{bubbles:true}))`);
          assert.ok(await evaluate(`(() => { const select=document.querySelector('#schedule-interval-preset').getBoundingClientRect(); const hours=document.querySelector('#schedule-interval-custom').getBoundingClientRect(); const container=document.querySelector('.interval-controls'); return Math.abs((select.top+select.bottom)/2-(hours.top+hours.bottom)/2)<2 && hours.left>select.right && container.scrollWidth<=container.clientWidth; })()`), `Custom hours must stay beside the preset without overflow at ${width}px`);
          await screenshot(`schedule-custom-${width}.png`);
          await evaluate(`document.querySelector('#schedule-kind').value='daily';document.querySelector('#schedule-kind').dispatchEvent(new Event('change',{bubbles:true}))`);
          await screenshot(`schedule-daily-${width}.png`);
          await evaluate(`document.querySelector('#schedule-kind').value='interval';document.querySelector('#schedule-kind').dispatchEvent(new Event('change',{bubbles:true}))`);
          await click('#schedule-enabled');
        }
      }
      await evaluate(`document.querySelector('#mihomo-settings details').open=true; document.querySelector('#mihomo-settings details').scrollIntoView({block:'center',behavior:'instant'})`);
      await wait(150);
      await screenshot(`settings-advanced-${width}.png`);
      await click('#open-setup-wizard');
      await wait(150);
      await screenshot(`wizard-${width}.png`);
      assert.ok(await evaluate(`(() => {const area=document.querySelector('#setup-step-engine').getBoundingClientRect();const button=document.querySelector('#onboarding-install-mihomo-direct').getBoundingClientRect();return button.bottom<=area.bottom;})()`), 'The engine install button must be visible without scrolling');
      for (let step = 2; step <= 4; step++) {
        await click('#setup-wizard-next');
        await until(`document.querySelector('[data-setup-step-indicator="${step}"]').classList.contains('active')`);
        await screenshot(`wizard-step-${step}-${width}.png`);
      }
      assert.equal(await evaluate(`document.querySelector('#engine-onboarding-status').classList.contains('error')`), false);
      await click('#close-setup-wizard');
    }
  }
  assert.deepEqual(errors, []);
  console.log('Desktop controls passed: filtering, save alignment, disabled source, batch selection/progress/stop, narrow layout.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  window?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
