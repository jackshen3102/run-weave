# App 后端连接管理实施计划 Review

评审目标：`docs/plans/2026-06-17-app-backend-connection-management.md`

评审范围：只读评审计划与当前 App / frontend / backend 相关代码事实；未修改被评审源码、配置、测试或产品文档。

评审强度：强力模式。该计划涉及 App 本地存储、认证 session 隔离、路由、HTTP 请求、terminal-events WebSocket 和 Terminal detail 行为，属于跨模块与认证/运行时行为变更。

## 架构 / 策略发现

### P1 - URL 编辑后保留 session 会把旧后端 token 发送到新后端

当前决策：计划要求更新连接 URL 时保留该连接 session，等下次 verify/refresh 失败后再按 auth-expired 清理。

为什么这是系统层面风险：URL 是后端身份边界。把同一个 `connectionId` 的 accessToken / refreshToken 继续绑定到编辑后的 URL，会在用户把连接改到另一个 host、拼错 host、或被诱导填入恶意 URL 时，把旧后端 token 主动发给新后端。当前 App auth service 会把 refreshToken 放在 `/api/auth/refresh` body，并把 accessToken 作为 `Authorization` 发给传入的 `apiBase`；因此这个风险不是 UI 层误会，而是凭据外泄路径。

证据：

- 计划明确保留 session：`docs/plans/2026-06-17-app-backend-connection-management.md:88` 到 `docs/plans/2026-06-17-app-backend-connection-management.md:89`。
- App refresh 会把 `refreshToken` 发给当前 `apiBase`：`app/src/services/auth.ts:54` 到 `app/src/services/auth.ts:68`。
- App verify / logout 会把 `Authorization: Bearer ...` 发给当前 `apiBase`：`app/src/services/auth.ts:71` 到 `app/src/services/auth.ts:92`。
- 当前 `useAppSession` 的 verify/load/login 都以当前 `apiBase` 执行：`app/src/hooks/use-app-session.ts:219` 到 `app/src/hooks/use-app-session.ts:225`、`app/src/hooks/use-app-session.ts:267` 到 `app/src/hooks/use-app-session.ts:279`。

更好的候选方案：

- 推荐：把 URL origin 变化视为后端身份变化。编辑 URL 时如果 normalized origin 变化，清理该 connectionId 的 auth session，或直接生成新的 connectionId 并要求重新登录；只有同 origin 的纯格式修正才允许保留 session。
- 可接受：禁止原地修改 URL，改为“复制连接 / 新建连接”，旧连接和旧 session 保留，用户显式删除旧连接。
- 不推荐：继续保留 token 到新 URL，并依赖 verify/refresh 失败后清理。这是在清理前先泄露凭据。

迁移/过渡风险：严格清理会让用户修正 host typo 后需要重新登录；可以通过同 origin 豁免、编辑确认文案和旧连接保留来降低摩擦。

修复方向：计划增加“连接身份边界”规则：URL origin 改变必须清理或迁移到新 connectionId；健康检测不得携带 auth；verify/refresh 只允许对已经确认属于同一连接身份的 URL 发送 token。

### P1 - 连接切换缺少事务边界，旧连接的异步结果可能写入新连接状态

当前决策：计划将 `useAppSession` 改为 active connection 驱动，active connection 变化时清空 overview/error/loading 并重新 verify、重连 terminal-events。

为什么这是系统层面风险：多后端切换不是单纯替换 `apiBase`。当前 App 已有多个异步源会在请求完成后直接写全局 App 状态：overview、deviceConnection、auth reset、terminal-events cursor。计划只写“清空并重新请求”，没有要求请求 generation、AbortController、connectionId 捕获校验或 auth clear 的 connectionId 参数。快速 A->B 切换时，A 的慢响应、A 的 401、A 的 health probe 或 A 的 terminal-events 重连结果可能晚到并覆盖 B 状态；最坏情况下会清掉 B 的 session 或让 B 的 terminal-events 从 A 的 cursor 之后开始，漏掉 B 的事件。

证据：

- 计划只描述重建和重新 verify，没有定义 stale result 丢弃规则：`docs/plans/2026-06-17-app-backend-connection-management.md:123` 到 `docs/plans/2026-06-17-app-backend-connection-management.md:127`。
- `loadOverview` 请求完成后直接 `setOverview` / `setLoading(false)`，没有 request id 或 captured `apiBase` 检查：`app/src/hooks/use-app-session.ts:154` 到 `app/src/hooks/use-app-session.ts:196`。
- 认证 verify 失败后会调用当前闭包里的 refresh/reset 路径，计划未要求按请求发起时的 connectionId 清理：`app/src/hooks/use-app-session.ts:209` 到 `app/src/hooks/use-app-session.ts:254`。
- device health probe 完成后直接写 `deviceConnection`：`app/src/hooks/use-app-device-connection.ts:130` 到 `app/src/hooks/use-app-device-connection.ts:181`。
- terminal-events hook 在 effect 里重置了 `seenEventIdsRef` 和 `lastConnectionCursorRef`，但没有重置 `cursorRef`；连接新后端时仍可能用旧后端 cursor 作为 `after`：`app/src/hooks/use-app-terminal-events-connection.ts:99` 到 `app/src/hooks/use-app-terminal-events-connection.ts:101`、`app/src/hooks/use-app-terminal-events-connection.ts:137` 到 `app/src/hooks/use-app-terminal-events-connection.ts:140`、`app/src/hooks/use-app-terminal-events-connection.ts:187` 到 `app/src/hooks/use-app-terminal-events-connection.ts:193`。

更好的候选方案：

- 推荐：引入 connection scope / generation。所有 HTTP、health、verify、refresh、terminal-events 回调都捕获 `{ connectionId, apiBase, generation }`；写状态、清 session、mark online/offline 前必须确认仍是当前 generation。auth store 的 clear/read/write 都以 connectionId 为参数。
- 可接受：在 `AppRoutes` 或 `AppContent` 下创建 `key={activeConnectionId}` 的连接级子树，让大部分 hook 在切换时完整 remount；同时对不可取消请求加 stale guard，对 terminal-events cursor 按 connectionId 存储或重置。
- 不推荐：只在切换时 `setOverview(null)` 并依赖 React effect cleanup。这不能覆盖已经发出的 fetch、health probe 和 auth-expired 回调。

迁移/过渡风险：connection scope 会触动 `useAppSession` 接口和多个 hook 入参，但这是局部 App 层改造；比事后修复随机串状态更可控。

修复方向：计划增加“连接切换原子性”实施步骤和验收：快速切换 A/B、A 的慢 overview 晚到、A 的 401 晚到、A 的 health 晚到、A/B terminal-events cursor 不互相影响；所有 auth 清理必须只作用于请求发起时的 connectionId。

### P2 - 多后端 refresh token 继续放在 localStorage，安全和生命周期边界不足

当前决策：计划把连接列表放在 `runweave-app-connections`，把按连接认证 session 放在 `runweave-app-auth-sessions`，并兼容读取旧 `runweave-app-auth-session`。

为什么这是系统层面风险：计划会从“一个 refresh token”升级为“多个后端的长期 refresh token”。继续放在 WebView localStorage 会扩大凭据暴露面，也缺少原生生命周期、备份、清除和安全存储策略。当前 App 已经用 localStorage 存单 session，但这不能自然推导出多后端 token 也应继续存在同一介质里。

证据：

- 计划指定新旧 auth storage key 都是 App 本地存储 key：`docs/plans/2026-06-17-app-backend-connection-management.md:78` 到 `docs/plans/2026-06-17-app-backend-connection-management.md:87`。
- 当前单 session store 直接读写 `window.localStorage`：`app/src/store/use-auth-store.ts:15` 到 `app/src/store/use-auth-store.ts:49`。
- App 依赖已有 Capacitor 运行时，但 package 当前没有认证安全存储适配层：`app/package.json:19` 到 `app/package.json:30`。
- App 架构文档要求移动 App 走正常认证 token 和明确后端地址配置，不应把 WebView origin 当身份边界：`docs/architecture/app-mobile.md:81` 到 `docs/architecture/app-mobile.md:84`。

更好的候选方案：

- 推荐：把存储拆成接口。连接列表和非敏感 UI 状态可继续用 localStorage / Capacitor Preferences；refresh token 用 iOS Keychain / Android Keystore 对应的安全存储插件或原生桥接；浏览器开发环境保留 localStorage fallback。
- 可接受：v1 暂用 localStorage，但计划必须显式标为浏览器/dev fallback，并把 native secure storage 作为上线前阻断项。
- 不推荐：把多个后端 refresh token 永久放入一个 JSON localStorage key，并只靠 support log redaction 控制泄露。

迁移/过渡风险：引入安全存储会增加 native sync 和依赖维护成本；可以先实现 storage adapter，再分平台接入，旧 `runweave-app-auth-session` 只做一次迁移。

修复方向：计划补“认证存储介质”章节，明确 connection config 与 token 的不同安全等级、native/browser adapter、旧 key 迁移和清理策略。

## 代码 / 实现发现

### P2 - terminal-events cursor 必须按连接隔离或重置

为什么这是风险：计划要求切换连接后 terminal-events ticket 打到新 `apiBase`，但当前 hook 的 `cursorRef` 跨 effect 保留。即使 socket 重新连接到 B，`after` 仍可能取 A 的 cursor，导致 B 的 catchup 从错误位置开始。由于事件 id 在不同后端之间不共享全局序列，这会造成漏事件或不可解释的 UI 不刷新。

证据：

- 计划把 terminal-events 列为切换后必须打到新 `apiBase` 的验证项：`docs/plans/2026-06-17-app-backend-connection-management.md:123` 到 `docs/plans/2026-06-17-app-backend-connection-management.md:127`。
- 当前 hook 定义 `cursorRef`，但 effect 切换时只清 `seenEventIdsRef` 和 `lastConnectionCursorRef`：`app/src/hooks/use-app-terminal-events-connection.ts:99` 到 `app/src/hooks/use-app-terminal-events-connection.ts:101`、`app/src/hooks/use-app-terminal-events-connection.ts:137` 到 `app/src/hooks/use-app-terminal-events-connection.ts:140`。
- 建连时优先使用 `cursorRef.current`：`app/src/hooks/use-app-terminal-events-connection.ts:187` 到 `app/src/hooks/use-app-terminal-events-connection.ts:193`。

修复方向：计划明确要求 `cursorRef` 随 connectionId/apiBase 重置，或把 cursor map 改成 `connectionId -> cursor`；验收要覆盖 A 有 cursor 后切 B，B 仍从 B 的 baseline/cursor 正确 catchup。

### P2 - Terminal 页切换只写路由回 Home，未覆盖旧详情页异步副作用

为什么这是风险：计划要求从 `/terminal/old-id` 切到 B 后回 Home/Login，不复用 old id。但当前 Terminal detail 有多个 2s poll、WS ticket、terminal input、interrupt、clipboard upload、voice transcription 等异步路径，均以当前 props 中的 `apiBase/accessToken/terminalSessionId` 发请求。只在 UI 交互里 `history.replace("/home")` 不足以说明所有旧请求、pending input、timer 和 auth-expired 回调都不会在切换过程中继续影响新连接。

证据：

- 计划只要求关闭弹层并 `history.replace("/home")` 或交给路由进 Login：`docs/plans/2026-06-17-app-backend-connection-management.md:135` 到 `docs/plans/2026-06-17-app-backend-connection-management.md:139`。
- Terminal detail 会按 `apiBase/accessToken/terminalSessionId` 轮询 state：`app/src/pages/AppTerminalPage.tsx:174` 到 `app/src/pages/AppTerminalPage.tsx:251`。
- Terminal WS hook 会按同一组参数获取 session、ticket 并重连：`app/src/hooks/use-app-terminal-connection.ts:151` 到 `app/src/hooks/use-app-terminal-connection.ts:200`、`app/src/hooks/use-app-terminal-connection.ts:260` 到 `app/src/hooks/use-app-terminal-connection.ts:288`。
- Terminal 页的 stop/input/upload 等操作也直接使用当前 `apiBase/accessToken/terminalSessionId`：`app/src/pages/AppTerminalPage.tsx:340` 到 `app/src/pages/AppTerminalPage.tsx:444`、`app/src/pages/AppTerminalPage.tsx:445` 到 `app/src/pages/AppTerminalPage.tsx:504`。

修复方向：计划把 Terminal 切换定义为连接 scope teardown：先禁用 Terminal detail 的发送/轮询/WS，清 pending input，关闭 socket/timer，再切 active connection 和 replace 路由；所有 Terminal auth-expired 回调必须携带发起时的 connectionId，不能清理切换后的新连接。

### P3 - support log 增加 connectionName 需要用户输入脱敏规则

为什么这是风险：计划允许 support log 增加 `connectionName`。连接名称是用户输入，可能包含 token、query、账号、内网地址或其他敏感标识。当前 redaction 主要按字段名匹配 `token/password/authorization/cookie/ticket`，以及对完整 URL 字符串移除 query；如果字段名叫 `connectionName`，值里包含敏感片段，不会被当前 key-based redaction 稳定遮盖。

证据：

- 计划允许增加 `connectionId` 和 `connectionName`，并要求不记录 token 或完整敏感 URL query：`docs/plans/2026-06-17-app-backend-connection-management.md:146` 到 `docs/plans/2026-06-17-app-backend-connection-management.md:149`。
- 当前 redaction 按字段 key 匹配敏感词：`app/src/features/support-logs/support-log-redaction.ts:6` 到 `app/src/features/support-logs/support-log-redaction.ts:8`、`app/src/features/support-logs/support-log-redaction.ts:46` 到 `app/src/features/support-logs/support-log-redaction.ts:67`。
- 当前 HTTP support log 已经只记录 `apiBaseHost` 而非完整 URL：`app/src/services/http.ts:79` 到 `app/src/services/http.ts:128`。

修复方向：计划改为默认只记录 `connectionId`、host、route、deviceStatus；如要记录名称，限制为显示用短名并经过长度截断和值级敏感模式脱敏，或在导出时统一对 user-provided fields 做值级 redaction。

## 替代方案对比

推荐方案：App 自己保留移动端 UI，但抽出 App 内部的 connection scope 层。连接 identity、auth store、HTTP/WS generation、deviceConnection 和 terminal-events cursor 全部从同一个 scope 派生；URL origin 改变清 token；native 上用安全存储 adapter 保存 refresh token。交付速度中等，复杂度可控，能直接覆盖本计划最大风险。

更简单方案：v1 不支持编辑连接 URL，只支持新增/删除/选择；每个连接创建后 URL immutable，token 只绑定创建时 origin。交付最快，能删掉 URL 编辑迁移和 token 重放风险，但用户修正地址的体验较差。

平台/工具链方案：使用 Capacitor 原生安全存储能力承载 auth sessions，Web/dev 环境保持 localStorage fallback；浏览器行为验收继续使用仓库规定的 `$playwright-cli`。交付速度略慢，native 依赖和同步成本更高，但比自研 token 加密和手写生命周期管理可靠。

不推荐方案：完全复制桌面端 connection/auth 的 localStorage 模型到 App，并只在 UI 层处理切换。这会把桌面 Electron 的假设带到多后端移动 App，无法解决 token 介质、跨连接异步串写和 URL 身份边界问题。

## 剩余风险 / 测试缺口

- 未运行构建、typecheck 或浏览器验证；本次是静态 review-only。
- 验证计划需要新增快速切换、慢请求晚到、旧连接 401 晚到、terminal-events cursor 隔离、URL origin 编辑清 session、安全存储迁移失败等场景。
- 浏览器/App 行为验证必须继续按仓库要求使用 `$playwright-cli`。

## 检查命令摘要

- 读取评审规则：`sed -n '1,240p' /Users/bytedance/Code/skills-hub/skills/review-only/SKILL.md`
- 读取计划：`sed -n '1,260p' docs/plans/2026-06-17-app-backend-connection-management.md`
- 检查工作树：`git status --short`
- 核对 App auth/session/device/terminal-events/terminal detail 代码：`nl -ba app/src/...`
- 核对 frontend connection/scoped auth、backend auth/CORS、package scripts：`nl -ba frontend/src/... backend/src/... package.json`
