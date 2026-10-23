# 更新日志

[English Changelog](./CHANGELOG.md)

本文件记录项目的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## 未发布

### 新增

- GitHub Actions 使用原生 Intel x86_64 和 Apple 芯片 arm64 runner 构建并验证 DMG，同时上传各架构安装包和 SHA256 校验文件。

### 修复

- npm 发布改为手动运行并要求 `npm-publish` 环境，避免 fork 每次推送都产生无权限的发布失败记录。

## [1.5.19] - 2026-10-24

### 修复

- 自动重载 Surge 前只停止本应用托管的 sing-box 进程，避免同步、本地重建、恢复或清理后旧进程继续占用节点端口。

## [1.5.18] - 2026-10-24

### 修复

- 从固定源码目录收集桌面界面资源，直接运行 Electron Builder 也不会生成白屏安装包。
- 界面入口加载失败时显示明确的安装包错误提示。
- Intel 与 Apple Silicon 成品统一使用可复现的 ad hoc 签名。

## [1.5.17] - 2026-10-23

### 新增

- 设置页增加 sing-box 远程 TCP Fast Open 和自定义连接超时。
- UDP external 节点可设置 Surge UDP 连通性测试目标。

### 修复

- 较矮窗口和显示缩放场景下，更新预览底部操作按钮会避开 macOS Dock。

## [1.5.16] - 2026-10-23

### 新增

- 设置页和配置文件增加 Surge External Policy UDP 转发开关。
- 开启后，订阅同步和本地重建都会保留 `udp-relay=true`。

### 改进

- 现有配置默认保持关闭，由用户按节点和使用场景主动开启。

## [1.5.15] - 2026-10-23

### 新增

- 设置页显示 sing-box 当前版本、官方最新稳定版、安装来源和更新状态。
- 官方托管版更新前会用新二进制检查全部现有节点配置，更新后可回退上一版。

### 改进

- Homebrew 已安装 sing-box 时使用 `brew upgrade sing-box`，首次安装继续使用 `brew install sing-box`。
- 新增 Surge External Policy 参数边界回归测试，防止将 sing-box 专属参数写入 Surge 配置。

### 修复

- 支持官方 GitHub 发布标签的 `v` 前缀，未安装 sing-box 时检查更新也会正确显示最新版本。

## [1.5.14] - 2026-10-23

### 修复

- 自定义同步间隔改为独立的完整行，最小窗口宽度下的下拉框、数值、单位和说明文字保持清晰对齐。

## [1.5.13] - 2026-10-23

### 新增

- 每个策略组可选择自动判断、合并节点或引用策略组。
- 更新预览显示策略组修改前后的完整配置行。

### 改进

- `smart`、包含 `include-other-group` 或包含 `policy-regex-filter` 的策略组会自动采用合并节点。
- 在写入配置前拦截 Surge 智能策略组直接引用其他策略组的无效组合。

## [1.5.12] - 2026-10-23

### 改进

- 已经包含 VLESS 的策略组会直接显示为勾选，仍可取消。
- 取消后下次同步会从该策略组移除 VLESS，保留其他成员和参数。
- 列表显示已加入、待加入、待移除和保持不加入四种状态。

## [1.5.11] - 2026-10-23

### 修复

- 向 `smart` 策略组加入 VLESS 时改为合并 `include-other-group`，符合 Surge 智能策略组语法。
- 自动迁移已经写成直接子策略的 `VLESS`，并在清理托管配置时移除对应引用。

## [1.5.10] - 2026-10-23

### 修复

- 更新预览在较窄窗口或显示缩放下保持完整，关闭按钮、全部统计项、本地端口列和底部操作不再超出窗口。
- 长路径和策略组列表会省略显示，悬停时仍可查看完整内容。

## [1.5.9] - 2026-10-23

### 改进

- 策略组列表增加全选、清空和实时选中数量。
- 重新读取会使用当前输入的 Surge 路径，并保留尚未保存的勾选。
- 同步工作流改用与每个步骤含义一致的图标，应用图标改为连接线缆图形。
- 设置页增加底部固定保存区，减少长页面往返滚动。

## [1.5.8] - 2026-10-23

### 改进

- 设置页会读取当前 Surge 配置中的策略组，直接显示为可勾选列表。
- 已经包含 VLESS 的策略组会显示状态并保持原样，未识别的名称仍可手动补充。
- 后台任务日志隐藏 Electron 在 `launchd` 环境下产生的已知父进程检查警告，保留同步结果和真实错误。

## [1.5.7] - 2026-10-23

### 新增

- 设置页支持批量填写已有 Surge 策略组，同步时自动将 VLESS 组加入这些目标组。
- 更新预览会显示目标策略组，清理托管配置时会同步移除这些关联。

### 改进

- 批量写入会保留目标组类型、已有成员、参数和行内要求注释，并自动去重。
- 目标策略组缺失时会在修改配置和节点文件前停止，并列出缺失名称。

## [1.5.6] - 2026-10-23

### 改进

- 侧边栏显示安装包真实版本号。
- 定时任务页面明确说明退出软件后仍由 macOS 后台执行。

## [1.5.5] - 2026-10-23

### 新增

- 历史与备份页面增加手动清空历史和清理旧备份功能，清理备份时保留最新一份。

### 修复

- 应用图标改用透明画布和 macOS 圆角轮廓，修复 Dock 中显示为实心方块的问题。

## [1.5.4] - 2026-10-23

### 新增

- 定时同步支持 1 至 168 小时的自定义间隔，同时保留常用快捷值。

### 改进

- 重新整理定时任务页面的下次执行状态、图标和间距，移除卡片内的重复边框。
- 设置页将“节点地址解析”改为“节点服务器域名解析”，明确该功能只解析 VLESS 节点服务器，
  不影响经代理访问的网站域名。

## [1.5.3] - 2026-10-23

### 修复

- macOS 图形界面现在会检查应用托管目录、`~/.local/bin`、`/opt/homebrew/bin` 和 `/usr/local/bin`，
  终端已经安装的 `sing-box` 不再因为图形应用缺少 shell PATH 而被误报为未安装。
- 未找到 `sing-box` 时，设置页默认显示应用官方安装功能实际使用的托管路径。

## [1.5.1] - 2026-08-18

### 修复

- 使用字面 IPv6 地址的节点现在可以正常工作。URL 解析会把这类主机名带方括号返回（`[2001:db8::1]`），
  该值同时进入了生成的 sing-box 配置和地址解析流程。sing-box 的 `server` 字段按 IP 或域名解读，带括号的
  值两者都不是，于是被当作域名去查询、永远解析不出结果 —— 节点能启动，但没有任何请求真正走通。
  `sing-box check` 只把该字段当普通字符串校验，因此不会报错。现在在解析链接处就去掉方括号，同时也修正了
  写入 Surge 外部代理行的 `addresses=`。

### 升级说明

- 本次发布之前生成的节点配置中，`server` 仍带方括号，`rebuild` 会原样复用。若使用 IPv6 节点，请完整执行
  一次 `sync` 重新生成。

## [1.5.0] - 2026-08-17

### 新增

- `init` 改为交互式：先询问订阅地址（也接受原始 `vless://` 链接，会写入 `vlessNodes`），再从列表中选择
  Surge 配置文件，列表显示每个文件的最后修改时间，可用 ↑/↓ 或数字键选择。订阅地址回车跳过、配置文件按 Esc
  跳过，跳过的项之后仍可手动填写。
- `--no-input`：不作任何询问，直接写出配置模板。`init` 也会自行检测 TTY 缺失，因此在 agent、CI 或管道中
  不会卡住等待输入。
- 新增 [docs/agent-setup.md](./docs/agent-setup.md)，面向 AI agent 的操作指南：命令顺序、配置文件的落盘
  规则、`doctor` 输出如何解读，以及哪些命令必须先经用户确认。

### 变更

- `init` 结束时会回显记录到的内容 —— 节点来源（凭据部分打码）和选中的 Surge 配置文件 —— 并给出下一条应当
  执行的命令。
- 未探测到 Surge 配置文件时，`init` 会说明去哪里获取路径，并支持从 Finder 直接把文件拖进终端：拖入的
  shell 转义路径会被还原，而不是原样存进配置。
- 传给 `init` 的值在写入前统一去除首尾空白，`--subscription-url` 带空格不再把空白写进配置文件。
- `init` 在提问之前先检查配置文件是否已存在，不再等用户答完才拒绝覆盖。

## [1.4.0] - 2026-08-13

### 新增

- `sync --dry-run`：输出本次同步将生成的节点、端口和配置改动，不写入任何文件。
- `clean` 命令：删除生成的节点配置，并从 Surge 配置中移除托管区块和对应策略组，其余内容保持不变；执行前
  会先备份。
- `sync`、`rebuild`、`restore` 之后自动让 Surge 重载配置，优先走 Surge HTTP API（`[General]` 里的
  `http-api`），否则尝试 `surge-cli`。可用 `--no-reload` 或 `"autoReload": false` 关闭。
- `backupKeep`（默认 `20`）：自动清理超出数量的旧备份，此前备份会无限堆积。
- 帮助菜单显示仓库地址和问题反馈入口。

### 变更

- 未知 flag、未知命令、缺少取值、数字参数传入非数字，现在都会直接报错退出。此前拼错的 `--group-nmae` 会被
  静默忽略，命令看起来执行成功，实际用的是别的配置。
- 支持 `--flag=value` 写法。
- 帮助菜单只展示用户实际使用的配置文件路径，移除了开发用路径的说明。

### 修复

- `doctor` 在存在失败项时以非 0 退出码结束，脚本和 CI 可以据此判断。
- `doctor` 会真实检查 `outputDir` 和 `backupDir` 是否存在，不再一律显示 OK；首次同步前目录不存在只算
  warning，不算失败。
- `doctor` 新增本地端口占用范围，以及 Surge HTTP API 是否可用的检查。

## [1.3.1] - 2026-08-13

### 修复

- 生成的配置不再写入 `tls.record_fragment`。该选项从 sing-box 1.12 才引入，而且写入的一直是默认值；在更早的
  版本上（包括 macOS 10.15 仍在使用的 1.11.x），sing-box 会以 `json: unknown field` 拒绝每一个生成的配置并
  立即退出，在 Surge 里表现为 `External Proxy Process Terminated`
  （[#5](https://github.com/chen86860/surge-vless-bridge/issues/5)）。

## [1.3.0] - 2026-08-13

### 新增

- `sync` 先在临时目录里生成并校验全部节点，通过后再一次性落盘，因此中途失败不会动到 Surge 配置，也不会
  破坏上一次同步的节点配置（改编自 [#7](https://github.com/chen86860/surge-vless-bridge/pull/7)，感谢
  [@MapleGu](https://github.com/MapleGu)）。
- 每次同步产生的节点配置会记录到 `manifest.json`，`rebuild` 据此重建，不再直接扫描整个目录；没有
  manifest 的旧安装仍可回退到扫描方式。
- 生成的配置会用 `sing-box check` 校验，最多 8 个进程并发。注意这只是结构校验：它能拒绝非法 JSON 和未知
  outbound 类型，但缺字段或字段值离谱的配置照样能通过，**不等于连通性测试**。
- 新增 26 个 `node --test` 测试，CI 在 Node 20 / 22 / 24 上运行。

### 修复

- `rebuild` 不再复活已从订阅中删除的节点；订阅节点减少时，多余的节点配置会在 `sync` 时清理掉。
- 不再无条件对订阅内容做 Base64 解码。现在会先识别纯文本链接列表、支持 URL-safe 字母表，遇到无法识别的
  响应（例如账号过期返回的 HTML 错误页）直接报错，而不是解码成乱码后同步出 0 个节点。
- 订阅请求 15 秒超时，不再因为机场无响应而让 `sync` 无限挂起。
- 缺少 public key 的 reality 节点在解析阶段就报错。sing-box 缺这个字段照样能启动，但握手必然失败，在 Surge
  里表现为"一请求就断"的外部代理。
- 所有来源都没有解析出 VLESS 节点时，`sync` 拒绝改写 Surge 配置；Surge 配置文件或 sing-box 可执行文件缺失
  时提前报错并给出明确提示。
- 正确处理 CRLF 换行，以及单个订阅内部的重复链接。

## [1.2.0] - 2026-08-13

### 新增

- `subscriptionUrls`：把多个 VLESS 订阅合并进同一个 Surge 策略组
  （[#4](https://github.com/chen86860/surge-vless-bridge/pull/4)，感谢
  [@SKYhuangjing](https://github.com/SKYhuangjing)）。
- `vlessNodes`：支持在配置里直接写裸 `vless://` 链接，用于不属于任何订阅的节点。
- 重名节点自动追加序号（`HK 01 2`），不同机场存在同名节点时不再触发 Surge 的 `Policy already exists` 错误。
- `sync` 时清理旧版本遗留在 `# vless start` / `# vless end` 区块之外的 external 代理行。

### 变更

- `subscriptionUrl` 与 `subscriptionUrls` 改为合并去重，而不是后者覆盖前者；`subscriptionUrl` 排在最前，
  保证既有节点顺序和本地端口不变。在原有配置上新增第二个机场，不会再静默丢掉原订阅。
- `doctor` 的 `subscriptionUrl` 检查项改名为 `nodeSources`，会显示已配置的订阅数量和直填节点数量。

### 修复

- 订阅拉取失败时会指明是第几个订阅（`Subscription 2 of 3`），并且只用 origin 标识机场，不会泄露 URL
  路径或查询串里的 token。
- 某个订阅没有解析出 VLESS 节点时打印告警，不再静默地不产生任何节点。

## [1.1.0] - 2026-08-13

### 变更

- **`addressResolver.strategy` 默认值从 `system` 改为 `doh`。** 开启 Surge 增强模式后，系统解析会返回
  `198.18.0.0/15` 段的 fake IP，这些地址会被固定写进 `addresses=`，导致生成的节点连不通。DoH 完全绕开
  系统解析，因此 `sync` 不再需要先关闭增强模式
  （[#3](https://github.com/chen86860/surge-vless-bridge/issues/3)）。
- 地址解析支持自动回退。除 `off` 外，任何策略在自身结果为空、或过滤 fake IP 后为空时，都会依次尝试其余
  解析方式（`doh` → `dns` → `system`，其他策略同理）。单个解析方式失败不再中断该节点的整个解析流程。
- 一个域名解析出多个地址时优先使用 IPv4。Surge 的 `addresses=` 只接受单个地址，而 A/AAAA 记录的返回顺序
  不稳定，此前可能写入 IPv6 地址，在没有 IPv6 出口的网络下无法连接。没有 A 记录时仍然写入 IPv6。

### 修复

- 解析出错时按解析方式单独记录日志并跳过，不再中断整个查询并静默省略 `addresses=`。完全无法解析的节点会
  给出明确的错误提示。

## [1.0.8] - 2026-06-13

### 新增

- `surge-vless-bridge --version`，用于打印当前安装的版本号。

## [1.0.7] - 2026-06-13

### 修复

- 发布流程明确指定 `master` 分支。

## [1.0.6] - 2026-04-15

### 修复

- 写入 `addresses=` 前过滤 Surge fake IP（`198.18.0.0/15`），`addressResolver` 新增 `filterSurgeFakeIp`、
  `dohEndpoint`、`dnsServers` 选项（[#1](https://github.com/chen86860/surge-vless-bridge/pull/1)）。
- `outputDir` 默认值调整为 `~/.config/surge-vless-bridge/nodes`。

## [1.0.1] - [1.0.5] - 2026-04-14 / 2026-04-15

首批公开发布：`init` / `sync` / `rebuild` / `restore` / `doctor` 命令、VLESS 订阅解析、按节点生成
sing-box 配置、Surge 配置备份，以及 npm 发布流程。

[1.5.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/chen86860/surge-vless-bridge/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.6...v1.1.0
[1.0.8]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.6...v1.0.8
[1.0.7]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.5...v1.0.6
