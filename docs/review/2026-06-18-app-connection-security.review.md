# 2026-06-18 App connection security review

## 评审范围

- 当前工作树相对 `origin/main` 的 live diff，含未提交修改和未跟踪文件。
- 重点检查 App 多后端连接、auth session 存储、native Keychain bridge、终端连接状态、支持日志和 backend profile 迁移相关代码。
- 已执行只读验证：`pnpm typecheck`、`pnpm lint`、`git diff --check origin/main`，均通过。

## 架构 / 策略发现

### P1 - Auth session 只绑定 connectionId，但 connection URL 可原地变更

- 当前决策：App 新增本地多连接管理，连接配置存入 `localStorage`，登录态按 `connectionId` 分桶保存；同一个连接允许直接编辑 `url`。
- 为什么这是风险：backend origin 是鉴权边界的一部分。当前实现把 `connectionId` 当作唯一安全边界，但 `updateConnection` 可以在不清 session、不轮换 id、不重新登录的情况下把同一个 id 指向另一个 URL。结果是旧 backend 的 access token / refresh token 可能被后续 `verifySession`、`refreshSession`、`getAppHomeOverview` 发往新 URL，形成跨 backend 凭证泄露和会话混淆。
- 证据：
  - `app/src/store/use-app-connection-store.ts:190`-`209`：编辑连接时可更新 `url`，但没有清理该连接的 auth session，也没有轮换 connection id。
  - `app/src/store/app-auth-credential-store.native.ts:25`-`27`：native Keychain storage key 只由 `connectionId` 组成。
  - `app/src/store/app-auth-credential-store.web.ts:60`-`61`：web fallback 的 session key 同样只由 `connectionId` 组成。
  - `app/src/store/use-auth-store.ts:80`-`82`：保存 session 时只传入 `connectionId`，不校验或记录 canonical origin。
- 更好的候选方案：
  - 推荐：把 canonical origin 纳入 credential identity，例如存储 key 使用 `{connectionId, canonicalOrigin}`，并在 URL 改变时强制清理旧 session、重新登录。
  - 可选：把连接 URL 视为不可变字段；用户编辑 URL 时创建新连接 id，旧连接和旧 session 保留或经确认删除。
  - 平台化候选：复用 Desktop 连接管理的 active connection 语义，但把 App 的 native credential store 定义为 origin-scoped 安全存储，而不是 UI connection-scoped 存储。
- 迁移/过渡风险：已有用户的 session 需要一次性重新登录或做带 origin 校验的迁移；如果只清 session，会增加一次登录成本，但比跨 backend 发送 token 更可控。
- 修复方向：URL 更新路径必须执行“清该连接 session + 清 overview + 触发登录态重载”，或直接轮换 connection id；credential store index 中补充 canonical origin，load 时 origin 不匹配则拒绝返回 session。

## 代码 / 实现发现

### P2 - device health 异步结果没有按当前 apiBase/connection guard，连接切换后可能写回旧状态

- 为什么这是风险：`useAppDeviceConnection` 在 `apiBase` 变化时会重置状态，但已发出的 `getBackendHealth(apiBase)` 没有取消或序列号校验。旧连接的慢 health check 返回后仍会 `setDeviceConnection`，可能把新连接错误标记为 offline/online，进而影响 Home 离线 banner、终端重连、创建终端和 composer 禁用状态。
- 证据：
  - `app/src/hooks/use-app-device-connection.ts:83`-`86`：`apiBase` 变化时只重置本地状态，没有取消旧 probe。
  - `app/src/hooks/use-app-device-connection.ts:143`-`180`：await health 后直接 set online/offline，未比较当前 apiBase 或 connection id。
  - `app/src/hooks/use-app-session.ts:127`-`138`：该状态直接驱动 session/device online 语义。
- 修复方向：为 health probe 增加 epoch/ref 或 AbortController；返回后只有 `apiBaseRef.current === probeApiBase` 且 connection id 未变时才写状态。更稳妥的是把 `connectionId` 传入 `useAppDeviceConnection`，状态快照也带上 connection id。

### P3 - 支持日志默认上下文的 apiBaseHost 与多后端模型不一致

- 为什么这是风险：多后端后，Capacitor/WebView 的 `window.location.host` 不等于实际 backend host。支持日志默认上下文仍把 `window.location.host` 记为 `apiBaseHost`，会让很多非 request 事件在诊断包中显示错误 host，排障时容易误判连接对象。虽然 `requestJson` 的 request 日志会记录真实 `apiBaseHost`，但 auth、terminal poll、support sheet 等事件仍可能缺少真实 backend host。
- 证据：
  - `app/src/features/support-logs/SupportLogProvider.tsx:20`-`25`：`apiBaseHost` 来源是 `window.location.host`。
  - `app/src/features/support-logs/SupportLogProvider.tsx:35`-`41`：默认上下文把该值写入每条日志。
  - `app/src/features/support-logs/support-log-types.ts:56`-`62`：类型上已经把 `apiBaseHost` 定义成诊断语义字段。
- 修复方向：默认上下文不要声明 `apiBaseHost`，或从 `useAppConnectionStore.activeConnection.url` 派生真实 host；对 auth/terminal 事件补充 connection id + canonical host，避免只记录用户可编辑的 connection name。

## 残余风险 / 测试缺口

- 本轮未做浏览器或 iOS 模拟器操作；用户指令要求浏览器验证必须使用 `$playwright-cli`，但本次是只读评审，未进入 UI 复现。
- `pnpm typecheck`、`pnpm lint`、`git diff --check origin/main` 均通过，只能证明类型、lint 和空白检查没有挡住，不能覆盖上述运行时竞态和凭证边界。
- backend profile root 自动迁移从 `~/.browser-profile` 到 `~/.runweave/browser-profile` 属于跨运行时生命周期变更，当前实现能编译，但仍建议在合并前补一份升级/回滚说明和手工验证矩阵。
