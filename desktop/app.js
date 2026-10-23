const api = window.surgeBridge;

const pageMeta = {
  overview: ['概览', '从节点来源到自动同步的完整流程'],
  sources: ['订阅与节点', '逐项管理并验证节点来源'],
  schedule: ['定时任务', '配置 macOS 后台自动同步'],
  history: ['历史与备份', '查看结果并恢复 Surge 配置'],
  settings: ['设置', '配置路径与生成选项'],
};

const labelMap = {
  nodeSources: '节点来源',
  surgeConfigPath: 'Surge 配置',
  singBoxBinary: 'sing-box',
  outputDir: '节点目录',
  backupDir: '备份目录',
  'proxy-group-section': '策略组区块',
  'proxy-section': '代理区块',
  'surge-http-api': 'Surge 重载',
  ports: '本地端口',
};

const actionMap = {
  doctor: '环境检查',
  preview: '预览更新',
  sync: '手动同步',
  rebuild: '本地重建',
  restore: '恢复备份',
  clean: '清理配置',
  'scheduled-sync': '定时同步',
  'repair-environment': '环境修复',
  'install-sing-box': '安装 sing-box',
  'update-sing-box': '更新 sing-box',
  'rollback-sing-box': '回退 sing-box',
};

let state;
let activeView = 'overview';
let busy = false;
let selectedHistoryId;
let toastTimer;
let previewPlan;
let nextAction = 'preview';
let sourceDraft = { subscriptionUrls: [], vlessNodes: [] };
let secretsVisible = false;
let sourcesDirty = false;
let singBoxUpdateChecked = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const formatDate = (value, withTime = true) => {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date);
};

const showToast = (message, isError = false) => {
  const toast = $('#toast');
  toast.classList.toggle('error', isError);
  toast.querySelector('span').textContent = message;
  toast.querySelector('i, svg')?.setAttribute('data-lucide', isError ? 'circle-alert' : 'circle-check');
  window.lucide?.createIcons();
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
};

const setBusy = (value, text = '正在处理') => {
  busy = value;
  const cover = $('#loading-cover');
  cover.querySelector('span').textContent = text;
  cover.classList.toggle('hidden', !value);
  $$('button').forEach((button) => {
    if (!button.classList.contains('nav-item')) button.disabled = value;
  });
  if (!value && state?.environment?.singBox) renderSingBoxDependency();
};

const switchView = (view) => {
  activeView = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  $('#page-title').textContent = pageMeta[view][0];
  $('#page-subtitle').textContent = pageMeta[view][1];
  window.scrollTo(0, 0);
};

const checkByLabel = (label) => state.doctor.checks.find((check) => check.label === label);

const doctorAction = (check) => {
  if (check.level === 'ok') return '';
  if (check.label === 'nodeSources') return '<button class="mini-button" data-check-nav="sources">配置</button>';
  if (check.label === 'singBoxBinary') return '<button class="mini-button" data-check-nav="sing-box">安装</button>';
  if (check.label === 'surgeConfigPath' && state.profiles.length === 0) {
    return '<button class="mini-button" data-check-nav="surge-profile">选择</button>';
  }
  if (['surgeConfigPath', 'outputDir', 'backupDir', 'proxy-group-section', 'proxy-section'].includes(check.label)) {
    return `<button class="mini-button" data-repair-check="${escapeHtml(check.label)}">修复</button>`;
  }
  return '';
};

const doctorDetail = (check) => {
  if (check.label === 'nodeSources') {
    return `${state.config.subscriptionUrls.length} 个订阅，${state.config.vlessNodes.length} 个直接节点`;
  }
  if (check.label === 'surge-http-api') {
    if (!state.config.autoReload) return '已关闭同步后自动重载';
    if (check.level === 'warn') return '未配置 Surge HTTP API，同步后需要手动重载配置';
  }
  if (['outputDir', 'backupDir'].includes(check.label) && check.level === 'warn') {
    return check.detail.replace(/ \(not created yet; run `sync`\)$/, '（尚未创建）');
  }
  return check.detail;
};

const setWorkflowState = (name, status, detail) => {
  const step = $(`[data-workflow="${name}"]`);
  step.classList.remove('done', 'current', 'blocked');
  step.classList.add(status);
  $(`#workflow-${name}`).textContent = detail;
};

const renderOverview = () => {
  const sourceReady = checkByLabel('nodeSources')?.level === 'ok';
  const environmentReady = ['surgeConfigPath', 'singBoxBinary', 'proxy-group-section', 'proxy-section'].every(
    (label) => checkByLabel(label)?.level === 'ok',
  );
  const latestPreview = state.history.find((entry) => entry.action === 'preview' && entry.success);
  const latestSync = state.history.find(
    (entry) => ['sync', 'scheduled-sync'].includes(entry.action) && entry.success,
  );
  const previewReady = Boolean(previewPlan || latestPreview);
  const syncReady = Boolean(latestSync);
  const scheduleReady = state.schedule.enabled;
  const coreCompleted = [sourceReady, environmentReady, previewReady, syncReady].filter(Boolean).length;

  $('#setup-banner').classList.toggle('hidden', state.configExists);
  $('#workflow-progress').textContent = `核心 ${coreCompleted} / 4`;
  $('#workflow-summary').textContent =
    coreCompleted === 4
      ? scheduleReady
        ? '核心同步与自动任务均已配置'
        : '核心同步已完成，自动同步可选'
      : `还有 ${4 - coreCompleted} 个核心步骤待完成`;

  setWorkflowState(
    'sources',
    sourceReady ? 'done' : 'current',
    sourceReady ? `${state.config.subscriptionUrls.length} 个订阅，${state.config.vlessNodes.length} 个直接节点` : '添加订阅或直接节点',
  );
  setWorkflowState(
    'environment',
    environmentReady ? 'done' : sourceReady ? 'current' : 'blocked',
    environmentReady ? 'Surge 与 sing-box 已就绪' : `${state.doctor.failures} 项需要处理`,
  );
  setWorkflowState(
    'preview',
    previewReady ? 'done' : environmentReady ? 'current' : 'blocked',
    previewPlan ? `${previewPlan.count} 个节点，等待确认` : latestPreview ? `上次 ${formatDate(latestPreview.createdAt)}` : '查看写入前的实际变化',
  );
  setWorkflowState(
    'sync',
    syncReady ? 'done' : previewPlan ? 'current' : 'blocked',
    latestSync ? `${formatDate(latestSync.createdAt)}，${latestSync.count ?? state.nodeCount} 个节点` : '预览后确认写入',
  );
  setWorkflowState(
    'schedule',
    scheduleReady ? 'done' : syncReady ? 'current' : 'blocked',
    scheduleReady ? scheduleText(state.schedule) : '按需要启用',
  );

  if (!sourceReady) {
    nextAction = 'sources';
    $('#next-action-title').textContent = '添加节点来源';
    $('#next-action-detail').textContent = '先添加订阅地址或单个 VLESS 节点。';
    $('#next-action-button span').textContent = '添加来源';
  } else if (!environmentReady) {
    nextAction = 'environment';
    $('#next-action-title').textContent = '处理运行环境';
    $('#next-action-detail').textContent = '按检查结果安装依赖或修复 Surge 配置。';
    $('#next-action-button span').textContent = '查看问题';
  } else if (previewPlan) {
    nextAction = 'sync';
    $('#next-action-title').textContent = `确认写入 ${previewPlan.count} 个节点`;
    $('#next-action-detail').textContent = `新增 ${previewPlan.added}，移除 ${previewPlan.removed}，写入前会自动备份。`;
    $('#next-action-button span').textContent = '查看预览';
  } else if (!syncReady) {
    nextAction = 'preview';
    $('#next-action-title').textContent = '预览本次变化';
    $('#next-action-detail').textContent = '验证全部节点并查看写入内容，当前不会修改 Surge。';
    $('#next-action-button span').textContent = '开始预览';
  } else if (!scheduleReady) {
    nextAction = 'schedule';
    $('#next-action-title').textContent = '设置自动同步';
    $('#next-action-detail').textContent = '手动同步已经可用，可以继续配置后台定时执行。';
    $('#next-action-button span').textContent = '配置定时';
  } else {
    nextAction = 'preview';
    $('#next-action-title').textContent = '检查订阅更新';
    $('#next-action-detail').textContent = '运行一次预览，确认订阅中是否有节点变化。';
    $('#next-action-button span').textContent = '预览更新';
  }

  const overall = state.doctor.failures > 0 ? 'fail' : state.doctor.warnings > 0 ? 'warn' : 'ok';
  $('#sidebar-dot').className = `state-dot ${overall}`;
  $('#sidebar-status').textContent = state.doctor.failures > 0 ? `${state.doctor.failures} 项需处理` : state.doctor.warnings > 0 ? `${state.doctor.warnings} 项提醒` : '运行正常';
  $('#doctor-summary').textContent = state.doctor.failures > 0 ? `${state.doctor.failures} 项问题` : state.doctor.warnings > 0 ? `${state.doctor.warnings} 项提醒` : '全部通过';

  $('#doctor-list').innerHTML = state.doctor.checks
    .map((check) => {
      const icon = check.level === 'ok' ? 'circle-check' : check.level === 'warn' ? 'triangle-alert' : 'circle-x';
      const detail = doctorDetail(check);
      return `<div class="check-row ${check.level}"><i data-lucide="${icon}"></i><span class="check-label">${escapeHtml(labelMap[check.label] || check.label)}</span><span class="check-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span><span class="check-action">${doctorAction(check)}</span></div>`;
    })
    .join('');

  renderActivityList($('#recent-activity'), state.history.slice(0, 5), true);
};

const sourceDescription = (value, kind) => {
  if (!value) return kind === 'subscription' ? '等待填写订阅地址' : '等待填写 VLESS 节点';
  try {
    const url = new URL(value);
    if (kind === 'subscription') return url.hostname || '本地数据订阅';
    return decodeURIComponent(url.hash.slice(1)) || url.hostname || 'VLESS 节点';
  } catch {
    return '地址格式待确认';
  }
};

const renderSourceList = (container, values, kind) => {
  if (values.length === 0) {
    container.innerHTML = `<button type="button" class="source-empty" data-source-add="${kind}"><i data-lucide="plus-circle"></i><strong>${kind === 'subscription' ? '添加第一个订阅' : '添加直接节点'}</strong><span>${kind === 'subscription' ? '支持 HTTP、HTTPS 和 data 地址' : '粘贴一个完整的 vless:// 地址'}</span></button>`;
    return;
  }

  container.innerHTML = values
    .map((value, index) => {
      const inputName = kind === 'subscription' ? 'subscription-url' : 'vless-node';
      const icon = kind === 'subscription' ? 'rss' : 'link-2';
      const placeholder = kind === 'subscription' ? 'https://example.com/subscription' : 'vless://uuid@example.com:443?...';
      return `<div class="source-row"><span class="source-row-icon"><i data-lucide="${icon}"></i></span><label><span>${escapeHtml(sourceDescription(value, kind))}</span><input class="source-row-input${secretsVisible ? '' : ' masked'}" data-source-input="${kind}" data-source-index="${index}" name="${inputName}" type="text" value="${escapeHtml(value)}" placeholder="${placeholder}" spellcheck="false" /></label><button type="button" class="icon-button source-remove" data-source-remove="${kind}" data-source-index="${index}" title="移除"><i data-lucide="x"></i></button></div>`;
    })
    .join('');
};

const renderSourceMeta = () => {
  const meta = $('#source-count');
  const count = `${sourceDraft.subscriptionUrls.filter(Boolean).length} 个订阅，${sourceDraft.vlessNodes.filter(Boolean).length} 个直接节点`;
  meta.textContent = sourcesDirty ? `${count} · 有未保存修改` : count;
  meta.classList.toggle('dirty', sourcesDirty);
};

const renderSources = () => {
  renderSourceList($('#subscription-list'), sourceDraft.subscriptionUrls, 'subscription');
  renderSourceList($('#vless-node-list'), sourceDraft.vlessNodes, 'vless');
  renderSourceMeta();
};

const scheduleText = (schedule) => {
  if (!schedule.enabled) return '当前未启用';
  if (schedule.kind === 'daily') return `每天 ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  return `每 ${schedule.intervalHours} 小时`;
};

const intervalPresets = new Set([1, 6, 12, 24]);

const selectedIntervalHours = () => {
  const preset = $('#schedule-interval-preset').value;
  return preset === 'custom' ? Number($('#schedule-interval-custom').value) : Number(preset);
};

const sameCalendarDay = (left, right) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const nextScheduleText = ({ enabled, kind, intervalHours, hour, minute }) => {
  if (!enabled) return '启用后计算';
  const now = new Date();
  const next = new Date(now);
  if (kind === 'interval') {
    const hours = Number(intervalHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return '请输入 1 至 168 小时';
    next.setHours(next.getHours() + hours);
  } else {
    const nextHour = Number(hour);
    const nextMinute = Number(minute);
    if (!Number.isInteger(nextHour) || nextHour < 0 || nextHour > 23 || !Number.isInteger(nextMinute) || nextMinute < 0 || nextMinute > 59) return '请输入有效时间';
    next.setHours(nextHour, nextMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = sameCalendarDay(next, now)
    ? '今天'
    : sameCalendarDay(next, tomorrow)
      ? '明天'
      : `${next.getMonth() + 1}月${next.getDate()}日 ${new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(next)}`;
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(next);
  return `${day} ${time}`;
};

const renderSchedule = () => {
  const schedule = state.schedule;
  $('#schedule-enabled').checked = schedule.enabled;
  $('#schedule-kind').value = schedule.kind;
  const preset = intervalPresets.has(schedule.intervalHours) ? String(schedule.intervalHours) : 'custom';
  $('#schedule-interval-preset').value = preset;
  $('#schedule-interval-custom').value = String(schedule.intervalHours);
  $('#schedule-hour').value = String(schedule.hour);
  $('#schedule-minute').value = String(schedule.minute);
  $('#schedule-run-at-load').checked = schedule.runAtLoad;
  $('#schedule-description').textContent = scheduleText(schedule);
  $('#schedule-next-run').textContent = nextScheduleText(schedule);
  $('#scheduler-log').textContent = state.schedulerLog.trim() || '暂无日志';
  updateScheduleFields();
};

const renderActivityList = (container, entries, compact = false) => {
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">暂无操作记录</div>';
    return;
  }
  container.innerHTML = entries
    .map((entry) => {
      const selected = !compact && selectedHistoryId === entry.id ? ' selected' : '';
      return `<button class="activity-item${selected}" data-history-id="${escapeHtml(entry.id)}"><span class="activity-state ${entry.success ? 'success' : 'failure'}"><i data-lucide="${entry.success ? 'circle-check' : 'circle-x'}"></i></span><span class="activity-copy"><strong>${escapeHtml(actionMap[entry.action] || entry.action)}</strong><span>${escapeHtml(entry.message)}</span></span><time>${escapeHtml(formatDate(entry.createdAt))}</time></button>`;
    })
    .join('');
};

const renderHistory = () => {
  renderActivityList($('#history-list'), state.history);
  $('#clear-history').disabled = state.history.length === 0;
  $('#clean-old-backups').disabled = state.backups.length <= 1;
  if (!state.backups.length) {
    $('#backup-list').innerHTML = '<div class="empty-state">暂无备份</div>';
  } else {
    $('#backup-list').innerHTML = state.backups
      .map(
        (backup) => `<div class="backup-item"><span class="backup-icon"><i data-lucide="file-archive"></i></span><span class="backup-copy"><strong title="${escapeHtml(backup.path)}">${escapeHtml(backup.name)}</strong><span>${escapeHtml(formatDate(backup.modifiedAt))} · ${Math.max(1, Math.round(backup.size / 1024))} KB</span></span><button class="icon-button reveal-backup" data-path="${escapeHtml(backup.path)}" title="在访达中显示"><i data-lucide="folder-open"></i></button></div>`,
      )
      .join('');
  }

  const selected = state.history.find((entry) => entry.id === selectedHistoryId);
  if (selected) {
    $('#output-title').textContent = `${actionMap[selected.action] || selected.action} · ${formatDate(selected.createdAt)}`;
    $('#action-output').textContent = selected.output || selected.message;
  } else {
    $('#output-title').textContent = '选择一条历史记录';
    $('#action-output').textContent = '暂无输出';
  }
};

const selectedPolicyGroupNames = () =>
  $$('#policy-group-options input[type="checkbox"]:checked').map((input) => input.value);

const policyGroupResolvedMode = (input) => {
  const select = input.closest('.policy-group-option')?.querySelector('.policy-group-mode');
  return select?.value === 'auto' ? input.dataset.recommendedMode : select?.value;
};

const updatePolicyGroupSummary = () => {
  const checkboxes = $$('#policy-group-options input[type="checkbox"]');
  const selectedCount = checkboxes.filter((input) => input.checked).length;
  const pendingAddCount = checkboxes.filter(
    (input) => input.checked && input.dataset.containsPolicyGroup !== 'true',
  ).length;
  const pendingRemoveCount = checkboxes.filter(
    (input) => !input.checked && input.dataset.containsPolicyGroup === 'true',
  ).length;
  checkboxes.forEach((input) => {
    const option = input.closest('.policy-group-option');
    const status = option?.querySelector('.policy-group-status');
    const modeSelect = option?.querySelector('.policy-group-mode');
    if (!status) return;

    const containsPolicyGroup = input.dataset.containsPolicyGroup === 'true';
    const membershipMode = input.dataset.membershipMode;
    const resolvedMode = policyGroupResolvedMode(input);
    const resolvedModeLabel = resolvedMode === 'merge' ? '合并节点' : '引用策略组';
    if (modeSelect) modeSelect.disabled = !input.checked;
    if (input.checked && containsPolicyGroup && membershipMode !== 'both' && membershipMode === resolvedMode) {
      status.className = 'policy-group-status included';
      status.innerHTML = `<i data-lucide="circle-check"></i>已通过${resolvedModeLabel}加入`;
    } else if (input.checked && containsPolicyGroup) {
      status.className = 'policy-group-status pending-change';
      status.innerHTML = `<i data-lucide="replace"></i>同步时改为${resolvedModeLabel}`;
    } else if (input.checked) {
      status.className = 'policy-group-status pending-add';
      status.innerHTML = `<i data-lucide="circle-plus"></i>同步时${resolvedModeLabel}`;
    } else if (containsPolicyGroup) {
      status.className = 'policy-group-status pending-remove';
      status.innerHTML = '<i data-lucide="circle-minus"></i>同步时移除 VLESS';
    } else {
      status.className = 'policy-group-status excluded';
      status.textContent = '保持不加入';
    }
  });
  $('#policy-group-summary').textContent = checkboxes.length
    ? `已选择 ${selectedCount} / ${checkboxes.length} 个策略组${pendingAddCount ? `，待加入 ${pendingAddCount}` : ''}${pendingRemoveCount ? `，待移除 ${pendingRemoveCount}` : ''}。`
    : '保存有效的 Surge 配置路径后可自动读取。';
  $('#select-all-policy-groups').disabled = checkboxes.length === 0 || selectedCount === checkboxes.length;
  $('#clear-policy-groups').disabled = selectedCount === 0;
  window.lucide?.createIcons();
};

const renderPolicyGroups = (config, selectedNames, selectedModes = config.policyGroupTargetModes) => {
  const availablePolicyGroups = state.policyGroups ?? [];
  const availablePolicyGroupNames = new Set(availablePolicyGroups.map((group) => group.name));
  const configuredExclusions = new Set(config.policyGroupExclusions ?? []);
  const effectiveSelectedNames = selectedNames ?? [
    ...config.policyGroupTargets,
    ...availablePolicyGroups
      .filter((group) => group.containsPolicyGroup && !configuredExclusions.has(group.name))
      .map((group) => group.name),
  ];
  const selectedPolicyGroups = new Set(effectiveSelectedNames);
  const manualPolicyGroups = effectiveSelectedNames.filter((name) => !availablePolicyGroupNames.has(name));
  $('#policy-group-options').innerHTML = availablePolicyGroups.length
    ? availablePolicyGroups
        .map(
          (group) => {
            const configuredMode = selectedModes?.[group.name] ?? 'auto';
            const mode = group.groupType === 'smart' && configuredMode === 'reference' ? 'auto' : configuredMode;
            return `
            <div class="policy-group-option">
              <label class="policy-group-toggle">
                <input type="checkbox" value="${escapeHtml(group.name)}" data-contains-policy-group="${group.containsPolicyGroup}" data-membership-mode="${group.membershipMode ?? ''}" data-recommended-mode="${group.recommendedMode}" ${selectedPolicyGroups.has(group.name) ? 'checked' : ''} />
                <span class="policy-group-option-copy">
                  <strong>${escapeHtml(group.name)}</strong>
                  <small class="policy-group-status"></small>
                </span>
              </label>
              <select class="policy-group-mode" data-policy-group-name="${escapeHtml(group.name)}" title="接入方式">
                <option value="auto" ${mode === 'auto' ? 'selected' : ''}>自动：${group.recommendedMode === 'merge' ? '合并节点' : '引用策略组'}</option>
                <option value="merge" ${mode === 'merge' ? 'selected' : ''}>合并节点</option>
                <option value="reference" ${mode === 'reference' ? 'selected' : ''} ${group.groupType === 'smart' ? 'disabled' : ''}>引用策略组</option>
              </select>
            </div>`;
          },
        )
        .join('')
    : '<div class="policy-group-empty"><i data-lucide="list-checks"></i><span>当前配置中没有可选策略组</span></div>';
  $('#policy-group-targets').value = manualPolicyGroups.join('\n');
  $('#manual-policy-groups').open = manualPolicyGroups.length > 0;
  updatePolicyGroupSummary();
};

const renderSettings = () => {
  const config = state.config;
  $('#config-path-label').textContent = state.configPath;
  $('#surge-config-path').value = config.surgeConfigPath;
  $('#sing-box-binary').value = config.singBoxBinary;
  $('#policy-group-name').value = config.policyGroupName;
  renderPolicyGroups(config);
  $('#port-start').value = String(config.portStart);
  $('#backup-keep').value = String(config.backupKeep);
  $('#resolver-strategy').value = config.addressResolverStrategy;
  $('#doh-endpoint').value = config.addressResolverDohEndpoint;
  $('#dns-servers').value = config.addressResolverDnsServers.join('\n');
  $('#filter-surge-fake-ip').checked = config.addressResolverFilterSurgeFakeIp;
  $('#auto-reload').checked = config.autoReload;
  $('#udp-relay').checked = config.udpRelay;
  $('#udp-test-enabled').checked = config.udpTestEnabled;
  $('#udp-test-target').value = config.udpTestTarget;
  $('#tcp-fast-open').checked = config.tcpFastOpen;
  $('#connect-timeout-enabled').checked = config.connectTimeoutEnabled;
  $('#connect-timeout-seconds').value = String(config.connectTimeoutSeconds);
  renderSingBoxDependency();
  updateResolverFields();
  updateConnectionOptionFields();
};

const updateConnectionOptionFields = () => {
  const udpRelayEnabled = $('#udp-relay').checked;
  const udpTestEnabled = $('#udp-test-enabled');
  if (!udpRelayEnabled) udpTestEnabled.checked = false;
  udpTestEnabled.disabled = !udpRelayEnabled;
  $('#udp-test-target').disabled = !udpRelayEnabled || !udpTestEnabled.checked;
  $('#connect-timeout-seconds').disabled = !$('#connect-timeout-enabled').checked;
};

const renderSingBoxDependency = () => {
  const dependency = state.environment.singBox;
  const sourceLabels = {
    managed: '官方托管版',
    homebrew: 'Homebrew',
    custom: '自定义路径',
    missing: '未安装',
  };
  const versionState = $('#sing-box-version-state');
  versionState.className = 'dependency-state';
  if (!dependency.installed) {
    versionState.textContent = '未安装';
    versionState.classList.add('error');
  } else if (!dependency.latestVersion) {
    versionState.textContent = '未检查';
  } else if (dependency.updateAvailable) {
    versionState.textContent = '可更新';
    versionState.classList.add('update');
  } else {
    versionState.textContent = '已是最新';
    versionState.classList.add('ok');
  }

  $('#sing-box-current-version').textContent = dependency.currentVersion ? `v${dependency.currentVersion}` : '未识别';
  $('#sing-box-latest-version').textContent = dependency.latestVersion ? `v${dependency.latestVersion}` : '未检查';
  $('#sing-box-source').textContent = sourceLabels[dependency.source] ?? '未知';
  $('#sing-box-install-detail').textContent = dependency.installed
    ? dependency.path
    : `官方版将安装到 ${state.environment.managedSingBoxPath}`;
  $('#rollback-sing-box').disabled = busy || !dependency.rollbackAvailable;
  $('#check-sing-box-update').disabled = busy;
  $('#install-sing-box-direct span').textContent =
    dependency.source === 'managed' ? (dependency.updateAvailable ? '更新官方版' : '重新安装') : '安装官方版';
  $('#install-sing-box-brew span').textContent = dependency.source === 'homebrew' ? 'Homebrew 更新' : 'Homebrew 安装';
  $('#install-sing-box-brew').disabled = busy || !state.environment.homebrewPath;
};

const renderPreview = (plan) => {
  $('#preview-count').textContent = String(plan.count);
  $('#preview-added').textContent = `+${plan.added}`;
  $('#preview-removed').textContent = `-${plan.removed}`;
  $('#preview-profile-change').textContent = plan.profileChanged ? '将更新' : '无变化';
  $('#preview-profile-change').classList.toggle('changed', plan.profileChanged);
  const connectionSummary = [
    `UDP 转发${plan.udpRelay ? '已开启' : '已关闭'}`,
    plan.udpRelay && plan.udpTestEnabled ? 'UDP 测试已开启' : '',
    plan.tcpFastOpen ? 'TCP Fast Open 已开启' : '',
    plan.connectTimeoutEnabled ? `连接超时 ${plan.connectTimeoutSeconds} 秒` : '',
  ].filter(Boolean);
  $('#preview-subtitle').textContent = `${plan.count} 个节点已通过 sing-box 配置校验，${connectionSummary.join('，')}`;
  const profilePath = $('#preview-profile-path');
  const policyGroup = $('#preview-policy-group');
  const policyGroupChanges = [
    plan.policyGroupTargets.length ? `加入 ${plan.policyGroupTargets.join('、')}` : '',
    plan.policyGroupExclusions.length ? `移除 ${plan.policyGroupExclusions.join('、')}` : '',
  ].filter(Boolean);
  const policyGroupDescription = `策略组 ${plan.policyGroupName}${policyGroupChanges.length ? `，${policyGroupChanges.join('；')}` : ''}`;
  profilePath.textContent = plan.surgeConfigPath;
  profilePath.title = plan.surgeConfigPath;
  policyGroup.textContent = policyGroupDescription;
  policyGroup.title = policyGroupDescription;
  const policyChanges = $('#preview-policy-changes');
  const changeRows = plan.policyGroupChanges ?? [];
  policyChanges.classList.toggle('hidden', changeRows.length === 0);
  policyChanges.innerHTML = changeRows
    .map((change) => {
      const actionLabel = change.action === 'remove' ? '移除 VLESS' : change.resolvedMode === 'merge' ? '合并节点' : '引用策略组';
      const modeLabel = change.mode === 'auto' ? '自动判断' : '手动指定';
      return `<div class="preview-policy-change"><div class="preview-policy-change-title"><strong title="${escapeHtml(change.name)}">${escapeHtml(change.name)}</strong><span>${modeLabel} · ${actionLabel}</span></div><div class="preview-policy-change-lines"><code title="${escapeHtml(change.before)}">${escapeHtml(change.before)}</code><code class="after" title="${escapeHtml(change.after)}">${escapeHtml(change.after)}</code></div></div>`;
    })
    .join('');
  $('#preview-node-list').innerHTML = plan.nodes
    .map(
      (node) => `<div class="preview-node-row"><strong>${escapeHtml(node.name)}</strong><span title="${escapeHtml(node.server)}">${escapeHtml(node.server)}</span><code>${node.port}</code></div>`,
    )
    .join('');
  window.lucide?.createIcons();
};

const showPreview = () => {
  if (!previewPlan) return;
  renderPreview(previewPlan);
  $('#preview-overlay').classList.remove('hidden');
  $('#preview-sync').focus();
};

const hidePreview = () => $('#preview-overlay').classList.add('hidden');

const renderAll = () => {
  renderOverview();
  renderSources();
  renderSchedule();
  renderHistory();
  renderSettings();
  window.lucide?.createIcons();
};

const loadState = async (showCover = true) => {
  if (showCover) setBusy(true, '正在读取配置');
  try {
    const [nextState, version] = await Promise.all([api.getState(), api.getVersion()]);
    state = nextState;
    $('#app-version').textContent = `v${version}`;
    sourceDraft = {
      subscriptionUrls: [...state.config.subscriptionUrls],
      vlessNodes: [...state.config.vlessNodes],
    };
    sourcesDirty = false;
    renderAll();
    if (!singBoxUpdateChecked) void refreshSingBoxStatus(false);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    if (showCover) setBusy(false);
  }
};

const refreshSingBoxStatus = async (notify = true) => {
  const button = $('#check-sing-box-update');
  button.disabled = true;
  button.querySelector('span').textContent = '正在检查';
  try {
    state.environment.singBox = await api.checkSingBoxUpdate();
    singBoxUpdateChecked = true;
    renderSingBoxDependency();
    if (notify) {
      const dependency = state.environment.singBox;
      showToast(
        dependency.updateAvailable
          ? `发现 sing-box ${dependency.latestVersion}。`
          : dependency.installed
            ? 'sing-box 已是最新稳定版。'
            : '当前没有可用的 sing-box。',
      );
    }
  } catch (error) {
    $('#sing-box-version-state').textContent = '检查失败';
    $('#sing-box-version-state').className = 'dependency-state error';
    if (notify) showToast(error.message || String(error), true);
  } finally {
    button.querySelector('span').textContent = '检查更新';
    button.disabled = busy;
  }
};

const runAction = async (action) => {
  if (busy) return;
  if (action === 'clean') {
    const confirmed = await api.confirm({ title: '清理托管配置', message: '将删除生成的节点配置和 Surge 托管区块。', detail: '执行前会自动备份 Surge 配置。' });
    if (!confirmed) return;
  }
  if (action === 'restore') {
    const confirmed = await api.confirm({ title: '恢复最新备份', message: '将用最新备份覆盖当前 Surge 配置。' });
    if (!confirmed) return;
  }

  setBusy(true, action === 'sync' ? '正在同步节点' : action === 'preview' ? '正在验证并生成预览' : '正在执行');
  try {
    const result = await api.runAction(action);
    if (action === 'preview' && result.success && result.preview) previewPlan = result.preview;
    if (action === 'sync' && result.success) previewPlan = undefined;
    if (action !== 'preview' || !result.success) showToast(result.message, !result.success);
    await loadState(false);
    if (action === 'preview' && result.success && result.preview) showPreview();
    if (action === 'sync' && result.success) hidePreview();
    if (result.output) {
      selectedHistoryId = state.history[0]?.id;
      renderHistory();
    }
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
};

const updateScheduleFields = () => {
  const enabled = $('#schedule-enabled').checked;
  const daily = $('#schedule-kind').value === 'daily';
  const customInterval = $('#schedule-interval-preset').value === 'custom';
  $('#schedule-options').style.opacity = enabled ? '1' : '.55';
  $('#schedule-options').style.pointerEvents = enabled ? 'auto' : 'none';
  $('#interval-field').classList.toggle('hidden', daily);
  $('#daily-fields').classList.toggle('hidden', !daily);
  $('#schedule-custom-interval').classList.toggle('hidden', !customInterval);
  $('#schedule-next-run').textContent = nextScheduleText({
    enabled,
    kind: $('#schedule-kind').value,
    intervalHours: selectedIntervalHours(),
    hour: Number($('#schedule-hour').value),
    minute: Number($('#schedule-minute').value),
  });
};

const updateResolverFields = () => {
  const strategy = $('#resolver-strategy').value;
  const descriptions = {
    doh: '同步时通过填写的 HTTPS 端点解析节点服务器域名。失败后继续尝试指定 DNS 和系统 DNS。',
    dns: '同步时向填写的 DNS 服务器解析节点服务器域名。失败后继续尝试 DoH 和系统 DNS。',
    system: '同步时使用 macOS 当前 DNS 解析节点服务器域名。',
    off: '同步时不解析节点服务器域名，Surge external 节点不写入 addresses 参数。',
  };
  $('#resolver-help').textContent = descriptions[strategy];
  $('#doh-endpoint-field').classList.toggle('hidden', strategy !== 'doh');
  $('#dns-servers-field').classList.toggle('hidden', strategy !== 'dns');
};

const dnsServersFromInput = () =>
  $('#dns-servers')
    .value.split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

const runRepair = async (check) => {
  if (check === 'proxy-group-section' || check === 'proxy-section') {
    const section = check === 'proxy-section' ? '[Proxy]' : '[Proxy Group]';
    const confirmed = await api.confirm({
      title: `补齐 ${section}`,
      message: `将在当前 Surge 配置末尾添加 ${section}。`,
      detail: '修改前会保存一份完整备份。',
    });
    if (!confirmed) return;
  }

  setBusy(true, '正在修复环境');
  try {
    const result = await api.repairCheck(check);
    showToast(result.message, !result.success);
    await loadState(false);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
};

const installSingBox = async (method) => {
  const direct = method === 'direct';
  const installed = state.environment.singBox.installed;
  const confirmed = await api.confirm({
    title: direct ? `${installed ? '更新' : '安装'}官方 sing-box` : `使用 Homebrew ${installed ? '更新' : '安装'} sing-box`,
    message: direct
      ? '将从 SagerNet 官方 GitHub 发布页下载适配当前 Mac 的可执行文件。'
      : '已安装时执行 brew upgrade sing-box，未安装时执行 brew install sing-box。',
    detail: direct
      ? `下载后会校验 SHA-256，检查全部节点配置，并保留上一版用于回退。`
      : state.environment.homebrewPath || '当前没有检测到 Homebrew。',
  });
  if (!confirmed) return;

  setBusy(true, direct ? '正在下载并校验 sing-box' : '正在通过 Homebrew 安装');
  try {
    const result = await api.installSingBox(method);
    showToast(result.message, !result.success);
    singBoxUpdateChecked = false;
    await loadState(false);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
};

const rollbackSingBox = async () => {
  const confirmed = await api.confirm({
    title: '回退 sing-box',
    message: '将恢复上一个官方托管版本。',
    detail: '回退前会先用旧版检查全部现有节点配置。',
  });
  if (!confirmed) return;

  setBusy(true, '正在回退 sing-box');
  try {
    const result = await api.rollbackSingBox();
    showToast(result.message, !result.success);
    singBoxUpdateChecked = false;
    await loadState(false);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
    renderSingBoxDependency();
  }
};

const runWorkflowAction = (action) => {
  if (sourcesDirty && ['preview', 'sync'].includes(action)) {
    switchView('sources');
    showToast('节点来源有未保存修改，请先保存来源。', true);
    return;
  }
  if (action === 'sources') {
    switchView('sources');
    return;
  }
  if (action === 'environment') {
    switchView('overview');
    $('#environment-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'schedule') {
    switchView('schedule');
    return;
  }
  if (action === 'sync' && previewPlan) {
    showPreview();
    return;
  }
  void runAction('preview');
};

const syncSourceDraftFromDom = () => {
  $$('[data-source-input="subscription"]').forEach((input) => {
    sourceDraft.subscriptionUrls[Number(input.dataset.sourceIndex)] = input.value;
  });
  $$('[data-source-input="vless"]').forEach((input) => {
    sourceDraft.vlessNodes[Number(input.dataset.sourceIndex)] = input.value;
  });
};

const addSourceRow = (kind) => {
  syncSourceDraftFromDom();
  const values = kind === 'subscription' ? sourceDraft.subscriptionUrls : sourceDraft.vlessNodes;
  values.push('');
  sourcesDirty = true;
  renderSources();
  window.lucide?.createIcons();
  $$(`[data-source-input="${kind}"]`).at(-1)?.focus();
};

const removeSourceRow = (kind, index) => {
  syncSourceDraftFromDom();
  const values = kind === 'subscription' ? sourceDraft.subscriptionUrls : sourceDraft.vlessNodes;
  values.splice(index, 1);
  sourcesDirty = true;
  renderSources();
  window.lucide?.createIcons();
};

$$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.go)));
$$('[data-action]').forEach((button) =>
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'preview' || action === 'sync') runWorkflowAction(action);
    else void runAction(action);
  }),
);
$$('[data-workflow]').forEach((button) => button.addEventListener('click', () => runWorkflowAction(button.dataset.workflow)));
$('#next-action-button').addEventListener('click', () => runWorkflowAction(nextAction));
$('#refresh-state').addEventListener('click', () => loadState());

$('#toggle-secrets').addEventListener('click', () => {
  syncSourceDraftFromDom();
  secretsVisible = !secretsVisible;
  renderSources();
  $('#toggle-secrets').innerHTML = `<i data-lucide="${secretsVisible ? 'eye-off' : 'eye'}"></i>`;
  window.lucide?.createIcons();
});

$('#add-subscription').addEventListener('click', () => addSourceRow('subscription'));
$('#add-vless-node').addEventListener('click', () => addSourceRow('vless'));

$('#sources-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  syncSourceDraftFromDom();
  setBusy(true, '正在保存订阅');
  try {
    state = await api.saveSources({
      subscriptionUrls: sourceDraft.subscriptionUrls.map((value) => value.trim()).filter(Boolean),
      vlessNodes: sourceDraft.vlessNodes.map((value) => value.trim()).filter(Boolean),
    });
    sourceDraft = {
      subscriptionUrls: [...state.config.subscriptionUrls],
      vlessNodes: [...state.config.vlessNodes],
    };
    sourcesDirty = false;
    previewPlan = undefined;
    renderAll();
    showToast('节点来源已保存，请运行预览。');
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#schedule-enabled').addEventListener('change', updateScheduleFields);
$('#schedule-kind').addEventListener('change', updateScheduleFields);
$('#schedule-interval-preset').addEventListener('change', updateScheduleFields);
$('#schedule-interval-custom').addEventListener('input', updateScheduleFields);
$('#schedule-hour').addEventListener('input', updateScheduleFields);
$('#schedule-minute').addEventListener('input', updateScheduleFields);
$('#resolver-strategy').addEventListener('change', updateResolverFields);
$('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true, '正在更新定时任务');
  try {
    const schedule = await api.saveSchedule({
      enabled: $('#schedule-enabled').checked,
      kind: $('#schedule-kind').value,
      intervalHours: selectedIntervalHours(),
      hour: Number($('#schedule-hour').value),
      minute: Number($('#schedule-minute').value),
      runAtLoad: $('#schedule-run-at-load').checked,
    });
    state.schedule = schedule;
    renderSchedule();
    renderOverview();
    showToast(schedule.enabled ? '定时任务已启用。' : '定时任务已停用。');
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#disable-schedule').addEventListener('click', async () => {
  setBusy(true, '正在停用定时任务');
  try {
    state.schedule = await api.disableSchedule();
    renderSchedule();
    renderOverview();
    showToast('定时任务已停用。');
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#clear-history').addEventListener('click', async () => {
  const confirmed = await api.confirm({
    title: '清空操作历史',
    message: `将删除全部 ${state.history.length} 条操作记录。`,
    detail: '此操作不会删除 Surge 配置或备份文件。',
  });
  if (!confirmed) return;

  setBusy(true, '正在清空历史');
  try {
    const deletedCount = await api.clearHistory();
    state.history = [];
    selectedHistoryId = undefined;
    renderHistory();
    window.lucide?.createIcons();
    showToast(`已清空 ${deletedCount} 条操作记录。`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#clean-old-backups').addEventListener('click', async () => {
  const confirmed = await api.confirm({
    title: '清理旧备份',
    message: '将删除旧备份，并保留最新一份。',
    detail: '删除的备份无法从应用内恢复。',
  });
  if (!confirmed) return;

  setBusy(true, '正在清理旧备份');
  try {
    const result = await api.cleanOldBackups();
    state.backups = result.backups;
    renderHistory();
    window.lucide?.createIcons();
    showToast(`已删除 ${result.deletedCount} 份旧备份。`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#choose-surge-profile').addEventListener('click', async () => {
  const path = await api.chooseFile('surge-profile');
  if (path) $('#surge-config-path').value = path;
});
$('#choose-sing-box').addEventListener('click', async () => {
  const path = await api.chooseFile('sing-box');
  if (path) $('#sing-box-binary').value = path;
});
$('#install-sing-box-direct').addEventListener('click', () => installSingBox('direct'));
$('#install-sing-box-brew').addEventListener('click', () => installSingBox('homebrew'));
$('#check-sing-box-update').addEventListener('click', () => refreshSingBoxStatus(true));
$('#rollback-sing-box').addEventListener('click', rollbackSingBox);
$('#select-all-policy-groups').addEventListener('click', () => {
  $$('#policy-group-options input[type="checkbox"]').forEach((input) => {
    input.checked = true;
  });
  updatePolicyGroupSummary();
});
$('#clear-policy-groups').addEventListener('click', () => {
  $$('#policy-group-options input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
  updatePolicyGroupSummary();
});
$('#policy-group-options').addEventListener('change', updatePolicyGroupSummary);
$('#refresh-policy-groups').addEventListener('click', async () => {
  const selectedNames = [
    ...selectedPolicyGroupNames(),
    ...$('#policy-group-targets').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
  ];
  const selectedModes = Object.fromEntries(
    $$('.policy-group-mode').map((select) => [select.dataset.policyGroupName, select.value]),
  );
  setBusy(true, '正在读取策略组');
  try {
    state.policyGroups = await api.inspectPolicyGroups({
      surgeConfigPath: $('#surge-config-path').value,
      policyGroupName: $('#policy-group-name').value,
    });
    renderPolicyGroups(state.config, selectedNames, selectedModes);
    window.lucide?.createIcons();
    showToast(`已读取 ${state.policyGroups.length} 个策略组。`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true, '正在保存设置');
  try {
    const checkboxes = $$('#policy-group-options input[type="checkbox"]');
    const visiblePolicyGroupNames = new Set(checkboxes.map((input) => input.value));
    const policyGroupTargets = [
      ...new Set([
        ...checkboxes.filter((input) => input.checked).map((input) => input.value),
        ...$('#policy-group-targets').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      ]),
    ];
    const selectedPolicyGroups = new Set(policyGroupTargets);
    const visiblePolicyGroupModes = new Map(
      $$('.policy-group-mode').map((select) => [select.dataset.policyGroupName, select.value]),
    );
    const policyGroupTargetModes = Object.fromEntries(
      policyGroupTargets.map((name) => [name, visiblePolicyGroupModes.get(name) ?? state.config.policyGroupTargetModes?.[name] ?? 'auto']),
    );
    const policyGroupExclusions = [
      ...new Set([
        ...(state.config.policyGroupExclusions ?? []).filter(
          (name) => !visiblePolicyGroupNames.has(name) && !selectedPolicyGroups.has(name),
        ),
        ...checkboxes
          .filter(
            (input) =>
              !input.checked &&
              input.dataset.containsPolicyGroup === 'true' &&
              !selectedPolicyGroups.has(input.value),
          )
          .map((input) => input.value),
      ]),
    ];
    state = await api.saveSettings({
      ...state.config,
      surgeConfigPath: $('#surge-config-path').value,
      singBoxBinary: $('#sing-box-binary').value,
      policyGroupName: $('#policy-group-name').value,
      policyGroupTargets,
      policyGroupExclusions,
      policyGroupTargetModes,
      portStart: Number($('#port-start').value),
      backupKeep: Number($('#backup-keep').value),
      autoReload: $('#auto-reload').checked,
      udpRelay: $('#udp-relay').checked,
      udpTestEnabled: $('#udp-test-enabled').checked,
      udpTestTarget: $('#udp-test-target').value,
      tcpFastOpen: $('#tcp-fast-open').checked,
      connectTimeoutEnabled: $('#connect-timeout-enabled').checked,
      connectTimeoutSeconds: Number($('#connect-timeout-seconds').value),
      addressResolverStrategy: $('#resolver-strategy').value,
      addressResolverDohEndpoint: $('#doh-endpoint').value,
      addressResolverDnsServers: dnsServersFromInput(),
      addressResolverFilterSurgeFakeIp: $('#filter-surge-fake-ip').checked,
    });
    renderAll();
    showToast('设置已保存。');
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
});

$('#udp-relay').addEventListener('change', updateConnectionOptionFields);
$('#udp-test-enabled').addEventListener('change', updateConnectionOptionFields);
$('#connect-timeout-enabled').addEventListener('change', updateConnectionOptionFields);

document.addEventListener('click', async (event) => {
  const sourceAdd = event.target.closest('[data-source-add]');
  if (sourceAdd) addSourceRow(sourceAdd.dataset.sourceAdd);
  const sourceRemove = event.target.closest('[data-source-remove]');
  if (sourceRemove) removeSourceRow(sourceRemove.dataset.sourceRemove, Number(sourceRemove.dataset.sourceIndex));
  const repair = event.target.closest('[data-repair-check]');
  if (repair) await runRepair(repair.dataset.repairCheck);
  const checkNav = event.target.closest('[data-check-nav]');
  if (checkNav) {
    const target = checkNav.dataset.checkNav;
    if (target === 'sources') switchView('sources');
    if (target === 'sing-box') {
      switchView('settings');
      $('#install-sing-box-direct').focus();
    }
    if (target === 'surge-profile') {
      switchView('settings');
      $('#choose-surge-profile').focus();
    }
  }
  const historyButton = event.target.closest('[data-history-id]');
  if (historyButton) {
    selectedHistoryId = historyButton.dataset.historyId;
    renderHistory();
    window.lucide?.createIcons();
  }
  const reveal = event.target.closest('.reveal-backup');
  if (reveal) await api.revealPath(reveal.dataset.path);
});

document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-source-input]');
  if (!input) return;
  const values = input.dataset.sourceInput === 'subscription' ? sourceDraft.subscriptionUrls : sourceDraft.vlessNodes;
  values[Number(input.dataset.sourceIndex)] = input.value;
  sourcesDirty = true;
  input.closest('.source-row').querySelector('label > span').textContent = sourceDescription(
    input.value,
    input.dataset.sourceInput,
  );
  renderSourceMeta();
});

document.addEventListener('paste', (event) => {
  const input = event.target.closest('[data-source-input]');
  if (!input) return;
  const pasted = event.clipboardData?.getData('text') || '';
  const lines = pasted.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (lines.length < 2) return;
  event.preventDefault();
  syncSourceDraftFromDom();
  const values = input.dataset.sourceInput === 'subscription' ? sourceDraft.subscriptionUrls : sourceDraft.vlessNodes;
  values.splice(Number(input.dataset.sourceIndex), 1, ...lines);
  sourcesDirty = true;
  renderSources();
  window.lucide?.createIcons();
});

$('#close-preview').addEventListener('click', hidePreview);
$('#preview-back').addEventListener('click', () => {
  hidePreview();
  switchView('sources');
});
$('#preview-sync').addEventListener('click', () => runAction('sync'));
$('#preview-overlay').addEventListener('click', (event) => {
  if (event.target === $('#preview-overlay')) hidePreview();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#preview-overlay').classList.contains('hidden')) hidePreview();
});

$('#copy-output').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#action-output').textContent || '');
  showToast('执行输出已复制。');
});

window.lucide?.createIcons();
void loadState();
