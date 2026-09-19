# 终端快照分享实施计划

状态：T1–T4 及活文档已实现，T5 验收部分完成，尚未完成全部必需用例；用户追加批准显式签名 URL，现验收计划扩为 18 条。以下保留原实施与验收清单供收尾核对；实际完成情况、审查修复、真实运行证据和阻塞见[验证记录](../review/2026-09-18-terminal-snapshot-share-validation.md)。粒度：L2 任务拆分，公开访问与有效期按安全关键边界细化。

## 1. 目标与冻结的产品行为

将当前选中 Panel 在创建时仍可读取的历史与当前屏幕，保存为不可变文本快照。人和 Agent 使用同一个 HTML URL 读取；重点是 Agent 能直接获取正文，而不是制作代码查看器。

设计基准：[原型说明](../prototypes/terminal-snapshot-share/README.md)、[快照 HTML](../prototypes/terminal-snapshot-share/snapshot.html)、[选行截图](../prototypes/terminal-snapshot-share/snapshot.png)。以极简版为准，不恢复已放弃的复杂分享页。

### 创建端

- 现有终端顶部 `…`，在 `Copy terminal output…` 附近增加「分享终端快照」。
- 点击即创建并复制链接，无预览、无确认页。创建期间防止重复提交；成功后提示已复制、24 小时后失效，并可打开快照。
- 捕获点击时的 Backend、Session、Panel，不因请求期间切换连接或分屏而改用新目标。不得分享同 Session 的其他分屏。
- 剪贴板失败不撤销成功创建的快照、不重新创建；保留可打开或手动复制的链接。不能错误显示“已复制”。
- 无可用显式 Panel 时禁用入口；后端拒绝无效或已消失的目标，不静默回退。

### 读取端

- 标题只在 `<title>`；`body` 只有正文与轻量行号。没有品牌栏、可见标题、创建时间、到期时间、搜索框、复制按钮、状态栏或嵌套编辑器。
- 全部正文及行号在首次 HTML 响应内；不依赖 React、客户端取数、Monaco、xterm 或另外的 raw-text API。
- 搜索、拖选、复制文本、复制地址使用浏览器原生能力。
- 点击行号选单行，Shift 点击选连续行；淡色背景高亮，同时更新 `#L25-L28`。重新打开恢复高亮与定位。文本拖选不自动修改地址。
- 视觉换行不改变逻辑行号；行范围只用于定位，完整正文始终可读。
- 无效或越界 hash 不报弹窗、不裁剪内容，忽略高亮；清空 hash 清空高亮。保留 Ctrl/Cmd 点击链接的浏览器行为。

### 生命周期与边界

- 有效期固定为创建成功起 24 小时，不滑动续期、不配置期限、不支持提前撤销。
- 链接持有者无需 Backend 登录或 tunnel 凭据，即可读取这一份快照；没有任何终端控制权限。
- 快照由当前 Backend 保存。Backend 离线时不可读取；同一存储目录恢复服务后，未到期链接继续可读。
- 源终端继续输出、清屏、改名或关闭不改变已创建快照，也不提前删除它。
- 只包含捕获时尚被 tmux 保留的内容；不能恢复已清理的历史、之前每一帧 TUI 或原生 Agent Session。
- 到期禁止新请求取得内容，但无法收回接收者已经下载、复制或停留在页面中的内容。

### 非目标

不做跨 Backend 托管、外网穿透、实时分享、Agent Session 迁移、自动脱敏、分享管理列表、批量分享、全分屏合并、CLI 新命令、原生 iOS 新入口。不同 Agent 可通过现有认证 HTTP 能力创建，但不为此增加另一套接口。

## 2. 当前代码事实与差异

| 当前事实                                                                                                                                          | 实施含义                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `frontend/src/components/terminal/workspace/header.tsx` 的 `openHistoryDrawer` 优先取 `activePanelIdBySessionId`，再取 Session 的 `activePanelId` | 分享入口复用目标选择语义，但请求必须带显式 `panelId`；不能仅传 Session。                                       |
| `backend/src/routes/terminal/panels/index.ts` 的 Panel history 路由调用 `resolvePanelTarget` 后捕获指定 pane                                      | 复用领域层目标解析，不从新服务反向导入 route。                                                                 |
| `backend/src/terminal/application/panel-targets.ts` 对显式 ID 只匹配所属 Session；不存在时报错                                                    | 是新能力的准确目标边界。无 ID 时的默认/活跃分屏选择不可用于创建接口。                                          |
| `backend/src/routes/terminal/index.ts` 的旧 history 存在默认 Panel 与持久化 scrollback 回退                                                       | 新分享路径不能直接调用它，以免失去分屏准确性。旧行为不改。                                                     |
| `backend/src/terminal/tmux/pane-service.ts` 的 `capturePane` 使用 `-p -J -S -5000`，未启用 ANSI 输出；`process.ts` 子进程输出上限 10 MiB          | 能取可读文本，但新增快照捕获入口应读取全部仍保留历史，不能把默认 5000 当作不限量承诺。超限失败，不能假装完整。 |
| `backend/src/index.ts` 的 `/api` 受 `requireTunnelAuth` 保护，`/api/terminal` 另受 `requireAuth` 保护；末尾有 SPA fallback                        | 创建走原认证链；公开读路由独立装配并完整消费错误路径，不能落入登录页或 SPA。                                   |
| `backend/src/server/tunnel-auth.ts` 有通用 query token bootstrap                                                                                  | 分享不能携带或兑换 tunnel token；公开读应在该 bootstrap 前处理。                                               |
| `backend/src/utils/path.ts`、`bootstrap/runtime-services.ts` 已统一存储路径和资源回收                                                             | 新增独立快照目录与服务生命周期，不混进会话或 scrollback store。                                                |
| `frontend/src/App.tsx`：Electron 用当前 Connection URL，Web 用 `VITE_API_BASE_URL` 或同源；Vite 尚无 `/share/terminal` 代理                       | 链接必须基于本次请求的 Backend base 构造，并补开发代理；不能使用 Electron 自定义协议的 location origin。       |

目前未发现终端公开快照的存储、token 或 HTTP 合同；不能把原型静态文件视为已有能力。

## 3. 接口与权限合同（本计划新增）

### 3.1 认证创建

`POST /api/terminal/session/:sessionId/panels/:panelId/shares`

- 沿用现有 Backend bearer 认证和 tunnel 门禁。
- 无业务请求体；不接受正文、标题、文件路径、过期时间或客户端提供的 tmux target。
- 服务端检查 Session 存在、显式 Panel 属于它、真实 tmux pane 可用，然后捕获。
- 成功落盘后返回 `201`：

```ts
interface CreateTerminalSnapshotShareResponse {
  sharePath: string; // /share/terminal/<snapshotId>?expires=<Unix毫秒>&signature=<HMAC签名>
  title: string; // 捕获时冻结的 Session 名称与 Panel 标识
  createdAt: string; // ISO 8601 UTC
  expiresAt: string; // createdAt + 86_400_000ms
  lineCount: number;
}
```

共享 DTO 放入 `packages/shared/src/terminal/snapshot-share.ts`，显式导出 `@runweave/shared/terminal/snapshot-share`。Backend-only 的文件记录和服务类不进入 shared。

错误返回 `{ message, code }`：认证沿用现有 `401/403`；目标不存在 `404`；非 tmux 或目标不可捕获 `409`；捕获服务暂不可用 `503`；超单份大小 `413`；超过创建并发 `429`；快照存储容量满 `507`；其他持久化错误 `500`。错误不回显正文、token、绝对存储路径或完整子进程命令。

### 3.2 公开读取

`GET /share/terminal/:snapshotId?expires=...&signature=...`，允许同语义 `HEAD`，不提供其他 method 或子资源能力。

- snapshotId 使用 UUID v4；HMAC-SHA256 绑定版本、终端快照只读用途、ID 和到期时间。只接受规范 URL，缺失、重复或额外 query 字段均拒绝；旧 opaque-token 链接没有兼容回退。
- 每次请求先验签、检查期限，再查记录并核对 ID 与存储期限完全一致，成功返回 `200 text/html; charset=utf-8`。
- 不接受 Session/Panel 查询参数，不查看实时终端，不根据 query 改正文或期限。
- 未知、到期、已清理记录统一返回 `404` 的极简 HTML，`<title>` 与一句“快照不存在或已过期”；不泄露历史标题或正文。读记录损坏时 fail closed 并记录脱敏错误，不返回局部正文。
- 同一前缀下其他路径返回 `404`，其他方法 `405`；不得交给 SPA fallback。
- 不需要 Backend auth 或 tunnel token；**仅此精确公开路由具有例外**。分享签名不成为通用认证凭证，不用于现有 API、WS ticket 或 WebSocket。
- 不新增匿名列表、token 查询、续期、删除、控制或 raw-text 接口。

### 3.3 链接生成

前端使用创建请求开始时冻结的 `apiBase` 与响应 `sharePath` 构造 HTTP(S) URL：

- Electron：当前连接的 HTTP(S) base；保留已有部署路径前缀，不使用 renderer 的自定义协议 origin。
- Web：非空 API base 先相对于当前页面解析；空 base 使用当前 HTTP(S) origin。
- 去掉 base 中的 userinfo、query、fragment，不能把 bearer token、tunnel token、登录参数拼进链接；规整连接处的斜杠。拒绝非 HTTP(S) base。
- 不从不可信 `Host` / `X-Forwarded-Host` 生成绝对链接。
- Vite 增加 `/share/terminal` 转发至同一 `backendTarget`。自定义反向代理部署也必须转发该前缀；不自动更改第三方网关权限。
- localhost 链接仅适用于能访问该地址的接收者。不自动把本地连接猜成公网地址，不承诺接收者网络可达。

## 4. 捕获、持久化与资源边界

### 4.1 捕获与文本规范

1. 在领域服务中解析显式 Session/Panel；`resolvePanelTarget` 复用已有实现，模式参数不允许改变显式 ID 的结果。
2. 在 `TmuxPaneService` 增加独立的快照捕获方法，使用准确的 `TmuxPaneTarget` 和 `capture-pane -p -J -S - -t <pane>`，表示读取 tmux 当前仍保留的历史；保持旧 `capturePane` 默认行为不变。
3. 不加 `-e`，不读取 socket/pty 原始字节流再简单去 ANSI。保留换行、空行、空格、Unicode；统一 CRLF 为 LF。只去掉 capture 输出协议自身的一个末尾换行，不 `.trim()`，避免丢失正文布局。
4. 以 LF 固定逻辑行；空字符串仍是一个空行。视觉折行不重新计数。标题由现有 Session 展示名称和 Panel alias/ID 构成，限制长度，不附带额外的项目绝对路径。
5. 捕获失败、输出超过 10 MiB、pane 在请求中消失时失败，不改抓默认 pane 或旧的 Session 级 scrollback。非 tmux 会话第一版明确不支持创建；已存在的快照读取不依赖 tmux。
6. 全屏/alternate-screen 能读取的是当时 tmux 可捕获的文本，不承诺之前所有界面帧。验收需用真实 TUI 和覆盖写确认不导出原始控制序列、不混入其他 Panel。

### 4.2 文件记录

新增 `terminalSnapshotShareDir = <browserProfileDir>/terminal-snapshot-shares`，遵守当前 Backend/profile 的存储隔离，不使用全机临时目录。

一份快照一个 JSON 文件，文件名为 snapshotId 的 SHA-256 hex；记录包含：`version: 1`、随机 `snapshotId`、冻结的 `title/text/lineCount`、`createdAt/expiresAt`。文件中不保存签名，也不持续依赖原 Session/Panel。独立随机 32 字节 `.signing-key` 与记录同 profile 持久化、原子发布并 fsync，重启不更换密钥，异常密钥不静默轮换。

- 目录 `0700`，记录与密钥文件 `0600`；ID 和签名严格校验后只用 ID 的 hash 查文件，拒绝路径拼接或目录遍历。
- 先捕获，成功写入临时文件并原子发布后才返回 `201`。创建时刻在落盘提交阶段确定，不能从按钮点击或捕获开始计时；写失败清除半成品且不返回链接。
- 发布后的正文和期限不再改写；读取从磁盘记录校验，不能靠永久内存缓存绕开期限。
- 记录损坏/未来不识别的版本不可读，不自动重建或回退源终端。
- 同 profile 重启保留未到期记录；删除源 Session 不级联删除快照。

### 4.3 有界资源与清理

以下是实现默认保护值，不做新的设置界面：单份捕获最多 10 MiB；快照存储最多 100 MiB 且最多 100 份未过期记录；Backend 同时最多 4 个创建请求，超出直接 `429`，不建立无界队列。

- 统计最终序列化记录大小；创建提交与配额检查串行化，避免并发绕过配额。
- 配额不足先清理到期记录；仍不足返回 `507`，不删除未到期快照，不截断正文。
- 服务初始化与每 60 秒清理到期记录、遗留临时文件；读取时即使清理任务未执行也必须按 `now >= expiresAt` 拒绝。
- `RuntimeServices` 持有服务，资源创建后立即登记 `ResourceScope` 清理。dispose 停止调度、拒绝新创建、等待进行中的捕获/提交/清理后结束；不得把定时任务留在路由模块。
- 不改变 tmux 的全局历史配置和已有终端运行时生命周期。

## 5. HTML 与安全细则

- Backend render 函数生成独立 HTML，完整转义标题、正文和属性。正文中的 `<script>`、`</title>`、`<img onerror>`、OSC8 链接等都只能成为文本，不自动转成可点击资源或执行代码。
- 采用稳定的 `id="L<n>"`，行号是锚点；正文是独立文本节点。不把正文或标题插入 JS 字符串，不用用户文本构建 `innerHTML`。
- CSS 与固定选行 JS 内联；使用固定资源内容的 CSP hash 授权，不允许 `unsafe-inline` 脚本。不取外部字体、图标、分析 SDK 或远程内容。
- 响应至少设置：`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow, noarchive`。
- CSP 至少为 `default-src 'none'`，按 hash 放行固定 style/script，`connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。新页面无任意网络请求能力。
- 不产生快照 ETag/Last-Modified 或内容 `304` 捷径；HEAD 与条件请求也先检查有效期，过期不能从服务端再次取得正文。
- 分享 URL 是 bearer secret：不将原 token、完整 URL 或正文写入 Backend 日志、Activity/diagnostic 记录。日志只记录内部 snapshotId、目标 ID、字节数、结果码、耗时；检查前端错误记录同样脱敏。反向代理日志不属于当前代码可控范围，部署说明提示隐藏签名 query。
- HTML 不可能收回已加载内容；链接转发等价于授权读取，不把行范围当作访问控制，也不声称自动脱敏。

## 6. 任务与文件范围

按顺序实施；每步保留现有工作区无关修改，不写单元测试、不添加 TDD 文件。

### T1：协议、存储与生命周期（代码已完成）

- [ ] 新增 `packages/shared/src/terminal/snapshot-share.ts`，更新 `packages/shared/package.json` 子路径导出，定义创建响应与稳定错误码。
- [ ] 新增 `backend/src/terminal/snapshot-share/store.ts`：记录 schema、原子保存、hash 查找、到期与配额。
- [ ] 新增 `backend/src/terminal/snapshot-share/service.ts`：创建并发、提交时刻、维护任务、dispose。存储/服务不反向依赖 routes。
- [ ] 修改 `backend/src/utils/path.ts`、`backend/src/bootstrap/runtime-services.ts`：目录和资源 owner。

完成判定：类型检查通过，记录可原子写入；已到期/损坏记录不能读出正文；能说明清理和进行中任务的唯一 owner。

### T2：真实 Panel 捕获与认证创建（代码已完成）

- [ ] 修改 `backend/src/terminal/tmux/pane-service.ts`，必要时经 `tmux/service.ts` 暴露新捕获方法；不改变已有 history 行为。
- [ ] 新服务复用 `backend/src/terminal/application/panel-targets.ts` 与 `panel-common.ts`，只解析显式目标。
- [ ] 新增 `backend/src/routes/terminal/snapshot-share.ts`：输入/错误映射；在 `backend/src/index.ts` 独立挂载于现有 `/api/terminal` 认证链，不借公共读取能力绕开认证。

完成判定：两个有不同 marker 的真实 Panel，指定 B 只能得到 B；无效目标和失败捕获不生成链接；响应的期限恰为 24 小时。

### T3：公开 HTML 读取（代码已完成）

- [ ] 新增 `backend/src/terminal/snapshot-share/render.ts`：极简 HTML、转义、固定 CSS/选行 JS 与 CSP hash。
- [ ] 新增 `backend/src/routes/terminal-snapshot-share.ts`：仅公开 GET/HEAD 与完整前缀错误处理。
- [ ] 修改 `backend/src/index.ts`：在 tunnel bootstrap 和 SPA fallback 之前装配公开路由；不用修改 `requireAuth`/`requireTunnelAuth` 的全局规则。
- [ ] 检查全局 request context、日志和 CORS 装配对匿名 GET 的影响，确保不写完整 bearer URL；公开路由不产生 tunnel/auth cookie。

完成判定：无凭据的直接 HTTP 请求和不加载 JS 的浏览器均得到全文；分享签名不能调用受保护控制接口；过期、未知、条件请求均 fail closed。

### T4：终端入口与链接（代码已完成）

- [ ] 新增 `frontend/src/services/terminal/snapshot-share.ts`：认证创建与 URL 拼接；请求参数和 base 固定为点击时的上下文。
- [ ] 修改 `frontend/src/components/terminal/workspace/header.tsx`：菜单项、loading、防重入、成功链接及剪贴板失败反馈。稳定回调使用 `useMemoizedFn`。
- [ ] 修改 `frontend/vite.config.ts`：仅增加 `/share/terminal` 开发代理，沿用 `backendTarget`。
- [ ] 不在 `frontend/src/App.tsx` 注册受登录保护的分享页，不引入新编辑器和自定义搜索。

审查补充已实现：`frontend/src/features/terminal/state/snapshot-share-store.ts` 以仅内存状态持有请求与结果；`frontend/src/components/terminal/workspace/snapshot-share-notification.tsx` 在 `App.tsx` 的连接 keyed providers 外渲染，避免切换 Backend 丢失成功链接。

完成判定：通过真实终端创建到匿名打开的整条链路；连接/Panel 切换期间不串目标；Web 同源和 Electron HTTP 连接的链接指向实际 Backend。

### T5：文档、验收与收尾

- [ ] 新增简短活文档 `docs/cli/terminal-snapshot-share.md`，说明认证创建、匿名 HTML 读取、固定期限、网络与安全边界；从 `docs/README.md` 的相应分类链接，不在多个入口复述合同。
- [ ] 按配套 YAML 执行；记录实际构建、请求、浏览器证据与未执行阻塞，不把原型截图或 schema 通过冒充功能验收。
- [ ] 更新原型 README 的实现状态，不把原型辅助参数带入产品；任务完成后将仍有效的合同迁入活文档并删除本过程计划。

## 7. 验收与验证入口

配套：[终端快照分享验收计划](../testing/terminal/snapshot-share.testplan.yaml)。schema 校验通过，已执行主链与部分定向检查；未完成项以验证记录为准，不把 schema 通过当作行为验收。

实现后静态门禁：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm backend:verify-lifecycle
pnpm docs:check
pnpm testplan:validate docs/testing/terminal/snapshot-share.testplan.yaml
git diff --check
```

运行时验证必须使用隔离 Backend/profile 和真实终端；操作 Dev Session 时先使用 `$toolkit:runweave-dev-session`，浏览器使用 `$toolkit:playwright-cli`，执行 YAML 使用 `$toolkit:run-test-cases`。不得复用用户生产存储制造到期或损坏记录。

到期边界可在隔离 fixture 中对**由真实创建接口生成的记录**调整 `expiresAt` 到过去，然后调用真实公开 GET；正常创建另行断言固定 24 小时。这验证过期判断与清理，不声称经历了 24 小时自然等待。禁止修改机器时钟、生产期限或伪造 HTTP 响应。

总体失败条件：分享错 Panel、需要登录才能读有效分享、JS 未运行时无正文、token 换取控制能力、到期仍返回正文、源会话变化影响快照、错误被 SPA 返回 `200` 隐藏、剪贴板失败却报告成功。任何一项命中都不能交付。

## 8. 兼容、迁移、回滚与风险

- 全部为新增 API、目录、DTO 和菜单项；无旧数据迁移，不更改旧 history/input/WS 合同。非 tmux 目标明确拒绝，不能用不准确的兼容回退掩盖能力边界。
- 同存储目录升级/重启保留 v1 记录。回滚旧 Backend 时分享能力不可用，不删除原 terminal/auth/scrollback 数据；再次升级后已到期记录仍不可读。
- 如需撤回发布，回滚菜单与新路由/服务注册，不全局放宽认证，不删除其他目录；残留快照文件属于敏感数据，按到期维护或明确运维授权清理。
- 最大风险是把持链接读取误接到已有控制权限、错误选 pane、泄漏 token、持久化或缓存绕开过期。其次是极大输出和磁盘配额；必须明确失败，不截断后声称是完整快照。
- 公开 URL 只证明应用侧访问合同；外层网关若仍要求独立登录，需要运维为这一前缀配置访问，不通过把通用 tunnel token 塞进分享 URL 解决。
