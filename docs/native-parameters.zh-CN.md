# Surge 原生转换参数

文档核对日期：2026-11-18。适用于 Surge 原生运行方式。
External 与 Mihomo 继续使用各自的 VLESS 转换边界。
未安装 Surge CLI 时，预览会说明未执行原生语法校验。
语法通过只证明配置可加载，真实连接仍取决于服务端和网络。

## TLS 和 AnyTLS

| 输入或设置 | Surge 参数 | 说明 |
| --- | --- | --- |
| `sni`、`servername` | `sni` | 名称不包含协议、路径或正则转义 |
| `name-cert-verify`、`vcn` | `server-cert-verify-name` | Mac 6.8.0+，独立于发送的 SNI |
| `skip-cert-verify`、`insecure`、`allowInsecure` | `skip-cert-verify` | 保留来源选择，不自动关闭校验 |
| Clash `fingerprint`、URI `pcs`/`pinSHA256` | `server-cert-fingerprint-sha256` | 证书 SHA-256，64 位十六进制；接受冒号分隔输入 |
| `alpn` | `alpn` | 多项自动加引号，Mac 6.7.0+ |
| `client-cert` | `client-cert` | 引用现有 `[Keystore]` 项，不导入证书或私钥 |
| `client-fingerprint`、`fp` | 不生成对应参数 | 显示兼容提示；Surge 使用自身 ClientHello |
| AnyTLS `reuse` | `reuse` | 默认开启，允许显式关闭 |

AnyTLS 从 Mac 6.4.3 起支持 v2。协议自带 TLS 和 UDP over TCP。
桌面设置的「AnyTLS TLS 与连接」提供 SNI、证书校验名称和复用三项覆盖。
每项独立跟随来源；按服务器和端口匹配。
清空两个名称并恢复复用为「跟随订阅」，删除该端点覆盖。
旧版仅含 SNI 的配置继续有效。
若来源启用跳过证书校验，填写校验名称不会自动重启校验。

## Hysteria2

支持密码、SNI、ALPN、证书设置、下载带宽、Salamander 和 Gecko 混淆。
`ports` 和 `mport` 均映射为 `port-hopping`。
两项同时出现时必须表示相同范围；冲突会拒绝转换。
`hop-interval` 映射为 `port-hopping-interval`。
使用端口跳跃时，Surge 忽略声明中的主端口。
端口跳跃不能与 `underlying-proxy` 同时使用。
`fingerprint` 是服务器证书摘要，不能填写 Reality 公钥或浏览器名称。

## VLESS

要求 Surge Mac 6.12.0+。
保留 RAW、WebSocket、HTTPUpgrade、gRPC、XHTTP、TLS、Reality、Vision 和 Encryption。
用户 ID 接受标准 UUID 或 1～30 字节的字符串。
Reality 使用 Chrome ClientHello，`client-fingerprint: ios` 不会生成 iOS 指纹。
公钥和证书指纹分开转换；Reality 不使用普通证书固定参数。
gRPC 保留 service name、authority 和 multi 模式。
链接未指定 ALPN 时，gRPC 默认 h2，XHTTP 保留自动协商。
来源显式设置的 ALPN 始终保留。

### XHTTP extra

将官方客户端字段映射为对应 `xhttp-*` 参数：

- 填充：`xPaddingBytes`、`xPaddingObfsMode`、`xPaddingKey`、`xPaddingHeader`、`xPaddingPlacement`、`xPaddingMethod`。
- 上传与标识：`uplinkHTTPMethod`、`sessionIDPlacement`、`sessionIDKey`、`sessionIDTable`、`sessionIDLength`、`seqPlacement`、`seqKey`、`uplinkDataPlacement`、`uplinkDataKey`、`uplinkChunkSize`、`noGRPCHeader`。
- 上传限制：`scMaxEachPostBytes`、`scMinPostsIntervalMs`，保留毫秒单位。
- 请求头：`headers`，Host 使用顶层 `host`。
- 复用：`xmux.maxConcurrency`、`maxConnections`、`cMaxReuseTimes`、`hMaxRequestTimes`、`hMaxReusableSecs`、`hKeepAlivePeriod`。

官方说明 `maxConnections` 和 `hKeepAlivePeriod` 接受输入但不影响 Surge 的连接分配或保活。
实际 Surge 6.12.0 校验要求 `maxConnections` 与 `maxConcurrency` 二选一。
指定 `sessionIDTable` 时，`sessionIDLength` 至少为 1。
GET 上传、请求头上传和 Cookie 上传要求 `packet-up`。
独立 `downloadSettings`、未知字段和未映射的服务端字段均拒绝转换。
当前选择显式拒绝，避免未来字段被静默丢弃。

## 每节点通用参数

原生链接与 Clash 节点接受 Surge 参数原名：

`interface`、`allow-other-interface`、`dns-follow-interface`、
`no-error-alert`、`ip-version`、`tfo`、`tos`、`ecn`、
`block-quic`、`test-url`、`test-timeout`、`test-udp`、
`underlying-proxy`。

每节点显式 `ip-version` 和 `tfo` 优先于软件默认值。
无显式选择时继续使用既有 IPv4 优先策略和软件 TFO 开关。
ECN 对普通 TCP 协议无效；不默认对 AnyTLS 开启。
`block-quic=adaptive` 要求 Mac 6.11.0+。
Mac 6.12.0 的 `dns-follow-interface` 同样适用于加密 DNS。
iOS 专用的 `hybrid` 未加入 macOS 转换。
Clash 的规则、全局 DNS 和本地监听端口不导入。

## 升级检查

新增参数需要同时更新映射、格式校验、回归和此文档。
先用合成节点运行 `npm test`，再运行真实 Electron 界面检查。
有 Surge 时，测试通过官方 CLI 校验隔离档案。
更新软件不能自动使旧版 Surge 支持新参数。
未来文档新增字段仍需审查，转换器不会盲目透传所有字段。

## 官方依据

- [AnyTLS](https://manual.nssurge.com/policies/anytls.html)
- [TLS 参数](https://manual.nssurge.com/policies/tls.html)
- [通用策略参数](https://manual.nssurge.com/policies/parameters.html)
- [Hysteria2](https://manual.nssurge.com/policies/hysteria2.html)
- [VLESS](https://manual.nssurge.com/policies/vless.html)
