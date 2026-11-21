/**
 * [INPUT]: Built renderer, preload and isolated IPC fixtures.
 * [OUTPUT]: Interaction assertions and optional screenshots across themes and widths.
 * [POS]: Desktop acceptance check; never operates on user subscriptions or services.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
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
    mihomoDnsMode: 'dns', mihomoDnsServers: ['192.0.2.53'], mihomoDohEndpoint: 'https://dns.example/dns-query', mihomoDnsIpv6: true, mihomoTcpConcurrent: true,
    policyGroupName: 'VLESS', policyGroupTargets: [], policyGroupExclusions: [], policyGroupTargetModes: {},
    portStart: 2081, backupKeep: 20, autoReload: true, udpRelay: true, udpTestEnabled: false, udpTestTarget: 'dns.google@8.8.8.8',
    tcpFastOpen: false, connectTimeoutEnabled: false, connectTimeoutSeconds: 5,
    subscriptionProxyUrl: '', anytlsSniOverrides: [],
    addressResolverStrategy: 'off', addressResolverDohEndpoint: '', addressResolverDnsServers: [], addressResolverFilterSurgeFakeIp: true,
  },
  doctor: { checks: ['nodeSources', 'surgeConfigPath', 'mihomoBinary', 'proxy-group-section', 'proxy-section', 'rule-section', 'mihomo-config', 'mihomo-launch-agent', 'mihomo-controller', 'mihomo-listeners'].map(label => ({ label, level: 'ok', detail: '检查通过' })), failures: 0, warnings: 0 },
  anytlsNodes: [{ name: 'AnyTLS 示例节点', server: 'anytls.example', port: 443, sourceSni: '' },
    { name: 'AnyTLS 长名称 '.repeat(8), server: `${'edge-'.repeat(10)}node.example`, port: 8443, sourceSni: 'source.example' }],
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
let smokeExitCode = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
let root;
let releaseStartup;
const startupGate = new Promise(resolve => { releaseStartup = resolve; });
let firstStateRequest = true;
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

const assertThemeContrast = async label => {
  const lowContrast = await evaluate(`(() => {
    const rgb = value => value.match(/[\\d.]+/g).map(Number);
    const luminance = values => values.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const failures = [];
    for (const el of document.querySelectorAll('#page-subtitle, .view.active .section-heading p, .view.active .field-help, .view.active .engine-switch-option small, .view.active .appearance-control button, .view.active input[type="text"], .view.active select, .topbar-actions .button, .preview-sheet p, .preview-footer > span')) {
      if (!el.getClientRects().length || el.disabled) continue;
      let parent = el, background;
      while (parent) {
        const color = rgb(getComputedStyle(parent).backgroundColor);
        if (color.length===3 || color[3] >= .99) { background = color; break; }
        parent = parent.parentElement;
      }
      if (!background) continue;
      const fg = luminance(rgb(getComputedStyle(el).color)), bg = luminance(background);
      const ratio = (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
      if (ratio < 4.5) failures.push({element:el.id || el.className,ratio});
    }
    return failures;
  })()`);
  assert.deepEqual(lowContrast, [], `${label}: body text contrast must be at least 4.5:1`);
};

const assertSpinnerMoves = async label => {
  const selector = '#loading-cover .spinner';
  const before = await evaluate(`(() => { const el=document.querySelector('${selector}'); const r=el.getBoundingClientRect(); return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height),transform:getComputedStyle(el).transform,display:getComputedStyle(el).display,hidden:el.closest('.hidden')!==null}; })()`);
  assert.equal(before.hidden, false, `${label}: spinner must be visible`);
  assert.notEqual(before.display, 'none');
  assert.ok(before.width > 0 && before.height > 0);
  const rect = { x: before.x - 4, y: before.y - 4, width: before.width + 8, height: before.height + 8 };
  const frameA = (await window.webContents.capturePage(rect)).toPNG();
  const sidebarBefore = await evaluate(`getComputedStyle(document.querySelector('#refresh-state svg')).transform`);
  await wait(140);
  const transform = await evaluate(`getComputedStyle(document.querySelector('${selector}')).transform`);
  const frameB = (await window.webContents.capturePage(rect)).toPNG();
  assert.notEqual(before.transform, transform, `${label}: rotation must advance without seeking the timeline`);
  assert.notDeepEqual(frameA, frameB, `${label}: rendered spinner pixels must change`);
  assert.notEqual(sidebarBefore, await evaluate(`getComputedStyle(document.querySelector('#refresh-state svg')).transform`), `${label}: sidebar refresh icon must rotate`);
  assert.equal(await evaluate(`document.querySelector('#refresh-state').classList.contains('is-loading')`), true);
  if (output) {
    await writeFile(join(output, `${label}-frame-a.png`), frameA);
    await writeFile(join(output, `${label}-frame-b.png`), frameB);
  }
};

(async () => {
  root = await mkdtemp(join(tmpdir(), 'svb-ui-controls-'));
  app.setPath('userData', root);
  if (output) await mkdir(output, { recursive: true });
  ipcMain.handle('desktop:get-version', () => require('../package.json').version);
  ipcMain.handle('desktop:get-state', async () => {
    if (firstStateRequest) {
      firstStateRequest = false;
      await startupGate;
    }
    return state;
  });
  ipcMain.handle('desktop:inspect-policy-groups', () => []);
  ipcMain.handle('desktop:check-mihomo-update', () => dependency);
  ipcMain.handle('desktop:check-sing-box-update', () => state.environment.singBox);
  ipcMain.handle('desktop:preview-source-filters', (_event, { options }) => ({ available: true, total: 3, matched: options.include ? 2 : 3, skipped: 0 }));
  ipcMain.handle('desktop:save-sources', (_event, value) => { saved = value; Object.assign(state.config, value); return state; });
  ipcMain.handle('desktop:save-settings', (_event, value) => { Object.assign(state.config, value); return state; });
  ipcMain.handle('desktop:confirm', () => true);
  ipcMain.handle('desktop:switch-engine', async (_event, targetMode) => {
    await wait(1100);
    state.config.runtimeMode = targetMode;
    return { success: true, message: `已切换到 ${targetMode}` };
  });
  ipcMain.handle('desktop:diagnose-node', async (_event, node) => {
    diagnosed.push(node); await wait(300);
    const part = { success: true, skipped: false, detail: '测试通过', target: 'fixture.invalid', latencyMs: 12.6 };
    return { testedAt: new Date().toISOString(), tcp: part, udp: node.port === 2082 ? { ...part, success: false, detail: '等待 DNS 响应超时' } : part };
  });
  await app.whenReady();
  nativeTheme.themeSource = 'dark';
  window = new BrowserWindow({ width: 1180, height: 780, show: false,
    webPreferences: { preload: resolve('dist/desktop/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.once('ready-to-show', () => window.showInactive());
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadFile(resolve('dist/desktop/renderer/index.html'));
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark', 'First paint must follow the system dark theme');
  await until(`document.querySelector('#refresh-state').classList.contains('is-loading')`);
  await assertSpinnerMoves('startup');
  assert.equal(await evaluate(`document.querySelector('#loading-status').textContent`), '正在读取配置');
  await screenshot('startup-loading.png');
  releaseStartup();
  await until(`document.querySelector('#loading-cover').classList.contains('hidden') && document.querySelectorAll('[data-diagnostic-port]').length===3`);
  assert.equal(await evaluate(`document.querySelector('#diagnostics-nav').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelector('#history-scheduler-log') !== null && document.querySelector('#copy-diagnostic-report') !== null`), true);
  await click('#diagnostics-nav');
  await until(`document.querySelector('#page-title').textContent === '节点诊断'`);
  assert.equal(await evaluate(`document.querySelectorAll('.nav-item.active').length`), 1);
  await click('[data-view="history"]');
  assert.equal(await evaluate(`document.querySelector('#export-diagnostic-report') !== null`), true);
  await click('[data-view="policy-groups"]');
  await until(`document.querySelector('#page-title').textContent === '策略组'`);
  assert.equal(await evaluate(`document.querySelector('#save-policy-groups') !== null`), true);
  await click('[data-view="overview"]');
  assert.equal(await evaluate(`document.querySelectorAll('.nav-item.active').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#refresh-state').classList.contains('is-loading')`), false);
  nativeTheme.themeSource = 'light';
  await until(`document.documentElement.dataset.theme === 'light'`);
  assert.equal(await evaluate(`document.querySelector('#traffic-flow-note').textContent.includes('桥接后端出站')`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#schedule-run-at-load').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#schedule-options').classList.contains('is-disabled')`), true);
  assert.equal(await evaluate(`document.querySelector('#schedule-options').getAttribute('aria-disabled')`), 'true');
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
  const diagnosticText = await evaluate(`document.querySelector('#diagnostic-list').textContent`);
  assert.match(diagnosticText, /通过 · 13 ms/);
  assert.doesNotMatch(diagnosticText, /12\.6/);
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
  for (const width of [1180, 960, 720]) {
    if (width === 720) {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    window.setContentSize(width, width === 720 ? 680 : 780);
    await until(`innerWidth === ${width}`);
    await click('[data-view="settings"]');
    const targetMode = state.config.runtimeMode === 'mihomo' ? 'external' : 'mihomo';
    await click(`[data-runtime-mode="${targetMode}"]`);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await evaluate(`document.querySelector('.main-content').scrollTop=document.querySelector('.main-content').scrollHeight`);
    const scrollTop = await evaluate(`document.querySelector('.main-content').scrollTop`);
    assert.ok(scrollTop > 0, `Settings must be scrollable at ${width}px`);
    await click('#confirm-engine-switch');
    await until(`document.querySelector('#loading-cover').classList.contains('window-lock')`);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const lockState = await evaluate(`(() => { const cover=document.querySelector('#loading-cover'); const rect=cover.getBoundingClientRect(); const main=document.querySelector('.main-content'); const style=getComputedStyle(cover); return {position:style.position, centerX:(rect.left+rect.right)/2, centerY:(rect.top+rect.bottom)/2, viewportX:innerWidth/2, viewportY:innerHeight/2, inert:document.querySelector('.app-shell').inert, overflow:getComputedStyle(main).overflow, scrollTop:main.scrollTop}; })()`);
    assert.equal(lockState.position, 'fixed');
    assert.ok(Math.abs(lockState.centerX - lockState.viewportX) < 1 && Math.abs(lockState.centerY - lockState.viewportY) < 1, `Loading cover must stay centered at ${width}px`);
    assert.equal(lockState.inert, true);
    assert.equal(lockState.overflow, 'hidden');
    assert.equal(lockState.scrollTop, scrollTop);
    await assertSpinnerMoves(`engine-switch-${width}`);
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.floor(width / 2), y: 300, deltaY: -480, canScroll: true });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageUp' });
    await evaluate(`document.querySelector('.main-content').scrollTop=0`);
    await wait(80);
    assert.equal(await evaluate(`document.querySelector('.main-content').scrollTop`), scrollTop, `Scroll position must remain locked at ${width}px`);
    await screenshot(`engine-switch-lock-${width}.png`);
    await until(`document.querySelector('#loading-cover').classList.contains('hidden')`);
    assert.equal(await evaluate(`document.documentElement.classList.contains('is-window-locked') || document.querySelector('.app-shell').inert`), false);
    const restoredScroll = await evaluate(`(() => { const main=document.querySelector('.main-content'); return {top:main.scrollTop, max:main.scrollHeight-main.clientHeight}; })()`);
    assert.ok(Math.abs(restoredScroll.top - Math.min(scrollTop, restoredScroll.max)) < 1, `Scroll position must restore to the nearest valid position at ${width}px`);
    assert.equal(state.config.runtimeMode, targetMode);
  }
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  window.webContents.debugger.detach();
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
        if (view === 'overview' && width <= 850) {
          assert.equal(await evaluate(`Array.from(document.querySelectorAll('#traffic-flow-track .traffic-flow-arrow')).every(el => getComputedStyle(el).display !== 'none' && getComputedStyle(el).transform !== 'none')`), true, 'Narrow traffic flow must keep directional arrows');
        }
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
        if (view === 'settings') {
          const customDnsBeforePresets = await evaluate(`document.querySelector('#mihomo-dns-servers').value`);
          await evaluate(`document.querySelector('#mihomo-dns-preset').value='cloudflare-doh';document.querySelector('#mihomo-dns-preset').dispatchEvent(new Event('change',{bubbles:true}))`);
          assert.equal(await evaluate(`document.querySelector('#mihomo-doh-endpoint').value`), 'https://1.1.1.1/dns-query');
          await evaluate(`document.querySelector('#mihomo-dns-preset').value='google-dns';document.querySelector('#mihomo-dns-preset').dispatchEvent(new Event('change',{bubbles:true}))`);
          assert.equal(await evaluate(`document.querySelector('#mihomo-dns-servers').value`), '8.8.8.8\n8.8.4.4');
          await evaluate(`document.querySelector('#mihomo-dns-preset').value='custom-dns';document.querySelector('#mihomo-dns-preset').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#mihomo-dns-preset').scrollIntoView({block:'center',behavior:'instant'})`);
          assert.equal(await evaluate(`document.querySelector('#mihomo-dns-servers').value`), customDnsBeforePresets);
          await input('#mihomo-dns-servers', '192.0.2.54');
          assert.equal(await evaluate(`document.querySelector('#mihomo-dns-preset').value`), 'custom-dns');
          await wait(100);
          await screenshot(`settings-mihomo-dns-${width}.png`);
          assert.equal(await evaluate(`document.querySelector('#mihomo-dns-servers-field').classList.contains('hidden')`), false);
          assert.ok(await evaluate(`(() => { const section=document.querySelector('#mihomo-dns-preset').closest('.section-block'); return section.scrollWidth<=section.clientWidth; })()`), `Mihomo DNS settings must not overflow at ${width}px`);
          await click('[data-runtime-mode="external"]');
          await evaluate(`document.querySelector('#resolver-preset').value='alidns-dot';document.querySelector('#resolver-preset').dispatchEvent(new Event('change',{bubbles:true}))`);
          assert.equal(await evaluate(`document.querySelector('#doh-endpoint').value`), 'tls://dns.alidns.com:853');
          assert.equal(await evaluate(`document.querySelector('#external-encrypted-dns-label').textContent`), 'DoT 地址');
          await input('#doh-endpoint', 'tls://dot.example:853');
          assert.equal(await evaluate(`document.querySelector('#resolver-preset').value`), 'custom-dot');
          await evaluate(`document.querySelector('#resolver-preset').scrollIntoView({block:'center',behavior:'instant'})`);
          await wait(100);
          await screenshot(`settings-external-dns-${width}.png`);
          assert.ok(await evaluate(`(() => { const section=document.querySelector('#resolver-preset').closest('.section-block'); return section.scrollWidth<=section.clientWidth; })()`), `External DNS settings must not overflow at ${width}px`);
          await click('[data-runtime-mode="mihomo"]');
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
  state.config.runtimeMode = 'surge-native';
  state.subscriptionStatuses = [{ state: 'fresh', count: 38, lastSuccessAt: new Date().toISOString(),
    notices: ['第 7 个节点：Surge 原生使用自身 TLS 指纹，订阅的自定义指纹不参与转换。'] }];
  await click('#refresh-state');
  await until(`document.querySelector('#loading-cover').classList.contains('hidden')`);
  await click('[data-view="settings"]');
  assert.ok(await evaluate(`document.querySelectorAll('#surge-profile-select option').length >= 1`));
  await click('[data-view="settings"]');
  await click('[data-runtime-mode="external"]');
  assert.equal(await evaluate(`document.querySelector('#port-start-field').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelector('#udp-test-option').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelector('#external-resolver-settings').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelector('#mihomo-settings').classList.contains('hidden')`), true);
  await click('[data-runtime-mode="mihomo"]');
  assert.equal(await evaluate(`document.querySelector('#port-start-field').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelector('#udp-test-option').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelector('#external-resolver-settings').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`document.querySelector('#mihomo-settings').classList.contains('hidden')`), false);
  await click('[data-runtime-mode="surge-native"]');
  assert.equal(await evaluate(`document.querySelector('#port-start-field').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`document.querySelector('#udp-test-option').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`document.querySelector('#external-resolver-settings').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`document.querySelector('#mihomo-settings').classList.contains('hidden')`), true);
  await click('[data-runtime-mode="surge-native"]');
  assert.equal(await evaluate(`document.querySelector('#anytls-sni-settings').classList.contains('hidden')`), false);
  assert.equal(await evaluate(`document.querySelectorAll('[data-anytls-server]').length`), 2);
  await input('#anytls-sni-0', 'cert.example');
  await evaluate(`document.querySelector('#settings-form').requestSubmit()`);
  await until(`document.querySelector('#toast').textContent.includes('设置已保存')`);
  assert.deepEqual(state.config.anytlsSniOverrides, [{ server: 'anytls.example', port: 443, sni: 'cert.example' }]);
  await input('#anytls-sni-0', '');
  await input('#anytls-sni-0-verify', 'verify.example');
  await input('#anytls-sni-0-reuse', 'false');
  await evaluate(`document.querySelector('#settings-form').requestSubmit()`);
  await until(`!document.querySelector('#settings-form button[type="submit"]').disabled`);
  assert.deepEqual(state.config.anytlsSniOverrides, [{ server: 'anytls.example', port: 443, sni: '', certificateVerifyName: 'verify.example', reuse: false }]);
  await input('#anytls-sni-0-verify', '');
  await input('#anytls-sni-0-reuse', '');
  await evaluate(`document.querySelector('#settings-form').requestSubmit()`);
  await until(`document.querySelector('#anytls-sni-0').value === '' && !document.querySelector('#settings-form button[type="submit"]').disabled`);
  assert.deepEqual(state.config.anytlsSniOverrides, []);
  await click('[data-view="sources"]');
  assert.match(await evaluate(`document.querySelector('#source-protocol-hint').textContent`), /AnyTLS.*Hysteria2.*TUIC/);
  assert.equal(await evaluate(`document.querySelector('#direct-node-title').textContent`), '直接代理节点');
  await evaluate(`document.querySelector('#subscription-statuses details').open=true`);
  for (const width of [1180, 720]) {
    window.setContentSize(width, width === 720 ? 680 : 780);
    await evaluate(`document.querySelector('#subscription-statuses').scrollIntoView({block:'center',behavior:'instant'})`);
    await wait(120);
    assert.ok(await evaluate(`(() => {const el=document.querySelector('#view-sources');return el.scrollWidth<=el.clientWidth})()`), 'Native source details must not overflow');
    await screenshot(`native-sources-${width}.png`);
  }
  window.setContentSize(1180, 780);
  await click('[data-view="settings"]');
  await evaluate(`document.querySelector('.main-content').scrollTop=0`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.engine-brand-icon')).every(img=>img.complete && img.naturalWidth>0)`), true, 'Every engine must show its packaged project artwork');
  assert.equal(await evaluate(`document.querySelector('#runtime-mode-native img').getAttribute('src')`), 'assets/engines/surge.png');
  await click('[data-appearance="dark"]');
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
  await window.webContents.reload();
  await until(`document.querySelector('#loading-cover').classList.contains('hidden') && document.querySelector('#runtime-mode-control')`);
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark', 'Explicit theme must survive a renderer reload');
  // Exercise Electron's actual macOS theme propagation instead of CDP media emulation.
  nativeTheme.themeSource = 'light';
  await until(`!matchMedia('(prefers-color-scheme: dark)').matches`);
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark', 'System changes must not override an explicit preference');
  await click('[data-view="settings"]');
  await click('[data-appearance="system"]');
  await until(`document.documentElement.dataset.theme === 'light'`);
  nativeTheme.themeSource = 'dark';
  await until(`matchMedia('(prefers-color-scheme: dark)').matches`);
  await until(`document.documentElement.dataset.theme === 'dark'`);
  for (const theme of ['light', 'dark']) {
    await click(`[data-appearance="${theme}"]`);
    for (const width of [1180, 720]) {
      window.setContentSize(width, width === 720 ? 680 : 780);
      for (const view of ['overview', 'sources', 'policy-groups', 'schedule', 'history', 'settings']) {
        await click(`[data-view="${view}"]`);
        await evaluate(`document.querySelector('.main-content').scrollTop=0`);
        const outside = await evaluate(`Array.from(document.querySelectorAll('.view.active button, .view.active input, .view.active select')).filter(el=>el.getClientRects().length).filter(el=>{const r=el.getBoundingClientRect();return r.left<0||r.right>innerWidth+1}).map(el=>el.id)`);
        assert.deepEqual(outside, [], `${theme} ${view} at ${width}px`);
        await assertThemeContrast(`${theme} ${view} at ${width}px`);
        await screenshot(`${theme}-${view}-${width}.png`);
        if (view === 'settings') {
          await evaluate(`document.querySelector('#anytls-sni-settings').scrollIntoView({block:'center',behavior:'instant'})`);
          const sniOverflow = await evaluate(`Array.from(document.querySelectorAll('.anytls-sni-row')).filter(el=>el.scrollWidth>el.clientWidth+1).length`);
          assert.equal(sniOverflow, 0, `AnyTLS SNI rows must fit ${theme} ${width}px`);
          await screenshot(`anytls-sni-${theme}-${width}.png`);
        }
      }
      await evaluate(`document.querySelector('.appearance-control').scrollIntoView({block:'center',behavior:'instant'})`);
      await screenshot(`${theme}-appearance-${width}.png`);
      await click('#open-setup-wizard');
      await screenshot(`${theme}-wizard-${width}.png`);
      await click('#close-setup-wizard');
      await evaluate(`renderPreview({count:3,added:1,removed:0,profileChanged:true,policyGroupName:'VLESS',policyGroupTargets:[],policyGroupExclusions:[],surgeConfigPath:'/tmp/bridge-fixture/profile.conf',nodes:[{name:'HK 示例节点',server:'node.example.com',port:2081}],udpRelay:true}); document.querySelector('#preview-overlay').classList.remove('hidden')`);
      await assertThemeContrast(`${theme} preview`);
      await screenshot(`${theme}-preview-${width}.png`);
      await click('#close-preview');
      await evaluate(`showToast('示例：连接失败，请查看诊断结果。', true)`);
      await screenshot(`${theme}-error-${width}.png`);
      await evaluate(`document.querySelector('#toast').classList.remove('show')`);
    }
  }
  await evaluate(`document.querySelector('[data-appearance="dark"]').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
  await until(`document.documentElement.dataset.themePreference === 'light'`);
  assert.equal(await evaluate(`document.activeElement.dataset.appearance`), 'light');
  await click('[data-appearance="system"]');
  assert.deepEqual(errors, []);
  console.log('Desktop controls passed: filtering, save alignment, disabled source, batch selection/progress/stop, narrow layout.');
})().catch(error => { console.error(error); smokeExitCode = 1; }).finally(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  app.exit(smokeExitCode);
});
