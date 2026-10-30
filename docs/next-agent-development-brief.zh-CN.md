# Surge VLESS Bridge 新 Agent 交接任务书

更新时间：2026-10-31

适用版本：`1.7.0`

## 1.7.0 可靠性改进

已实现按来源缓存、Mihomo TCP/UDP 实际诊断和内核更新事务。实现边界、恢复路径和验收记录见主开发文档第 21 节。第 20 节保留原评估快照，当前实现状态以第 21 节为准。

复查发现：失败请求写回请求前的快照可能覆盖另一任务的新数据，因此订阅收集使用跨进程互斥；诊断只传端口会在订阅重排后测错节点，因此现在传入并验证名称及端口。同步、重建、清理、诊断和更新共用桥接操作锁。普通锁在正常退出时清理，异常退出留下的锁需先核对任务已停止再移除，禁止自动抢锁。

UI 验收使用隔离 HOME 和 Electron user-data-dir；先 `npm test`，再 `npm run build:desktop`。反向执行会因测试构建清空 `dist/` 而删除渲染资源，使启动验收落入缺少页面资源的兜底页。

## Mihomo 参考项目核对记录

2026-10-31 已补充中英文 README 对 `ssfun/surge-external-bridge` 及其架构、自动更新文档的致谢。核对主分支最新提交为 `225ad72`（2026-09-08），早于本项目引入 Mihomo 的时间。详细源码对照和采纳建议见[主开发文档第 20 节](dual-engine-mihomo-development.zh-CN.md#20-mihomo-参考项目与更新评估2026-10-31)。本轮只更新文档，未移植功能。

下一阶段优先考虑按来源保留最后成功订阅、真实 TCP/UDP 分阶段诊断、内核更新后的运行版本验证与失败恢复。不要把参考项目内嵌 Mihomo 的能力、测试结果或最近提交直接视为本项目已有功能；GPL 代码也不能仅加致谢后直接纳入 MIT 项目。

后续发布仅推送源码和版本标签，由 GitHub Actions 构建 x64/arm64 并发布，不上传本地编译产物。先前本地上传记录仅描述历史交付。

## 订阅兼容修复记录

`1.6.3` 修复 Clash 配置中存在 `type: vless` 仍报无节点的问题。根因是旧入口只接收链接列表；新增 Clash YAML/JSON 和 Base64 文档解析，继续复用双引擎生成逻辑。不要用全文正则抓取链接，会截断 IPv6、ALPN 和节点名称，也会误抓 HTML/注释。只解析明确的节点列表或 `proxies` 字段。

失败时使用安全的分类消息，并汇总进最终异常；仅在 console.warn 中记录原因会被桌面失败路径丢弃。不得转发 YAML 异常片段、HTTP statusText 或网络原始异常中的私有地址。128 项测试通过，官方 sing-box 1.14.4 和 Mihomo 1.19.33 已接受五组生成配置。真实用户订阅及服务端连通尚未验收。

以下为 `1.6.1` 阶段记录，涉及测试数量和状态时以主开发文档及当前运行结果为准。

`1.6.3` arm64/x64 DMG 已完成打包资源、架构、ad hoc 签名、macOS 最低版本声明及镜像完整性检查。两个打包版本均用 Base64 Clash 夹具完成隔离配置同步，检查了实际生成的 WS path/Host。GitHub Actions 的 `1.6.2` 任务在执行前因账号计费锁定失败，无需修改 runner 标签；发布使用本地验证产物。`v1.6.2` 为先前已推送标签，最终修正以 `v1.6.3` 为准。

用途：让新的开发 Agent 基于当前源码继续完成双引擎桌面应用的发布前验收。所有结论必须重新从源码、测试和实际运行结果确认，不能引用旧对话作为最终证据。

完成状态：五张双引擎截图、启动恢复、四步配置向导、最小窗口布局和双架构打包验收已完成。后续 Agent 应将本文作为验收记录，以 `docs/dual-engine-mihomo-development.zh-CN.md` 的未完成项和优先级继续开发。

完成证据：

1. `npm test` 通过，共 117 项，0 项失败。
2. `npm run build:desktop` 和 `git diff --check` 通过。
3. `docs/images/dual-engine-onboarding.png`、`dual-engine-external-1180x780.png`、`dual-engine-mihomo-980x680.png`、`dual-engine-narrow.png` 和 `dual-engine-preview.png` 已生成。
4. Electron 最小宽度已从 `980` 调整为 `720`，并用原生 `740x720` 窗口验收。
5. 验收用临时 HOME、user-data-dir 和调试进程已清理。
6. 启动读取增加 12 秒超时、独立兜底脚本和重新读取入口；顶部“预览更新”“立即同步”的文字与图标中心偏差均为 `0`。
7. `1.6.1` arm64 与 x64 DMG 均通过资源、架构、ad hoc 签名、最低 macOS 12.0、DMG 完整性和打包后定时同步入口检查。
8. 四步向导已用隔离 HOME 执行完整首次同步，并在 `720x680` 视口通过溢出和底部按钮检查。

## 1. 开始前必读

按顺序完整阅读：

1. 根目录 `AGENTS.md`
2. `docs/dual-engine-mihomo-development.zh-CN.md`
3. 本任务书

先确认工作区：

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short
```

当前分支为 `master`。工作区有大量未提交成果，全部需要保留。禁止回退、覆盖或整理与本任务无关的改动。

## 2. 当前已完成

截至本任务书写入时，以下内容已经实现并通过自动测试：

1. External 与 Mihomo 双引擎分发。
2. Mihomo 配置生成、校验、LaunchAgent、诊断、安装、更新和回退。
3. Surge Mihomo SOCKS5 节点、进程直连规则和策略组接入。
4. `runtimeModeConfirmed` 首次引擎确认状态。
5. 旧配置缺少确认字段时保持未确认。
6. 未确认时阻止预览、同步、重建、恢复、清理和启用定时任务。
7. 后台定时同步复用相同确认检查。
8. External 首次确认。
9. Mihomo 校验和同步成功后再保存确认状态。
10. 引擎切换保存失败时恢复应用配置、Surge 文件和 Mihomo 服务状态。
11. Mihomo 清理只删除项目托管配置，并支持注入停止服务动作进行隔离测试。
12. Mihomo `autoStart=false`、自定义进程名、清理边界和切换回滚测试。
13. 首次引擎选择界面、官方安装、Homebrew 和选择已有文件入口。
14. External 与 Mihomo 设置说明、按压反馈、reduced motion、长路径和窄窗口样式。
15. 首次运行使用无默认预选的前置后端选择层，900px 以下使用 76px 图标侧栏。
16. 订阅部分失败时继续处理其他来源，同时保持节点去重和敏感 URL 脱敏。
17. 四步向导覆盖内核安装、带名称订阅、直接节点、Surge 设置、推荐值、汇总和首次同步。
18. 已配置用户可从设置页重新打开同一向导，已保存值回填且可安全取消。
19. 首次确认引擎不会在订阅和 Surge 路径尚未保存时提前同步。

当前基线已实际执行：

```text
npm test
117 项通过，0 项失败
```

新的 Agent 必须重新运行，最终报告以新一次结果为准。

## 3. 2026-10-24 历史验收目标

完成以下发布前收尾：

1. 实际启动 Electron，完成 External、Mihomo、首次引擎选择、窄窗口和预览弹窗验收。
2. 检查控制台错误、横向溢出、元素重叠、按钮文字溢出、图标垂直对齐和禁用状态。
3. 生成脱敏截图并保存到 `docs/images/`。
4. 修复验收中发现的真实界面问题，保持现有克制配色和布局语言。
5. 更新主开发文档中的截图结果、测试结果和未验证范围。
6. 清理本轮临时目录和项目 Electron 进程。
7. 完成最终构建、差异检查和敏感信息扫描。

## 4. 2026-10-24 历史验收边界

本节记录当时截图任务的权限边界，不代表后续任务的发布授权。

1. 不修改真实 Surge 配置、真实订阅、真实 VLESS 节点和真实 LaunchAgent。
2. Electron 验收只使用临时 HOME、临时 Electron user-data-dir、占位配置和占位路径。
3. 不读取或输出私有订阅 URL、VLESS UUID、token、Controller secret 和用户真实配置。
4. 不修改 `backup/` 和 `release/` 中已有内容。
5. 不提交，不推送，不创建 Release。
6. 不执行真实 Mihomo 引擎切换、服务安装、服务停止或定时任务安装。
7. Mihomo 界面截图可在渲染进程内临时修改内存状态后调用现有渲染函数。
8. 预览截图可注入占位 `previewPlan` 后调用现有预览函数。
9. 手工编辑使用 `apply_patch`。
10. 使用 Node.js、npm 和 tsc，不引入 Bun 工作流。
11. 不覆盖现有 `docs/images/surge-vless-bridge-desktop.png`。

## 5. 启动前处理

当前可能存在上一次验收留下的项目 Electron 进程，远程调试端口为 `9333`。启动新实例前，先通过完整命令行确认进程属于本仓库，再终止精确 PID。禁止使用宽泛的 `pkill Electron`。

新实例必须同时隔离：

1. `HOME`
2. Electron `--user-data-dir`
3. 应用配置目录
4. Surge 占位配置

临时配置初始值：

```json
{
  "runtimeMode": "external",
  "runtimeModeConfirmed": false
}
```

Surge 占位配置只需要满足界面读取，不执行同步：

```ini
[Proxy]

[Proxy Group]

[Rule]
FINAL,DIRECT
```

## 6. Electron 验收矩阵

保存以下截图：

| 文件 | 窗口尺寸 | 内容 |
| --- | --- | --- |
| `dual-engine-onboarding.png` | `1180x780` | 首次引擎选择区 |
| `dual-engine-external-1180x780.png` | `1180x780` | External 主要页面和共享设置 |
| `dual-engine-mihomo-980x680.png` | `980x680` | Mihomo 页面、依赖状态和服务区域 |
| `dual-engine-narrow.png` | 小于或等于 `760x720` | 导航、按钮、长路径和表单换行 |
| `dual-engine-preview.png` | `980x680` | 预览弹窗、表格和底部按钮 |

每个尺寸检查：

1. `document.documentElement.scrollWidth <= document.documentElement.clientWidth`
2. 可见按钮文字没有被裁切。
3. 图标与文字垂直对齐。
4. 首次未确认时写入型操作保持禁用。
5. 导航和设置仍可访问。
6. 长路径可换行或截断，不能撑破容器。
7. 预览弹窗底部按钮完整可见。
8. 工作流和定时任务图标没有错位。
9. 控制台没有未处理异常。
10. 页面没有白板、遮挡和卡片嵌套。
11. 定时任务在宽窗口使用 160px 固定的“执行方式”列，间隔或时间控件占用剩余空间；820px 以下改为单列。
12. 初始状态读取成功后加载遮罩必须隐藏；读取超时后转圈必须停止，并显示可操作的“重新读取”按钮。
13. 顶部“预览更新”“立即同步”的文字和图标相对按钮垂直中心偏差均为 `0`。

若使用 CDP，先读取实际 target，再连接对应页面。不得把临时路径、占位凭据或截图内容写入正式配置。

## 7. 允许的界面修复范围

只修复验收发现的问题：

1. CSS 尺寸、间距、换行、溢出和响应式布局。
2. 图标选择、尺寸和对齐。
3. 按钮禁用、busy 状态和提示文字。
4. 首次引擎选择区、依赖安装区域和预览弹窗的可用性。
5. 对应的最小渲染层测试。

保持：

1. 当前中性灰、蓝灰和状态色体系。
2. 8 像素以内圆角。
3. 4、8、12、16、24 像素间距层级。
4. `prefers-reduced-motion` 行为。
5. 现有 IPC 和业务边界。

## 8. 验证命令

界面修复完成后依次执行：

```bash
npm test
npm run build:desktop
git diff --check
```

`desktop:package` 固定输出到 `release/`，本轮禁止直接运行。需要检查打包时，显式给 Electron Builder 指定临时输出目录，不能覆盖现有成品。

本轮不把以下配置事实写成实机结论：

1. macOS 12 兼容。
2. Intel `x86_64` 成品可运行。
3. Apple Silicon `arm64` 成品可运行。
4. 真实 VLESS 节点可用。
5. 真实 Surge HTTP API 重载成功。
6. 真实 Mihomo LaunchAgent 安装和后台运行成功。

## 9. 文档收尾

更新 `docs/dual-engine-mihomo-development.zh-CN.md`：

1. 最终测试总数和结果。
2. `runtimeModeConfirmed` 行为。
3. Electron 截图文件、窗口尺寸和检查结果。
4. 实际修复的界面问题。
5. 临时环境和进程清理结果。
6. 未执行的 macOS 12、x64、arm64 和真实节点验证。

## 10. 敏感信息扫描

至少扫描：

```bash
rg -n '/Users/|Bearer |PRIVATE KEY|controllerSecret|subscriptionUrl|vless://' docs desktop src test README.md README.zh-CN.md
```

允许字段名、类型名、占位值和通用路径说明。发现真实用户名、token、UUID、订阅参数或节点链接时必须移除。

## 11. 完成判定

以下条件全部满足后才可报告完成：

1. 五张脱敏截图已生成。
2. Electron 实际页面通过尺寸和溢出检查。
3. 控制台没有未处理异常。
4. `npm test` 全部通过。
5. `npm run build:desktop` 通过。
6. `git diff --check` 通过。
7. 临时目录和项目 Electron 进程已清理。
8. 主开发文档已经更新。
9. 敏感信息扫描完成并人工确认命中项。

最终报告列出：

1. 修改文件。
2. 界面检查与修复结果。
3. 截图路径和尺寸。
4. 测试和构建结果。
5. 未验证范围。
6. 临时清理结果。
7. 敏感信息扫描结果。
8. 最终 `git status --short`。
