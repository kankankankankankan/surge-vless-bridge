# macOS 桌面应用指南

## 系统要求

- macOS 12.0 或更高版本
- Apple 芯片使用 `arm64` 安装包
- Intel 芯片使用 `x64` 安装包

## 功能

桌面应用与 CLI 共用 TypeScript 核心，包含：

- 订阅地址和直接 VLESS 节点管理
- 首次启动和后续重新配置共用的四步配置向导
- Surge 配置文件和 `sing-box` 检查与修复
- 从官方发布包或 Homebrew 安装、检查和更新 `sing-box`
- DoH、指定 DNS、系统 DNS 和关闭解析的可视化设置
- 将 VLESS 策略组批量加入多个已有 Surge 策略组
- 更新预览和立即同步
- 本地重建、备份恢复和托管配置清理
- 操作历史和后台任务日志
- 用户级 `launchd` 定时同步

## 图形化工作流

概览页按实际操作顺序组织为五步：

1. 添加订阅或直接节点。
2. 检查并修复运行环境。
3. 预览节点、端口和 Surge 配置变化。
4. 确认后写入 Surge。
5. 按需要启用自动同步。

前四步属于核心同步流程，自动同步属于可选项。概览会根据当前状态给出下一步操作。顶部的「立即同步」也会先生成预览，确认后才会写入配置。

订阅和直接节点使用逐项列表管理，支持单项添加、删除和一次粘贴多行。订阅响应支持 VLESS URL 列表、Base64 编码的 URL 列表，以及包含 `proxies` 的 Clash/Mihomo YAML 或 JSON（包括 Base64 编码的 Clash 配置）。来源发生修改后，界面会标记为未保存，并在保存前阻止预览和同步。

如果服务商使用真正的 AES、ChaCha 或自定义加密，Clash 客户端通常依靠服务商内置的解密方式或密钥才能读取，程序无法仅凭订阅地址通用解密；这类来源会在执行输出中显示响应格式或解码原因。

预览确认层会显示节点总数、新增和移除配置数量、Surge 配置是否变化、VLESS 策略组、批量加入的目标组、配置路径以及每个节点使用的本地端口。

设置页的「策略组成员关系」会直接读取当前 Surge 配置并显示为勾选列表。已经包含 VLESS 的组会直接勾选，也可以取消。每个已勾选组可选择「自动判断」「合并节点」或「引用策略组」。

自动判断遇到 `smart`、`include-other-group` 或 `policy-regex-filter` 时，会把 VLESS 合并到 `include-other-group`。普通 `select`、`url-test` 和 `fallback` 等组会直接引用 VLESS。`smart` 组不能选择直接引用。取消勾选后，下次同步会从直接成员和 `include-other-group` 中移除 VLESS，并保留其他成员与参数。

配置文件暂时无法识别的组名可以展开手动输入。任何目标组找不到时，本次同步会停止并显示缺失名称。更新预览会列出策略组修改前后的完整配置行。

CLI 命令保持可用，配置文件仍为：

```text
~/.config/surge-vless-bridge/config.json
```

## 本地运行

```bash
npm install
npm run desktop
```

## 首次配置

首次启动会直接打开配置向导：

1. 选择 `sing-box External` 或 `Mihomo 网关`，并通过官方版、Homebrew 或现有可执行文件准备对应内核。
2. 添加带自定义名称的订阅地址，也可按行填写直接 `vless://` 节点。
3. 选择 Surge 配置，设置策略组、起始端口、备份数量和常用连接选项。「应用推荐值」可一次填入稳定优先的默认组合。
4. 在汇总页确认运行方式、节点来源、配置路径和常用选项，然后保存并执行首次同步。

向导会在每一步持续显示校验失败原因。同步失败时保留当前页和已填内容，可返回修改后重试。

已经完成配置后，可从「设置 > 运行引擎 > 配置向导」重新打开同一流程。此时会载入已保存的订阅、路径和选项，可随时取消而不改动现有配置。

订阅和直接节点在界面中默认遮挡，可通过眼睛按钮临时显示。

## 环境修复

「概览」中的环境检查会为可处理项目显示操作按钮：

- 节点目录和备份目录可以直接创建
- 自动找到 Surge 配置时可以直接选用
- 缺少 `[Proxy]` 或 `[Proxy Group]` 时可以补齐，修改前会创建备份
- 缺少节点来源时跳转到「订阅与节点」
- 缺少 `sing-box` 时跳转到安装区域

官方版安装会从 `SagerNet/sing-box` 的 GitHub Release 下载适配当前 Mac 的压缩包，核对文件大小和 SHA-256 后安装到：

```text
~/.config/surge-vless-bridge/bin/sing-box
```

Homebrew 安装会调用本机已有的：

```bash
brew install sing-box
```

## sing-box 版本管理

设置页会显示当前版本、官方稳定版、安装来源和更新状态。最新版本从 `SagerNet/sing-box` 官方 GitHub Release 读取，检查结果缓存六小时。

官方托管版更新流程：

1. 下载当前 Mac 架构对应的稳定版。
2. 核对文件大小和 GitHub Release 提供的 SHA-256。
3. 用新二进制对现有所有 `sing-box[PORT].json` 执行 `sing-box check`。
4. 验证通过后原子替换可执行文件，并保留 `sing-box.previous`。
5. 回退前同样会用旧版验证全部节点配置。

Homebrew 来源保持由 Homebrew 管理：首次安装执行 `brew install sing-box`，已安装时执行 `brew upgrade sing-box`。Homebrew 版本不使用应用内的二进制回退。

## Surge 参数边界

当前生成的 Surge External Policy 只使用 Surge 官方明确支持的字段：

| 字段 | 用途 |
|---|---|
| `exec` | 启动 sing-box 可执行文件 |
| `args` | 传入 `run -c CONFIG` |
| `local-port` | 指定本地 SOCKS5 端口 |
| `addresses` | 声明节点服务器的真实 IP，避免外部进程流量再被 Surge 接管 |
| `udp-relay` | 可选，允许 Surge 通过本地 SOCKS5 端口转发 UDP |
| `test-udp` | 可选，使用指定域名和 IPv4 测试 UDP 连通性 |

`tcp_fast_open`、`tcp_multi_path`、`udp_fragment`、`multiplex`、`packet_encoding`、`network_strategy`、Reality、uTLS 和 ALPN 属于 sing-box 配置，不会写入 Surge External Policy。

设置页的「启用 UDP 转发」默认关闭。开启后，每个托管 external 节点会写入 `udp-relay=true`。生成的 sing-box SOCKS 入站支持 UDP ASSOCIATE，可用于游戏、QUIC、语音通话和 UDP DNS。上游 VLESS 节点仍需支持 UDP。

「UDP 连通性测试」开启后写入 `test-udp=域名@IPv4`，并且要求 UDP 转发同时开启。默认目标为 `apple.com@8.8.8.8`，可在设置中修改。

「远程 TCP Fast Open」在 External 和 Mihomo 中均可用。「自定义连接超时」仅用于 External，会写入 sing-box outbound 的 `connect_timeout`。Mihomo VLESS proxy schema 没有每节点 `connect-timeout` 字段，界面在 Mihomo 模式下会隐藏该选项。

`test-url` 仍由 Surge 策略组和用户配置决定，本工具不自动覆盖。

## DNS 设置

「设置」中的「节点地址解析」支持：

- `DoH`：显示并允许修改 HTTPS 端点，默认 `https://1.1.1.1/dns-query`
- `指定 DNS`：每行填写一个 IPv4 或 IPv6 DNS 地址，也支持逗号分隔
- `macOS 系统 DNS`：使用当前网络服务中的系统 DNS，不在应用内固定地址
- `关闭地址解析`：生成的 external proxy 不写入 `addresses` 参数

解析失败时会按照现有 CLI 逻辑尝试其余解析方式。可以保留 Fake IP 过滤，避免把 `198.18.0.0/15` 写入 Surge 配置。

## 定时任务

定时任务使用用户级 `launchd`，不需要管理员权限。支持：

- 每 1、6、12 或 24 小时同步，也可以自定义 1 至 168 小时
- 每天固定时间同步
- Mac 登录后执行一次
- 失败时发送 macOS 通知

启用前会执行环境检查。存在必填项问题时，应用会拒绝注册定时任务。

相关文件：

```text
~/Library/LaunchAgents/com.chen86860.surge-vless-bridge.sync.plist
~/.config/surge-vless-bridge/desktop/schedule.json
~/.config/surge-vless-bridge/desktop/scheduler.log
```

## 打包

### GitHub Actions 自动构建

`.github/workflows/build-macos.yml` 会在以下场景运行：

1. 推送到 `master`。
2. 推送 `v*` 标签。
3. 修改桌面应用相关文件的 Pull Request。
4. 在 GitHub Actions 页面手动运行。

工作流使用两个原生 macOS runner：

| 成品 | GitHub runner | 架构 |
| --- | --- | --- |
| Intel Mac | `macos-15-intel` | `x86_64` |
| Apple 芯片 Mac | `macos-15` | `arm64` |

每个任务都会运行完整测试、构建桌面资源、生成 DMG、检查应用资源、验证后台任务入口、校验签名和实际架构，
并执行 `hdiutil verify`。通过后上传 DMG 与 SHA256 文件，Artifacts 默认保留 14 天。

### 本地打包

生成应用图标：

```bash
npm run desktop:icon
```

生成本地 `.app`：

```bash
npm run desktop:package
```

输出位于：

```text
release/mac-arm64/Surge VLESS Bridge.app
```

生成 DMG：

```bash
npm run desktop:dmg
```

公开分发前需要配置 Apple Developer ID 签名和公证。

## 恢复

桌面应用每次修改 Surge 配置前都会创建备份。可以在「历史与备份」中查看备份，并从「概览」恢复最新备份。

终端恢复命令：

```bash
surge-vless-bridge restore
```

停用定时任务可以在界面中点击「停用任务」。

## 验证

```bash
npm test
npm run build:desktop
npm run desktop:package
```

真实同步需要可用的 `sing-box` 和 Surge 配置。桌面应用可以安装 `sing-box`，也可以为 Surge 配置补齐 `[Proxy]` 和 `[Proxy Group]`。
