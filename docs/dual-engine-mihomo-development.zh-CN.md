# Surge VLESS Bridge 双引擎开发文档

更新时间：2026-10-31

适用版本：`1.6.3`

本文是当前双引擎实现的主开发文档。所有结论以当前工作区源码、测试和构建配置为准。接手开发前先阅读根目录 `AGENTS.md`，再检查 `git status --short` 和实际差异。

新的开发 Agent 应先阅读 `docs/next-agent-development-brief.zh-CN.md`，按其中的阶段、边界和完成判定继续实现。

## 1. 项目目标

项目为 Surge Mac 提供 VLESS 节点接入，包含 Node.js CLI 和 Electron 桌面应用。

当前目标：

1. 保留每节点独立进程的 sing-box External 运行方式。
2. 提供单个后台进程承载全部节点的 Mihomo 网关方式。
3. 复用同一套订阅解析、节点命名、策略组写入、备份和定时同步逻辑。
4. 用户可预览 Surge 配置变化，再执行同步、重建、清理或恢复。
5. 桌面应用关闭后，LaunchAgent 可继续运行 Mihomo 服务和定时同步任务。
6. 构建目标覆盖 Intel `x64` 和 Apple Silicon `arm64`，应用声明最低 macOS 12.0。
7. 日志、历史、测试夹具、截图和文档不得包含真实凭据或个人路径。

## 2. 当前功能范围

### 2.1 已实现

1. `runtimeMode` 在 `external` 和 `mihomo` 间选择运行引擎。
2. 旧配置缺少 `runtimeMode` 时继续使用 External。
3. 支持多个订阅和直接 `vless://` 节点，合并后去重。
4. 支持 TLS、REALITY、WebSocket、gRPC 和 HTTP Upgrade 节点映射。
5. 支持节点重名自动编号、策略组批量接入、排除和预览。
6. 支持 Surge 配置备份、最新备份恢复和旧备份清理。
7. 支持 sing-box 与 Mihomo 的安装、版本检查和托管版回退。
8. 支持 Mihomo LaunchAgent 和定时同步 LaunchAgent。
9. 桌面界面提供订阅、概览、设置、定时任务、历史和备份视图。

### 2.2 范围边界

1. 项目不启用 Mihomo TUN、系统代理、redir、tproxy、DNS listener 或局域网监听。
2. Surge 仍负责规则、策略组、流量入口和用户界面。
3. External 使用 Surge `external` 节点调用 sing-box。
4. Mihomo 使用 Surge `socks5` 节点连接本机回环 listener。
5. 项目只维护带有自身标记的 Surge 区块、策略组引用和 Mihomo 进程直连规则。
6. `restore` 只恢复 Surge 配置文件，不恢复运行引擎、Mihomo 配置或二进制版本。

## 3. 总体架构与数据流

### 3.1 公共输入链路

```text
subscriptionUrl / subscriptionUrls / vlessNodes
  ↓
下载并解码订阅
  ↓
筛选 VLESS 链接并去重
  ↓
解析为统一的 VLESS outbound
  ↓
按 runtimeMode 进入 External 或 Mihomo
```

订阅下载失败时，日志只记录订阅序号和来源站点，不输出完整 URL。某个来源为空或失败时继续处理其他来源。全部来源都没有可用 VLESS 节点时终止同步。

`1.6.3` 输入支持原始链接列表、Base64（含 URL-safe）链接列表、Clash YAML/JSON 的 `proxies` 及 Base64 编码的 Clash 文档。仅导入 VLESS 节点，不导入订阅中的规则、DNS 或监听设置。只有 `proxy-providers` 的配置需要用户提供 provider 地址，不自动递归下载。Base64 属于编码，不能据此声称支持任意加密订阅。

Clash 节点转成内部链接后走原有公共链路。TCP、WS、gRPC、HTTP Upgrade、TLS、Reality、ALPN 和 WS early data 已覆盖；普通 HTTP/H2/XHTTP 等未映射参数明确拒绝，不能将它们静默当作 TCP 或 HTTP Upgrade。Mihomo HTTP Upgrade 使用 `network: ws` 和 `ws-opts.v2ray-http-upgrade: true`，已核对官方 `adapter/outbound/vless.go`。

HTTP、网络、解码和格式错误使用 `SubscriptionError` 的安全消息。YAML 解析器的原始异常可能包含凭据，禁止直接打印。全部来源失败时，将订阅序号和安全原因汇总到最终异常，使桌面向导和历史都能显示，避免控制台捕获丢失原因。

### 3.2 External 数据流

```text
统一 VLESS outbound
  ↓
在临时 staging 目录生成每节点 sing-box JSON
  ↓
并发执行 sing-box check
  ↓
生成 Surge external 节点和策略组变化
  ↓
备份 Surge 配置
  ↓
提升节点配置并写入 manifest.json
  ↓
写入 Surge 配置并清理过期节点配置
  ↓
按配置重载 Surge
```

External 特性：

1. 每个节点占用 `portStart + 节点序号` 的本地端口。
2. `udpRelay`、`udpTestEnabled`、`tcpFastOpen` 和连接超时均可生效。
3. 节点服务器域名可使用 DoH、指定 DNS、系统 DNS 或关闭预解析。
4. `manifest.json` 记录当前托管的节点配置，`rebuild` 优先按清单读取。
5. 正式同步会在后续配置校验前更新 `subscriptionOutputPath`。若校验随后失败，该缓存文件可能已经变化，Surge 配置和已提升节点配置仍保持原状态。

### 3.3 Mihomo 数据流

```text
统一 VLESS outbound
  ↓
映射为 Mihomo proxies
  ↓
为每个节点生成本机回环 SOCKS listener
  ↓
写入临时候选 YAML 并执行 mihomo -t
  ↓
生成 Surge socks5 节点和策略组变化
  ↓
备份 Surge 配置和上一份 Mihomo 配置
  ↓
替换 config.yaml 并安装或重启 Mihomo LaunchAgent
  ↓
等待本机 Controller 可用
  ↓
写入 Surge 配置并按配置重载 Surge
```

Mihomo 安全设置：

1. Controller host 在配置加载时强制为本机回环地址。
2. 所有 SOCKS listener 只监听本机回环地址。
3. `allow-lan` 关闭。
4. 新生成的 `config.yaml` 权限设为 `0600`，首次原子写入 Controller secret 时也会把应用配置权限设为 `0600`。
5. Controller secret 不进入渲染进程类型、桌面状态或活动日志。
6. Surge `[Rule]` 中加入项目托管的 Mihomo 进程直连规则，切回 External 或清理时移除。
7. Mihomo VLESS schema 没有每节点 `connect-timeout` 字段，当前输出不生成该键。

## 4. 主要目录与文件

| 位置 | 职责 |
| --- | --- |
| `src/cli.ts` | CLI 参数、命令分发和交互式初始化 |
| `src/configuration.ts` | 默认值、兼容加载、路径解析和 Controller secret 持久化 |
| `src/types/cli-config.ts` | 配置模型 |
| `src/parse.ts` | 订阅下载和 VLESS 节点筛选 |
| `src/utils/parse-vless-node.ts` | VLESS 链接解析和统一 outbound 生成 |
| `src/surge.ts` | Surge 写入、External 同步、备份、清理、恢复和公共诊断 |
| `src/engines/index.ts` | `sync`、`rebuild`、`clean`、`doctor` 的双引擎分发 |
| `src/mihomo/config.ts` | Mihomo YAML 和 Surge SOCKS5 节点生成 |
| `src/mihomo/sync.ts` | Mihomo 同步、校验、回退、重建和清理 |
| `src/mihomo/dependencies.ts` | Mihomo 安装、版本检查和二进制回退 |
| `src/mihomo/launch-agent.ts` | Mihomo LaunchAgent 生命周期和 Controller 状态 |
| `src/mihomo/doctor.ts` | Mihomo 配置、服务、Controller 和 TCP listener 诊断 |
| `src/desktop/service.ts` | 桌面业务服务、模式切换和活动记录 |
| `src/desktop/main.ts` | Electron 窗口、文件选择和 IPC 注册 |
| `src/desktop/preload.ts` | 受控 `window.surgeBridge` API |
| `src/desktop/scheduler.ts` | 定时同步 LaunchAgent |
| `src/desktop/scheduled-run.ts` | 应用退出后的定时同步入口 |
| `src/desktop/storage.ts` | 历史记录和日志尾部读取 |
| `desktop/` | HTML、CSS、渲染层交互和图标资源 |
| `scripts/` | 桌面资源复制、打包资源校验和定时任务冒烟 |
| `test/` | Node 测试套件 |

默认状态目录位于用户配置目录。主要运行文件：

```text
<state-dir>/config.json
<state-dir>/nodes/
<state-dir>/backups/
<state-dir>/vless_nodes.txt
<state-dir>/bin/sing-box
<state-dir>/bin/sing-box.previous
<state-dir>/bin/mihomo
<state-dir>/bin/mihomo.previous
<state-dir>/mihomo/config.yaml
<state-dir>/mihomo/config.previous.yaml
<state-dir>/mihomo/logs/
<state-dir>/desktop/history.json
<state-dir>/desktop/schedule.json
<state-dir>/desktop/scheduler.log
```

## 5. 配置模型

### 5.1 节点来源和运行模式

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `runtimeMode` | `external` | 可选 `external` 或 `mihomo` |
| `runtimeModeConfirmed` | `false` | 首次使用和旧配置升级都需要用户确认运行引擎 |
| `subscriptionUrl` | 空 | 兼容旧版的单订阅字段 |
| `subscriptionUrls` | 空数组 | 多订阅列表，与旧字段合并去重 |
| `vlessNodes` | 空数组 | 直接 VLESS 节点列表 |
| `requestHeaders` | 内置浏览器请求头 | 订阅请求头，可按需覆盖 |
| `subscriptionOutputPath` | 状态目录内文本文件 | 保存合并后的原始 VLESS 链接，属于敏感文件 |

节点来源三项至少配置一项。配置文件包含订阅、节点和 Controller secret，应按凭据文件管理。

### 5.2 Surge 和策略组

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `surgeConfigPath` | 自动探测最近修改的配置 | 将被备份和写入的 Surge 配置 |
| `policyGroupName` | `VLESS` | 项目生成的 `url-test` 策略组 |
| `policyGroupTargets` | 空数组 | 需要接入 VLESS 的现有策略组 |
| `policyGroupExclusions` | 空数组 | 需要移除 VLESS 引用的策略组 |
| `policyGroupTargetModes` | 空对象 | 每组可选 `auto`、`merge`、`reference` |
| `portStart` | `2081` | 第一条本地 listener 端口 |
| `backupDir` | 状态目录内备份目录 | Surge 配置备份位置 |
| `backupKeep` | `20` | 自动保留的 Surge 备份数量 |
| `autoReload` | `true` | 写入后尝试重载 Surge |
| `proxyStartMarker` | `# vless start` | 托管节点区块起始标记 |
| `proxyEndMarker` | `# vless end` | 托管节点区块结束标记 |

当前写入逻辑使用固定默认标记。自定义 marker 没有完整测试覆盖，应视为兼容字段。

策略组模式：

1. `reference` 将 VLESS 策略组作为直接成员加入目标组。
2. `merge` 将 VLESS 写入 `include-other-group`。
3. `auto` 遇到 `smart`、`include-other-group` 或 `policy-regex-filter` 时选择 `merge`，其他组选择 `reference`。
4. `smart` 组不允许直接引用其他策略组，手动选择冲突模式时同步会终止。

### 5.3 External 字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `singBoxBinary` | 自动探测或托管路径 | sing-box 可执行文件 |
| `outputDir` | 状态目录内节点目录 | 每节点 JSON 和 `manifest.json` |
| `udpRelay` | `false` | Surge 节点和本地 SOCKS 入站启用 UDP |
| `udpTestEnabled` | `false` | Surge 节点写入 UDP 测试参数 |
| `udpTestTarget` | 内置通用目标 | 格式为 `<hostname>@<IPv4>` |
| `tcpFastOpen` | `false` | sing-box outbound 开启 TCP Fast Open |
| `connectTimeoutEnabled` | `false` | sing-box outbound 使用自定义连接超时 |
| `connectTimeoutSeconds` | `10` | 超时秒数，桌面允许范围为 1 到 300 |
| `addressResolver.strategy` | `doh` | 可选 `doh`、`dns`、`system`、`off` |
| `addressResolver.dohEndpoint` | 内置 HTTPS 端点 | DoH 查询地址 |
| `addressResolver.dnsServers` | 内置公共 DNS 列表 | 指定 DNS 服务器 |
| `addressResolver.filterSurgeFakeIp` | `true` | 过滤 Surge Fake IP 地址段 |

Mihomo 复用 `udpRelay`、`udpTestEnabled`、`udpTestTarget` 和 `tcpFastOpen`。连接超时与节点服务器域名预解析只用于 External。

### 5.4 Mihomo 字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mihomo.binary` | 托管二进制路径 | Mihomo 可执行文件 |
| `mihomo.dataDir` | 状态目录内 Mihomo 目录 | YAML、上一版 YAML 和日志 |
| `mihomo.controllerHost` | 本机回环地址 | 加载时强制覆盖外部输入 |
| `mihomo.controllerPort` | `19090` | Controller 端口，范围 1024 到 65535 |
| `mihomo.controllerSecret` | 首次使用时生成 | 仅主进程和 Mihomo 配置使用 |
| `mihomo.autoStart` | `true` | 控制 Mihomo LaunchAgent 的 `RunAtLoad` 和 `KeepAlive` |
| `mihomo.logLevel` | `info` | `silent`、`error`、`warning`、`info` 或 `debug` |

首次加载 Mihomo 配置或切换到 Mihomo 时，如果 secret 为空，会生成随机值并通过临时文件原子写回，随后将配置权限设为 `0600`。

### 5.5 配置路径规则

1. CLI 显式传入 `--config` 时使用该路径。
2. CLI 在 Git 工作区内且未传路径时，使用仓库根目录的 `.surge-vless-bridge.json`。
3. CLI 在普通安装目录运行时，使用用户配置目录中的 `config.json`。
4. Electron 桌面应用始终使用用户配置目录中的 `config.json`。

## 6. Surge 配置写入边界

写入前要求目标文件存在。公共诊断要求 `[Proxy]`、`[Proxy Group]` 和 `[Rule]`。

项目维护以下内容：

1. `[Proxy]` 中 `# vless start` 与 `# vless end` 之间的节点。
2. 名称为 `policyGroupName` 的 `url-test` 策略组。
3. `policyGroupTargets` 和 `policyGroupExclusions` 指定组中的 VLESS 引用。
4. Mihomo 模式的托管进程直连规则。

项目会保留目标策略组的其他成员和参数。目标策略组缺失时，正式写入前终止。每次 `sync`、`rebuild`、`clean` 前都会备份 Surge 配置。

`repairCheck` 可在用户触发后补齐缺失的 Surge section。该操作先备份配置，再追加空 section。项目不会自动选择托管配置 URL，也不会判断某个候选文件是否是用户当前生效配置。

## 7. 同步、重建、清理与恢复

### 7.1 `sync`

External：

1. 校验 Surge 路径和 sing-box 路径。
2. 创建节点和备份目录。
3. 拉取并解析全部节点。
4. 在 staging 目录生成和校验 JSON。
5. 生成 Surge 预览。
6. 正式执行时备份 Surge、提升节点配置、写入 Surge、删除过期配置并重载。

Mihomo：

1. 校验 Surge 路径和节点来源。
2. 创建 Mihomo 数据目录和备份目录。
3. 生成候选 YAML 并执行 `mihomo -t`。
4. 正式执行时备份 Surge 和上一份 Mihomo YAML。
5. Controller 尚未可用时检查 listener 端口冲突。
6. 安装或重启 Mihomo LaunchAgent，等待 Controller。
7. 写入 Surge 并重载。
8. 失败时恢复 Surge。存在上一份 YAML 时恢复并重新安装服务，没有上一份时删除新 YAML 并卸载服务。

`sync --dry-run` 不改写 Surge、不生成备份、不保留节点配置。它可能创建状态目录，并会短暂创建随后删除的 staging 或候选文件。

### 7.2 `rebuild`

1. External 从 `manifest.json` 或兼容扫描结果读取本地 JSON，重新生成 Surge 节点和策略组。
2. External 会再次执行节点服务器域名解析。
3. Mihomo 从现有 `config.yaml` 的 proxies 和 listeners 重建 Surge。
4. Mihomo `rebuild` 不启动服务，也不重新执行 `mihomo -t`。
5. 两种模式都会先备份 Surge，再写入和按配置重载。

### 7.3 `clean`

公共清理内容：

1. Surge 托管节点区块。
2. 生成的 VLESS 策略组。
3. 目标策略组中的 VLESS 引用。
4. Mihomo 进程直连规则。
5. External 托管 JSON 和 `manifest.json`。

Mihomo 清理还会卸载 Mihomo LaunchAgent，并删除 `config.yaml`、`config.previous.yaml` 和遗留候选文件。日志目录、托管二进制、订阅缓存和备份目录会保留。

### 7.4 `restore`

`restore` 将指定备份或最新备份覆盖到 `surgeConfigPath`，随后按配置重载 Surge。恢复后需要检查当前引擎、服务和本地节点配置是否与该 Surge 备份匹配。

### 7.5 模式切换

桌面模式切换流程：

1. 保存普通设置，但保留当前 `runtimeMode`。
2. 用户确认切换。
3. 对目标引擎执行 dry run。
4. 切到 External 前先停止 Mihomo 服务。
5. 执行目标引擎正式同步。
6. 成功后写入新的 `runtimeMode`。
7. 切到 External 后卸载 Mihomo LaunchAgent。

失败时会尝试恢复原 Surge 配置、应用配置和 Mihomo 服务状态。当前没有跨进程事务文件，应用在切换中途被强制结束时无法自动判断恢复阶段。

## 8. 桌面应用

### 8.1 分层

1. `desktop/index.html` 和 `desktop/app.js` 负责视图、表单、预览和交互。
2. `src/desktop/preload.ts` 通过 `contextBridge` 暴露白名单 API。
3. `src/desktop/main.ts` 注册 IPC、文件选择、确认框和路径显示。
4. `src/desktop/service.ts` 执行文件、网络、进程、LaunchAgent 和历史操作。
5. BrowserWindow 开启 `contextIsolation`，关闭渲染层 Node 集成，并拒绝新窗口。
6. 默认窗口为 `1180x780`，最小宽度为 `720`，可在窄窗中继续操作导航、路径和表单。

### 8.2 主要 IPC

`DesktopApi` 覆盖：

1. 状态读取、版本读取和策略组检查。
2. 节点来源与设置保存。
3. `doctor`、`preview`、`sync`、`rebuild`、`restore`、`clean`。
4. 环境修复。
5. sing-box 与 Mihomo 安装、更新检查和回退。
6. Mihomo 启动、停止和重启。
7. 运行引擎切换。
8. 定时任务、历史和旧备份管理。
9. 文件选择、确认框和 Finder 定位。

渲染层收到的 `DesktopConfigView` 不包含 Controller secret。桌面状态只返回 `controllerSecretConfigured` 布尔值。

### 8.3 UI 条件逻辑

1. 策略组、端口、备份、自动重载、UDP 和 TCP Fast Open 属于共享设置。
2. sing-box 路径、版本管理、连接超时和域名解析只在 External 草稿模式显示。
3. Mihomo 路径、数据目录、Controller 端口、日志级别和服务控制只在 Mihomo 草稿模式显示。
4. 切换引擎前先显示影响说明并要求确认。
5. 预览显示节点增减、Surge 是否变化、策略组前后行和节点端口。
6. 订阅和 VLESS 节点默认遮蔽，可由用户主动显示。
7. 初始状态读取限制为 12 秒。读取失败或超时后停止转圈，显示具体错误和“重新读取”入口。
8. 独立的 `boot.js` 提供 15 秒渲染兜底，避免主交互脚本加载或执行异常时永久显示加载状态。

### 8.4 配置向导

1. 首次运行强制进入四步向导：运行方式、订阅节点、Surge 设置、汇总确认。
2. External 和 Mihomo 均提供官方版安装、Homebrew 安装和选择已有文件，并复用全局安装进度。
3. 向导支持多订阅、自定义订阅名称、直接 VLESS 节点、Surge 路径、策略组、端口、备份和常用连接选项。
4. 首次确认引擎只检查可执行文件并写入选择，不在来源和 Surge 路径尚未保存时提前同步。
5. 最终提交依次保存来源、保存设置、确认或切换引擎，并且每次只执行一次正式同步。
6. 已配置用户可从设置页重新打开向导，已保存值会回填，取消不会修改现有配置。
7. 面板使用固定标题、步骤导航和底部操作栏，仅中间表单滚动，避免最小窗口裁切下一步或保存按钮。

`operationRunning` 只限制当前桌面主进程内的并发操作。定时同步和另一个进程仍可能同时写入。

## 9. LaunchAgent

### 9.1 Mihomo 服务

LaunchAgent label：`com.chen86860.surge-vless-bridge.mihomo`

主要行为：

1. 参数包含 Mihomo 二进制、数据目录和 `config.yaml`。
2. stdout 和 stderr 写入 Mihomo 日志目录。
3. `mihomo.autoStart` 同时控制 `RunAtLoad` 和 `KeepAlive`。
4. plist 权限设为 `0600`。
5. 安装时执行 `bootout`、`bootstrap`、`enable` 和 `kickstart`。

### 9.2 定时同步

LaunchAgent label：`com.chen86860.surge-vless-bridge.sync`

支持固定小时间隔或每日时间，间隔范围为 1 到 168 小时。打包应用通过 `ELECTRON_RUN_AS_NODE=1` 运行 `scheduled-run.js`。任务读取当前 `runtimeMode` 并调用 `syncBridge`，结果写入桌面历史。失败时在 macOS 发送本地通知。

应用位于挂载卷时会拒绝启用定时任务，用户需要先把应用放到稳定位置。

## 10. 依赖安装与回退

### 10.1 sing-box

桌面支持官方托管版和 Homebrew。托管更新保留上一版二进制，并在回退时校验本地节点配置。

### 10.2 Mihomo

桌面支持 MetaCubeX 官方 Release 和 Homebrew。

官方托管安装流程：

1. 调用官方 GitHub Release API 读取最新稳定版。
2. `x64` 选择 `darwin-amd64-compatible`。
3. `arm64` 选择 `darwin-arm64`。
4. 校验响应大小和官方 SHA-256 digest。
5. 解压后执行版本读取。
6. 更新前保存 `mihomo.previous`。

托管版回退会交换当前和上一版二进制。当前运行模式为 Mihomo 时，桌面随后重启 LaunchAgent。自定义路径和 Homebrew 版本没有项目托管的上一版文件。

## 11. 构建与打包

项目使用 Node.js 和 npm。TypeScript 编译产物位于 `dist/`。

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖并更新锁文件 |
| `npm ci` | 按锁文件安装，适用于 CI |
| `npm run build` | 清理 `dist/` 并执行 `tsc` |
| `npm run build:desktop` | 编译并复制 renderer 和 Lucide |
| `npm run desktop` | 构建并启动开发版 Electron |
| `npm run desktop:package` | 生成当前主机架构的未压缩 `.app` |
| `npm run desktop:dmg` | 生成当前主机架构的 DMG |
| `npm run desktop:verify -- <app-path>` | 检查打包后的 renderer 资源 |
| `npm run desktop:smoke` | 使用临时 Surge 配置验证打包版定时同步入口 |
| `npm test` | 编译后运行全部 Node 测试 |

Electron Builder 配置：

1. `appId` 为 `com.chen86860.surgevlessbridge`。
2. `minimumSystemVersion` 为 `12.0`。
3. Hardened Runtime 开启。
4. 当前本地签名身份为临时签名。
5. `yaml` 运行库和编译后的 JS 从 asar 解包，renderer 作为额外资源复制。
6. `release/` 是构建输出目录，开发和审计期间不得手工覆盖现有成品。

GitHub Actions 使用原生 Intel 和 Apple Silicon runner，分别执行测试、桌面构建、DMG 打包、资源校验、定时任务冒烟、签名校验、架构检查、DMG 校验和 SHA-256 生成。

## 12. 测试与当前验证

### 12.1 自动测试覆盖

当前测试共 128 项，主要覆盖：

1. CLI 参数、初始化、版本和敏感 URL 输出。
2. 配置兼容、默认 External 和 Controller secret 持久化。
3. 订阅解码、VLESS 解析和传输映射。
4. External staging、sing-box 校验、manifest、策略组和清理。
5. Mihomo YAML、SOCKS5 listener、Surge 规则和 dry run。
6. 双引擎 doctor 和 listener TCP 探测。
7. 桌面 IPC 契约、设置显隐、环境修复、历史和备份。
8. LaunchAgent plist、依赖资产选择和托管二进制回退。
9. 桌面启动超时恢复、重试入口、兜底脚本打包和顶部按钮稳定居中。

当前工作区已执行：

```bash
npm test
npm run build:desktop
git diff --check
```

现场结果：

1. `1.6.3` 的 `npm test` 通过，共 128 项，0 项失败。
2. 订阅部分失败测试已覆盖重复节点、直接节点去重和敏感 URL 脱敏。
3. `runtimeModeConfirmed` 已覆盖默认值、旧配置、首次 External 确认、写入阻断和定时同步阻断。
4. 引擎切换保存失败测试已覆盖应用配置、Surge 文件和 Mihomo 服务状态恢复。
5. Mihomo 测试已覆盖 `autoStart=false`、自定义进程名和清理边界。
6. `npm run build:desktop` 已执行成功，TypeScript 和桌面资源构建通过。
7. `git diff --check` 已在文档最终修改后重新执行成功。
8. 正常启动时加载遮罩成功隐藏，重试按钮保持隐藏，CDP 未捕获控制台错误。
9. 临时故障副本中模拟状态读取不返回后，加载遮罩进入失败态、转圈停止、“重新读取”按钮可用。
10. 修复后 arm64 与 x64 DMG 已生成到 `release/1.6.0-startup-fix/`，均通过打包资源、架构、临时签名和最低 macOS 12.0 检查。
11. 打包定时任务冒烟夹具已明确确认 External 引擎，并使用 arm64 与 x64 成品分别执行成功。

### 12.2 已完成的专项验证

`1.6.3` 使用官方 sing-box `1.14.4` 和 Mihomo `1.19.33` 检查五组转换后的配置：TLS、Reality、WS early data、gRPC、HTTP Upgrade，均通过。下载包 SHA-256 与官方 Release digest 一致。这是配置接受性验证，不代表真实服务端连通测试。订阅 HTTP 路径、JSON/YAML/Base64、字段保留、错误脱敏、失败保留 Surge 配置均有回归测试；打包冒烟改用 Base64 Clash 配置，覆盖 Electron 包内的 YAML 依赖加载。

1. 使用 MetaCubeX 官方稳定版 `v1.19.33` 的 `darwin-arm64` 二进制执行过 `mihomo -t -f <config>`。
2. 官方二进制接受未知 `connect-timeout` 键，官方源码中的 VLESS 和基础拨号结构没有该字段，当前 Mihomo 输出已移除该键。
3. 使用临时 HOME 和临时 Surge 配置启动过 Electron 开发版，确认 External 专属区域和共享设置显隐正确。
4. 首次运行改为前置选择层，不默认预选后端，用户必须主动选择 External 或 Mihomo。
5. 首次选择层已加入用途说明、官方安装、Homebrew 和选择已有文件入口。
6. 设置页后端切换改为带当前状态和用途说明的选项卡。
7. 900px 以下侧栏收起为 76px 图标栏，820px 以下双列表单和后端选项改为单列。
8. 按压反馈、reduced motion、长路径和窄窗口样式已加入源码并有静态测试。
9. 使用完全隔离的 HOME、Electron user-data-dir 和占位 Surge 配置完成最终界面验收。
10. 定时任务将“执行方式”收紧为 160px 固定列，已实测“按间隔”和“每天定时”两种状态，切换时没有跳位或溢出。
11. 使用隔离 HOME 和占位配置完成四步向导，实际生成 1 个节点并完成首次同步。
12. 向导返回时订阅名称、地址和推荐选项保留；完成后可从设置页重新打开并取消。
13. 通过 CDP 在 `720x680` 视口验证四步布局，面板和订阅行无横向溢出，底部按钮始终可见。

### 12.3 Electron 最终验收

| 截图 | Electron 窗口 | PNG 像素 | 验收内容 |
| --- | --- | --- | --- |
| `docs/images/dual-engine-onboarding.png` | `1180x780` | `2360x1560` | 强制后端选择层、无默认预选、用途说明和禁用确认按钮 |
| `docs/images/dual-engine-external-1180x780.png` | `1180x780` | `2360x1560` | External 概览、工作流、环境修复和活动区域 |
| `docs/images/dual-engine-mihomo-980x680.png` | `980x680` | `1960x1360` | Mihomo 后端选项、当前状态、路径和粘性保存区 |
| `docs/images/dual-engine-narrow.png` | `740x720` | `1480x1440` | 图标侧栏、单列后端选项、长路径和粘性保存区 |
| `docs/images/dual-engine-preview.png` | `980x680` | `1960x1360` | 策略组前后变化、节点表格和底部确认按钮 |

验收结果：

1. 五个尺寸的 `documentElement` 和主内容区均没有横向溢出。
2. 可见按钮文字没有裁切，预览弹窗底部按钮完整可见。
3. 工作流五个图标和定时任务图标的水平、垂直中心偏差均为 `0`。
4. 引擎未确认时显示居中的前置选择层，没有默认预选，确认按钮保持禁用。
5. CDP 未捕获未处理异常或控制台错误，界面没有白板、遮挡或卡片嵌套。
6. BrowserWindow 最小宽度保持 `720`。740px 验收中侧栏收起为 76px，后端选项和双列表单切换为单列。
7. 截图只包含占位节点、占位域名和临时路径，不包含真实订阅、UUID、token 或 Controller secret。
8. 验收后已结束本项目的调试 Electron 进程，并删除两个 `/tmp/svb-electron-qa.*` 临时目录。
9. 顶部“预览更新”“立即同步”的文字与图标相对 36px 按钮的垂直中心偏差均为 `0`，文字行高为 `14px`。
10. arm64 打包成品已使用隔离 HOME 和 user-data-dir 实际启动，加载遮罩正常隐藏、首次引擎选择正常显示、页面无横向溢出，控制台无错误。

### 12.4 尚未在当前工作区完成

1. 当前 DMG 的挂载、复制到 Applications 和首次安装验证。
2. macOS 12 实机启动、同步、定时任务和退出后后台运行。
3. Intel `x86_64` 实机或当前提交对应原生 runner 启动验证；当前只完成交叉构建和静态检查。
4. Apple Silicon `arm64` 已完成未安装 `.app` 启动验证，尚未完成 DMG 安装后的重复验证。
5. 使用真实 VLESS 节点的 TCP 可用性验证。
6. UDP ASSOCIATE、UDP DNS 和真实 UDP 节点验证。
7. Mihomo 官方下载、服务更新、启动失败和二进制回退的端到端验证。
8. Surge HTTP API 自动重载的真实环境验证。

最低系统版本和双架构目前是构建配置及 CI 设计目标，不能替代上述实机验收。

## 13. 故障排查

### 13.1 配置或节点来源失败

1. 运行 `npm run doctor` 或已安装 CLI 的 `doctor`。
2. 确认至少存在一个订阅或直接 VLESS 节点。
3. 检查错误输出是否只有来源站点和订阅序号，禁止把完整 URL 粘贴到 Issue。

### 13.2 Surge section 缺失

确认目标文件是可编辑的本地 Surge 配置，并包含 `[Proxy]`、`[Proxy Group]` 和 `[Rule]`。桌面修复入口会先备份，再追加缺失 section。

### 13.3 External 失败

1. 检查 `singBoxBinary` 是否存在且可执行。
2. 单独运行 `sing-box check -c <generated-json>` 查看结构错误。
3. 检查 `portStart` 对应端口范围。
4. 检查节点服务器域名解析是否被 Fake IP 污染。
5. `addressResolver.strategy=off` 可用于验证问题是否来自预解析。

### 13.4 Mihomo 失败

1. 运行 `mihomo -t -f <state-dir>/mihomo/config.yaml`。
2. 检查 LaunchAgent 是否安装和加载。
3. 检查 Controller 是否可达。
4. 检查每个本机回环 TCP listener 是否可连接。
5. 查看 Mihomo 标准日志和错误日志。
6. Controller 正常且 listener 不通时，优先检查 YAML 中 listeners 与 proxies 的名称对应关系。

### 13.5 Surge 未重载

`autoReload=true` 时优先使用 Surge HTTP API。未配置 HTTP API 时会尝试 `surge-cli reload`。两种方式都不可用时，手动在 Surge 中重载当前配置。

### 13.6 定时任务失败

1. 确认应用已放到稳定位置。
2. 确认桌面环境检查没有失败项。
3. 查看 `<state-dir>/desktop/scheduler.log`。
4. 检查定时任务 plist 中的应用可执行文件、`scheduled-run.js` 和配置路径。
5. 注意桌面手动同步与定时同步目前没有跨进程锁。

## 14. 回滚与恢复

### 14.1 Surge 配置

```bash
surge-vless-bridge restore --config <config-file>
```

也可传入具体备份路径：

```bash
surge-vless-bridge restore <backup-file> --config <config-file>
```

恢复后检查 Surge 当前加载的配置文件、运行引擎和本地服务状态。

### 14.2 Mihomo 配置

正式 Mihomo 同步会把当前 `config.yaml` 保存为 `config.previous.yaml`。同步失败时程序会自动尝试恢复。当前没有独立 CLI 命令手动切换这两个 YAML。

### 14.3 Mihomo 二进制

桌面“回退上一版”仅适用于项目托管安装，使用 `mihomo.previous` 与当前二进制交换。回退后应重新运行 `doctor` 和同步预览。

### 14.4 模式切换

切换失败时桌面会尝试恢复原 Surge、应用配置和 Mihomo 服务状态。应用异常退出后，先停止继续写入，保留现场文件，再根据 Surge 备份、当前 `runtimeMode`、Mihomo YAML 和 LaunchAgent 状态人工判断。

## 15. 安全与脱敏边界

1. 不把真实订阅 URL、VLESS UUID、token、Controller secret、用户名、个人绝对路径或真实 Surge 配置写入仓库。
2. 不把私有节点放入测试、Issue、截图、日志或活动历史。
3. 配置文件、`vless_nodes.txt` 和 Mihomo YAML 都包含敏感信息，应限制本机访问权限。
4. Controller 和 listeners 固定在本机回环范围，不开放局域网。
5. 渲染进程不接收 Controller secret。
6. 安装包只从官方来源下载，托管 Mihomo 安装要求大小和 SHA-256 同时匹配。
7. 外部错误消息进入历史前必须检查是否含完整 URL、授权头或节点链接。
8. 测试使用临时目录、占位域名和占位凭据，完成后清理。
9. 不修改用户真实 Surge 配置、真实订阅、`backup/` 和 `release/` 进行开发验证。

文档敏感检查可先定位高风险模式，再人工确认：

```bash
rg -n 'Bearer |PRIVATE KEY|controllerSecret|subscriptionUrl|vless://' docs/dual-engine-mihomo-development.zh-CN.md
```

字段名和占位符允许出现，真实值禁止出现。

## 16. 已知限制

1. 桌面 `operationRunning` 没有覆盖定时同步或其他进程。
2. 模式切换没有跨进程事务文件和启动恢复状态机。
3. External 在提升节点配置后的少数写入失败场景缺少完整文件级回滚。
4. External 正式同步可能在后续失败前更新订阅缓存。
5. Mihomo `rebuild` 不校验 YAML，也不确保服务运行。
6. `restore` 只恢复 Surge 配置。
7. 历史和备份界面只展示 Surge 备份，未统一展示 Mihomo YAML 和切换状态。
8. `clean` 会保留日志、二进制、订阅缓存和备份，需要用户明确决定后再扩展清理范围。
9. Mihomo doctor 只验证配置、LaunchAgent、Controller 和 TCP listener。
10. 远端节点连通、HTTP 请求、UDP ASSOCIATE 和 UDP DNS 尚无分层诊断。
11. CLI 通过配置文件选择引擎，暂时没有独立的引擎切换参数。
12. 自定义托管区块 marker 缺少完整支持和测试。
13. macOS 12、x64 和 arm64 正式成品尚未完成当前工作区实机验收。
14. 窄窗、首次引擎选择和预览弹窗已完成 Electron 验收，尚未在 macOS 12 实机上重复相同验收。

## 17. 后续开发优先级

### P0 发布收尾

1. 增加跨进程同步锁和陈旧锁恢复。
2. 增加模式切换事务文件和应用启动恢复。
3. 完成 External 后半段写入失败的原子提交或文件级回滚。
4. 完成 macOS 12、x64、arm64 正式成品验收。
5. 使用隔离环境完成真实更新和二进制回退验证。

### P1 诊断与恢复

1. 增加 SOCKS5 握手、UDP ASSOCIATE、UDP DNS、远端节点和 HTTP 分层诊断。
2. 将 Mihomo 当前 YAML、上一版 YAML 和切换事务纳入统一备份视图。
3. 增加手动恢复 Mihomo 上一份 YAML 的受控入口。
4. 明确清理日志、缓存和二进制的独立操作，避免扩大现有 `clean`。

### P2 体验与发布

1. 补充签名、公证、安装和首次启动流程。
2. 根据实机结果完善 Intel 与 Apple Silicon 的依赖说明。
3. 补充同一真实节点在 External 和 Mihomo 下的成功率与资源占用对比。

## 18. 接手与交付清单

开始前：

```bash
git status --short
npm test
```

文档或代码修改后至少执行：

```bash
npm test
npm run build:desktop
git diff --check
```

涉及打包时追加：

```bash
npm run desktop:package
npm run desktop:verify -- <app-path>
npm run desktop:smoke
```

交付报告必须说明：

1. 修改文件和行为变化。
2. 实际执行的测试及结果。
3. Mihomo、Surge、macOS 12、x64 和 arm64 的实际验证范围。
4. 尚未执行的真实环境验证。
5. 使用的备份、回滚路径和临时文件清理结果。
6. 最终 `git status --short`。
7. 敏感信息扫描结论。

## 19. 官方资料

1. Mihomo 官方仓库与 Release：`https://github.com/MetaCubeX/mihomo`
2. Mihomo 官方文档：`https://wiki.metacubex.one/`
3. Surge 官方手册：`https://manual.nssurge.com/`
4. sing-box 官方文档：`https://sing-box.sagernet.org/`
5. Electron 官方文档：`https://www.electronjs.org/docs/latest/`

涉及 Surge 参数、Mihomo schema、Electron 打包或 macOS LaunchAgent 时，优先核对官方文档、官方源码和真实二进制。若未来分发第三方 GPL 二进制，需要单独完成许可证、源码提供和第三方通知评估。

## 20. Mihomo 参考项目与更新评估（2026-10-31）

感谢 [ssfun 及 Surge External Bridge 贡献者](https://github.com/ssfun/surge-external-bridge) 提供的 Mihomo 网关设计和文档。项目的直接上游仍为 [chen86860/surge-vless-bridge](https://github.com/chen86860/surge-vless-bridge)。这两个来源应分别保留署名。

### 20.1 核对基线与最近更新

本轮核对参考项目 `main` 的 HEAD 为 [`225ad72`](https://github.com/ssfun/surge-external-bridge/commit/225ad72ec28dfff17387939253f5d65afde85768)，提交时间为 2026-09-08 18:15:47（Asia/Singapore）。该时间早于本项目 10 月引入 Mihomo 的阶段；没有发现该主分支在此之后的新提交，不能把下面功能描述成近期刚新增或本项目已经合入。

| 提交 | 参考项目的变化 | 对本项目的判断 |
| --- | --- | --- |
| [`225ad72`](https://github.com/ssfun/surge-external-bridge/commit/225ad72ec28dfff17387939253f5d65afde85768) | 紧凑节点列表、记住显示方式、更新设置分栏、窄窗口与能力标签换行 | 借鉴紧凑列表和布局验收。我们目前主要展示同步预览，暂无其完整节点诊断页，不宜直接移植 Vue 页面。 |
| [`984b057`](https://github.com/ssfun/surge-external-bridge/commit/984b05719129eaf566b782d1121779c4c7edac73) | CLI 更新与运行实例协调、离线实例锁、回滚保护 | 借鉴同一实例识别、更新互斥和回滚状态核验。我们的进程内操作锁不能覆盖 CLI 与后台任务的并发。 |
| [`5e4b950`](https://github.com/ssfun/surge-external-bridge/commit/5e4b95033141805e0f287c4ffa6acebb153fdd42) | 基于 Release 的自动更新、服务接管、失败回滚与设置页 | 优先完善内核更新后的运行版本与就绪验证；Electron 应用自身自动更新需单独设计。 |
| [`37ff2fe`](https://github.com/ssfun/surge-external-bridge/commit/37ff2feeebefcb3d389e8fe40b29a28ebb4f792b) | 放宽实时连接快照大小限制 | 当前没有对应连接监控转发功能，无需移植；未来引入时再验证大连接数负载。 |

### 20.2 现有能力中值得借鉴的部分

以下依据固定版本的 [README](https://github.com/ssfun/surge-external-bridge/blob/225ad72ec28dfff17387939253f5d65afde85768/README.md)、[自动更新文档](https://github.com/ssfun/surge-external-bridge/blob/225ad72ec28dfff17387939253f5d65afde85768/docs/auto-update.md) 和相关源码，以及本项目 `1.6.3` 源码对照形成。属于后续建议，本轮仅修改文档。

1. **优先：订阅失败保留该来源上次成功节点。** 参考项目通过 Mihomo Provider 缓存保留成功内容。本项目 `collectVlessNodes()` 对失败来源返回空数组；其他来源成功时仍可继续同步，失败来源旧节点可能因此从生成配置消失。应增加按来源隔离的最后成功缓存，显示缓存时间与失败状态，并区分下载失败、有效空订阅和用户主动删除来源。缓存不得输出私有 URL 或凭据。
2. **优先：实际 TCP/UDP 诊断和分阶段结果。** 参考项目 [`internal/gateway/probe.go`](https://github.com/ssfun/surge-external-bridge/blob/225ad72ec28dfff17387939253f5d65afde85768/internal/gateway/probe.go) 经 SOCKS 执行 HTTP/TLS 与 UDP DNS 测试，区分入口、认证、出站、TLS 和响应错误。本项目 Mihomo doctor 当前只检查配置、服务、Controller 和本地 TCP 端口；端口可连接不能证明节点可用。后续应标明测试目标、时间与失败阶段，并明确桥接链路诊断不等同于经过 Surge 的整条链路验收。诊断功能本身不能保证提高节点成功率。
3. **优先：内核更新完成后的运行验收与自动恢复。** 本项目官方 Mihomo 安装已有下载大小、SHA-256、候选版本检查和上一版文件；`installMihomo()` 在保存二进制路径后即报告完成，未核对运行服务是否使用目标版本。参考项目在重启后验证版本、实例身份和网关状态，失败才恢复。应适配为本项目的独立内核更新事务，不能用下载完成或文件替换成功代表正在运行的新版本已可用。Homebrew 与托管安装需分别处理回退能力。
4. **后续：稳定节点身份。** 参考项目 [`projection.go`](https://github.com/ssfun/surge-external-bridge/blob/225ad72ec28dfff17387939253f5d65afde85768/internal/mihomo/projection.go) 根据节点身份生成凭据。本项目以 `portStart + index` 分配端口，订阅重新排序会改变节点端口。可借鉴稳定身份思想，持久化节点与端口映射；无须为此先改成共享认证端口。
5. **后续：紧凑节点操作界面。** 当前预览已有列表，可在增加真实诊断后提供筛选、批量检测、结果时间和失败原因。布局验收覆盖窄窗口、长名称、换行与批量状态；不为复制参考项目外观增加无用卡片。

### 20.3 保留的架构边界

参考项目使用 Go 内嵌 Mihomo、原生 Provider、自管共享认证 SOCKS5 listener 和 `policy-path` 发布。我们使用 Node.js/Electron、独立 Mihomo 二进制、每节点回环 listener 和直接维护 Surge 托管区块。共享端口、Provider 热更新、多协议透传、局域网网关与 Policy Path 均属于架构扩展，暂不整体迁入。

本项目当前 Clash 导入仍只接收 VLESS，并经公共模型转换；参考项目的原生 Mihomo Provider 能力不能作为本项目已支持全部 Clash 字段或协议的依据。其自动更新文档中的测试结果也不能作为我们已完成的验收证据。

参考项目根目录 [LICENSE](https://github.com/ssfun/surge-external-bridge/blob/225ad72ec28dfff17387939253f5d65afde85768/LICENSE) 声明 GPL-3.0-or-later，并附有名称与关联使用限制；本项目当前声明 MIT。后续应参考行为需求独立实现；若复制或改编其代码，须先核对相应许可证义务，致谢不能替代许可证合规。本轮增加来源链接和分析，未引入参考项目源码。
