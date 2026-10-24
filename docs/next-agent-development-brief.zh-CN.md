# Surge VLESS Bridge 新 Agent 交接任务书

更新时间：2026-10-24

适用版本：`1.6.0` 未提交开发工作区

用途：让新的开发 Agent 基于当前源码继续完成双引擎桌面应用的发布前验收。所有结论必须重新从源码、测试和实际运行结果确认，不能引用旧对话作为最终证据。

完成状态：本任务书中的五张截图、CDP 布局检查、窄窗修复、文档收尾和最终验证已于 2026-10-24 完成。后续 Agent 应将本文作为验收记录，以 `docs/dual-engine-mihomo-development.zh-CN.md` 的未完成项和优先级继续开发，不再重复本轮截图任务。

完成证据：

1. `npm test` 通过，共 115 项，0 项失败。
2. `npm run build:desktop` 和 `git diff --check` 通过。
3. `docs/images/dual-engine-onboarding.png`、`dual-engine-external-1180x780.png`、`dual-engine-mihomo-980x680.png`、`dual-engine-narrow.png` 和 `dual-engine-preview.png` 已生成。
4. Electron 最小宽度已从 `980` 调整为 `720`，并用原生 `740x720` 窗口验收。
5. 验收用临时 HOME、user-data-dir 和调试进程已清理。
6. 启动读取增加 12 秒超时、独立兜底脚本和重新读取入口；顶部“预览更新”“立即同步”的文字与图标中心偏差均为 `0`。
7. 修复后 arm64 与 x64 DMG 位于 `release/1.6.0-startup-fix/`，旧成品未覆盖；两个架构均通过资源、签名和最低 macOS 12.0 检查。

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
15. 订阅部分失败时继续处理其他来源，同时保持节点去重和敏感 URL 脱敏。

当前基线已实际执行：

```text
npm test
115 项通过，0 项失败
```

新的 Agent 必须重新运行，最终报告以新一次结果为准。

## 3. 本轮目标

完成以下发布前收尾：

1. 实际启动 Electron，完成 External、Mihomo、首次引擎选择、窄窗口和预览弹窗验收。
2. 检查控制台错误、横向溢出、元素重叠、按钮文字溢出、图标垂直对齐和禁用状态。
3. 生成脱敏截图并保存到 `docs/images/`。
4. 修复验收中发现的真实界面问题，保持现有克制配色和布局语言。
5. 更新主开发文档中的截图结果、测试结果和未验证范围。
6. 清理本轮临时目录和项目 Electron 进程。
7. 完成最终构建、差异检查和敏感信息扫描。

## 4. 严格边界

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
