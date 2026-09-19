# 终端快照分享

Terminal 顶部 `…` →「分享终端快照」将当前选中的显式 Panel 保存为只读文本，直接创建并复制链接。
成功通知可以打开或手动复制链接；剪贴板失败不会重新创建快照，也不会显示“已复制”。
进行中的创建与结果由页面级临时状态保留，切换 Backend 不会丢失原请求的链接；整页刷新后不保留，也不将 bearer 链接写入浏览器持久化存储。

## HTTP 合同

认证创建（沿用当前 Backend bearer 认证与 tunnel 门禁，无业务请求体）：

```text
POST /api/terminal/session/:sessionId/panels/:panelId/shares
Authorization: Bearer <backend-access-token>
```

成功落盘返回 `201`，字段为 `sharePath`、`title`、`createdAt`、`expiresAt`、`lineCount`。
`sharePath` 为 `/share/terminal/<snapshotId>?expires=<Unix毫秒>&signature=<签名>`，没有主机或登录凭据。
签名使用独立密钥执行 HMAC-SHA256，绑定版本、终端快照只读用途、snapshotId 与 expires；客户端必须原样保留这两个 query 字段。
URL 使用规范格式（expires 在 signature 前），不接受缺失、重复、额外字段或非规范编码。
完整 DTO 与稳定错误码见
[`snapshot-share.ts`](../../packages/shared/src/terminal/snapshot-share.ts)。
错误返回 `{ message, code }`：目标不存在 `404`、不可捕获或非 tmux `409`、捕获不可用 `503`、
超过单份大小 `413`、创建并发满 `429`、存储满 `507`、保存失败 `500`；认证仍使用原有 `401/403`。

持有效签名链接者无需登录、无需 tunnel 凭据即可 `GET` 或 `HEAD` 同一个分享 URL。
这不是无认证读取：每次请求先验签和检查到期时间，再查记录并核对 ID、存储期限与签名期限完全一致；裸 ID、缺签名、篡改或过期均返回 404。
HTML 首次响应包含全部正文与行号，Agent 无需执行 JS 或另调文本接口；没有实时终端控制能力。
其他方法 `405`，未知、无效、过期、损坏记录及前缀下其他路径均 `404`，不返回登录页或 SPA。
分享签名只授权单份快照读取，不能用于 Backend API、WS ticket 或 WebSocket 认证。旧版开发期 opaque-token 链接不再接受，不保留绕过验签的兼容入口。

## 内容与期限

- 仅捕获明确指定 Panel 的 tmux 当前屏幕与仍保留的全部历史。不合并分屏，不回退到默认 Panel 或 Session scrollback。
- 非 tmux Session 不支持创建。已清理历史、过去每一帧全屏 TUI、原生 Agent Session 无法恢复。
- 创建成功起固定 24 小时有效，不滑动续期、不可提前撤销。原终端输出、清屏、改名或删除不改变快照。
- 标题只在浏览器标题栏，正文只有文本和行号。浏览器原生搜索、拖选和复制仍可用。
- 点击行号选单行，Shift 点击选连续行，地址如 `#L25-L28`；刷新恢复高亮与定位。
  无效或越界 hash 忽略高亮，清空 hash 清空高亮。视觉换行不改变逻辑行号，引用范围不隐藏其他正文。
- 分享页不加载外部资源，不自动生成正文中的链接，文本经 HTML 转义；CSP 仅允许固定内联 CSS/选行 JS。
  响应 `no-store`，没有 ETag/Last-Modified/304 读取捷径，HEAD 也检查有效期。

## 网络与安全边界

快照保存在创建时的 Backend，不是跨节点托管。该 Backend 离线时不能读取；同 profile 重启后未到期链接继续有效。
存储目录为 `<browserProfileDir>/terminal-snapshot-shares`，目录 `0700`、文件 `0600`，记录以 snapshotId 的 SHA-256 命名，不保存签名。
独立 32 字节随机密钥保存为该目录的 `.signing-key`（`0600`），原子发布并同步文件与目录；同 profile 重启复用，不依赖登录或 tunnel 密钥。
备份、迁移需同时保留密钥与记录；丢失或更换密钥会使旧链接失效，损坏密钥会阻止初始化而非静默轮换。

单份捕获最多 10 MiB；最多 100 份记录、合计 100 MiB（按序列化记录大小计），最多 4 个并发创建。
超限明确失败，不截断文本，不删除有效快照腾空间。初始化及每 60 秒清理过期记录和遗留临时文件；
读取不依赖清理及时性，达到期限即拒绝。损坏记录不可读，仍计入存储占用。

前端基于点击时冻结的 HTTP(S) Backend base 构造链接，保留部署路径前缀，移除 userinfo、query 和 fragment；
不使用 Electron renderer 的自定义协议 origin，不把 bearer/tunnel token 拼入链接。
桌面内置本机连接使用运行状态桥接提供的首选局域网 IP 替换链接主机，保留端口、路径前缀和签名；
创建请求仍发往原连接，不向局域网地址额外发送登录凭据。远程 IP/域名连接保持原地址。
没有可用局域网地址、桥接不支持，或本机连接并非该内置 Backend 时，创建前提示使用目标 Backend 的局域网 IP 连接，不复制无效的 loopback 链接。
Vite 已代理 `/share/terminal`；自定义反向代理也必须转发这一前缀，外层网关如有登录门禁，需由运维仅为此读取前缀配置例外。
不能靠在分享 URL 加通用 tunnel token 解决访问问题。

- 局域网 IP 仅适用于能访问该网络且被防火墙放行的接收者；不会自动变成公网地址，不保证外部网络可达。网络切换或 IP 变化后应重新获取链接。
- 完整签名 URL 本身是读取授权。转发链接等价于转授权，签名不是一次性凭据；不要写入日志、Activity 或诊断记录。
  建议通过 HTTPS 分享；反向代理/access log 应隐藏签名 query，应用无法替第三方网关完成脱敏。
- 不自动脱敏终端正文，请仅在愿意向持链接者公开内容时分享。
- 到期只禁止新请求取得内容，无法收回已经下载、复制或仍打开的页面内容。

## 验证入口

[终端快照分享验收计划](../testing/terminal/snapshot-share.testplan.yaml)覆盖真实 Panel 捕获、匿名读取、期限、
持久化、安全、剪贴板失败与连接切换。原型截图或类型检查不代替真实链路验收。
