# App 设备在线能力实施计划

## 目标

在 Runweave App 中明确展示“手机当前连接的本地电脑是否可用”。这里的“设备在线”指 App 配置的后端电脑可达、后端进程可响应、并且 App 可以继续使用该电脑上的项目和终端能力；它不是某个 terminal session 的 `running/exited` 状态，也不是 Codex agent 的 `agent_running/agent_idle` 状态。

用户可见结果：

- 首页顶部显示当前电脑连接状态：`Online`、`Checking`、`Offline`。
- 首页列表继续展示最近一次已加载的项目/终端数据；如果电脑不可达，展示离线提示，不把用户登出。
- 详情页顶部显示电脑状态；电脑离线时优先显示 `Computer Offline`，不要只停留在 `Connecting`。
- 电脑离线时，详情页禁用会写入后端的操作入口，例如发送输入、上传图片、Stop、删除终端和新建终端；电脑恢复在线后自动刷新状态并恢复操作。

## 当前代码依据

- App 首页数据来自 `GET /api/app/home/overview`：`backend/src/routes/app-home-overview.ts`。
  - 该接口返回 `projects` 和 `sessions`，每个 session 已经有 `displayStatus/displayStatusLabel/terminalState`。
  - 当前这些字段表达的是终端业务状态，不表达电脑是否可达。
- App 首页 UI：`app/src/pages/HomePage.tsx`、`app/src/components/TerminalRow.tsx`。
  - 首页 header 当前展示 `Runweave` 和 `apiBase` host，没有设备在线状态。
  - 每个终端行只展示 `displayStatusLabel`。
- App 详情页 UI：`app/src/pages/AppTerminalPage.tsx`。
  - 详情页 header 当前用 `useAppTerminalConnection()` 的 `connectionStatus` 展示 `Connected/Connecting`。
  - 这个状态只代表当前 terminal websocket，不代表本地电脑整体可达。
- App 全局会话：`app/src/hooks/use-app-session.ts`。
  - 启动时会 `verifySession()`，失败后尝试 `refreshStoredSession()`。
  - 当前 `refreshStoredSession()` 对所有失败都会 `resetSession()`；如果本地电脑只是睡眠、断网或后端没启动，用户会被误登出。
  - 首页 overview 加载失败后只设置 `error`，没有稳定的设备状态模型。
- App 全局 terminal events：`app/src/hooks/use-app-terminal-events-connection.ts`。
  - 已连接 `/ws/terminal-events`，用于接收 `terminal_state_changed` 并实时刷新首页状态。
  - 当前 hook 不向外暴露 websocket 连接生命周期，不能作为设备在线信号。
  - 当前失败后会固定 1200 ms 重连；设备 offline 时继续重连没有意义，且会绕过设备级退避策略。
- 详情页 terminal websocket：`app/src/hooks/use-app-terminal-connection.ts`。
  - 已有重连与输入缓冲。
  - 当前失败后会固定 1200 ms 重连；设备 offline 时应暂停，不应继续打不可达后端。
  - 如果电脑长时间不可达，继续允许用户输入会让“已排队”和“实际无法发送”之间产生误解。
- App 终端详情页：`app/src/pages/AppTerminalPage.tsx`。
  - 当前详情页每 2000 ms 轮询 `/api/terminal/session/:id/state`。
  - 设备 offline 时继续轮询 `/state` 只会制造无效请求，应暂停并等待设备恢复或用户手动刷新。
- 后端健康检查：`backend/src/server/health.ts` 与 `backend/src/index.ts` 的 `GET /health`。
  - 当前 payload 类型只定义在 backend 内部，尚未放入 `packages/shared`。
- 后端 websocket heartbeat：`backend/src/ws/heartbeat.ts`。
  - `createHeartbeatController()` 已用于部分 WebSocket server。
  - `/ws/terminal-events` 当前没有接入该 heartbeat。

## 社区做法采纳

- `ws` 官方 README 建议服务端通过周期性 `ping()`、收到 `pong` 后标记 alive、未响应则 `terminate()` 来关闭坏连接；这是后端清理僵尸连接的合适机制。参考：https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
- MDN 定义浏览器 `WebSocket.readyState` 只有 `CONNECTING/OPEN/CLOSING/CLOSED` 四类连接状态；这些状态只能说明单条 socket 的状态，不能等价为“电脑可用”。参考：https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
- 浏览器 JavaScript 不能直接发送或观察协议级 ping/pong；若应用逻辑需要可见的在线状态，需要应用层 heartbeat 或健康检查。参考：https://websocket.org/guides/heartbeat/

本计划采用组合策略：

- 后端继续使用协议级 heartbeat 清理坏连接，并给 `/ws/terminal-events` 补齐 heartbeat。
- App 用轻量 `GET /health` probe 作为“电脑是否可达”的权威信号，但不做长期高频轮询。
- App 把 `/ws/terminal-events` connected/close/error 作为主要实时信号：在线时优先依赖 websocket 保活；只有启动、回前台、网络恢复、手动刷新、API/WS 失败和离线退避重试时才 probe。

## 非目标

- 不实现云端设备注册中心，不做多电脑设备列表，不做远程唤醒。
- 不把 terminal session 的 `status`、`TerminalState` 或 `connectionStatus` 改名为设备在线状态。
- 不新增前端 Vitest 单测；App 前端验证以类型检查、构建和 `$playwright-cli` 浏览器验收为准。
- 不修改 Web 桌面 terminal workspace 的 UI。
- 不为了离线场景新增完整离线数据缓存；本次只保留运行时内存中的最近 overview。App 冷启动且电脑不可达时，首页显示离线空态。

## 数据结构与接口

### shared 健康检查契约

新增或迁移到 `packages/shared/src/runtime-monitor.ts`：

```ts
export interface BackendHealthPayload {
  status: "ok";
  runtimeReleaseId?: string;
}
```

修改 `backend/src/server/health.ts`：

- 从 `@runweave/shared` 引入 `BackendHealthPayload`。
- `buildHealthPayload()` 返回 `BackendHealthPayload`。

App 本地状态只放在 App 侧，不进 shared：

```ts
export type AppDeviceConnectionStatus = "checking" | "online" | "offline";

export interface AppDeviceConnectionSnapshot {
  status: AppDeviceConnectionStatus;
  apiBaseHost: string;
  checkedAt: number | null;
  lastSeenAt: number | null;
  latencyMs: number | null;
  reason:
    | "initial"
    | "health-ok"
    | "network-unreachable"
    | "timeout"
    | "http-error"
    | "terminal-events-connected"
    | "terminal-events-close";
  message: string;
}
```

`reason` 是诊断字段，不直接暴露给普通用户；UI 使用 `status/message/lastSeenAt`。

## 实施步骤

### 1. 补齐 shared health contract

修改文件：

- `packages/shared/src/runtime-monitor.ts`
- `backend/src/server/health.ts`
- `backend/src/server/health.test.ts`

要求：

- `BackendHealthPayload` 从 shared 导出，不在 backend 私有重复定义 DTO。
- 保持当前 `/health` 响应语义：无 release id 时返回 `{ "status": "ok" }`，有 `RUNWEAVE_RUNTIME_RELEASE_ID` 时额外返回 `runtimeReleaseId`。

验证：

```bash
pnpm --filter @runweave/backend test -- src/server/health.test.ts
```

预期：健康检查单测通过。

### 2. 新增 App health probe 服务

新增文件：

- `app/src/services/device-health.ts`

职责：

- 导出 `getBackendHealth(apiBase, options)`。
- 使用现有 `requestJson<BackendHealthPayload>(apiBase, "/health", { signal })`。
- 不携带 App `Authorization` header，避免把 access token 过期误判成电脑离线。
- 支持 `AbortController` timeout，默认 2500 ms。
- 把失败归类为：
  - `timeout`：`AbortError`。
  - `network-unreachable`：fetch 网络失败，例如电脑睡眠、IP 变更、后端未启动。
  - `http-error`：收到了 HTTP 响应但不是 2xx，例如 tunnel auth 阻断。

验收点：

- 电脑可达时，probe 能拿到 `{ status: "ok" }` 并记录 latency。
- 电脑不可达时，probe 在 2500 ms 左右返回离线分类，不让页面长期卡住。
- HTTP 401/403 被归类为“电脑可达但不可用”的 `offline/http-error`，不触发 App 登出。

### 3. 新增 App API 失败分类 helper

新增文件：

- `app/src/services/api-failure.ts`

职责：

- 导出统一失败分类函数，所有会影响登录态或设备在线状态的 App 请求 catch 分支都必须先经过该 helper。
- 不允许在 `useAppSession()`、`AppTerminalPage` 或 terminal hooks 中散写“任意 catch 后 reset session”的逻辑。

建议类型：

```ts
export type AppApiFailureKind =
  | "auth-expired"
  | "network-unreachable"
  | "timeout"
  | "http-error"
  | "not-found"
  | "unknown";

export interface AppApiFailure {
  kind: AppApiFailureKind;
  status?: number;
  message: string;
}

export function classifyApiFailure(error: unknown): AppApiFailure;
```

分类规则：

- `ApiError.status === 401`：`auth-expired`。
- `ApiError.status === 404`：`not-found`。
- 其他 `ApiError`：`http-error`，保留 `status` 和后端 message。
- `DOMException.name === "AbortError"` 或等价 abort error：`timeout`。
- `TypeError`、`Failed to fetch`、`NetworkError`、`Load failed` 等 fetch 网络失败：`network-unreachable`。
- 无法识别的错误：`unknown`。

登录态约束：

- `resetSession()` 只能由两类路径触发：
  - 用户主动 logout。
  - `classifyApiFailure(error).kind === "auth-expired"`。
- `network-unreachable`、`timeout`、`http-error`、`unknown` 默认不登出；它们只更新设备离线状态和错误文案。
- `not-found` 是业务资源不存在，例如 terminal 被删，不影响登录态，也不代表设备离线。
- `unknown` 不能默认为登录过期；如果调用点确实要登出，必须先把错误分类收敛到 `auth-expired`。

必须接入的调用点：

- `app/src/hooks/use-app-session.ts`
  - `verifySession()` catch。
  - `refreshStoredSession()` catch。
  - `loadOverview()` catch。
  - `loadOverview()` 401 后再次 refresh 的 catch。
- `app/src/pages/AppTerminalPage.tsx`
  - `/state` 轮询 catch。
  - Stop、发送输入、上传图片、删除终端等会写后端的操作 catch。
- `app/src/hooks/use-app-terminal-events-connection.ts`
  - ticket 请求 catch。
- `app/src/hooks/use-app-terminal-connection.ts`
  - `getTerminalSession()` catch。
  - ticket 请求 catch。

验收点：

- 关闭后端或电脑睡眠时，`verifySession()` 和 `refreshStoredSession()` 不会清本地 auth store。
- access token 确认 401 时才清 session 并回登录页。
- terminal 404 只显示终端不存在，不触发登出。

### 4. 新增 App 设备连接 hook

新增文件：

- `app/src/hooks/use-app-device-connection.ts`

职责：

- 管理 `AppDeviceConnectionSnapshot`。
- 初始为 `checking`。
- App authenticated 后立即 probe 一次 `/health`。
- 在线时不做固定间隔 `/health` 轮询，主要依赖 `/ws/terminal-events` 的 open/close/error 和已有 API 请求结果判断是否需要复核。
- 只有以下事件触发主动 probe：
  - App 启动或登录态恢复。
  - App 回到前台：`focus` 或 `visibilitychange` 变为 visible。
  - 系统网络恢复：`window` 的 `online` 事件。
  - 用户下拉刷新或点击重试。
  - overview、terminal detail、terminal events websocket、terminal websocket 出现网络失败或异常 close。
  - 设备已经处于 offline，且离线退避计时器到期。
- 离线后使用退避重试，不允许固定 3 秒长期轮询：
  - 第 1 次：5 秒后重试。
  - 第 2 次：15 秒后重试。
  - 第 3 次：30 秒后重试。
  - 第 4 次：60 秒后重试。
  - 第 5 次及之后：120 秒后重试，封顶维持 120 秒。
- App 进入后台或页面不可见时停止离线退避计时器；回到前台时立即 probe 一次，并根据结果重新安排退避。
- 用户手动刷新或点击重试时立即 probe 一次，并重置离线退避序列。
- 设备 offline 后，除设备级退避 probe 和用户手动 retry 外，必须暂停 terminal-events websocket、terminal websocket 和详情 `/state` interval，避免它们继续以 1200 ms 或 2000 ms 的频率请求不可达后端。
- 提供：

```ts
{
  deviceConnection,
  markDeviceOnline(reason: AppDeviceConnectionSnapshot["reason"]): void,
  markDeviceOffline(reason: AppDeviceConnectionSnapshot["reason"], message: string): void,
  refreshDeviceConnection(): Promise<AppDeviceConnectionSnapshot>
}
```

关键约束：

- probe 成功只代表电脑后端可达，不代表登录态有效。
- probe 失败不调用 `clearSession()`。
- `lastSeenAt` 只在 `/health` 成功、业务 API 成功或收到 terminal-events 服务端 `type: "connected"` 后更新；浏览器 raw WebSocket `open` 不更新 `lastSeenAt`。
- 离线退避计时器在未登录、App 后台、组件卸载或依赖变化时清理。

验证：

```bash
pnpm --filter @runweave/app typecheck
```

预期：App 类型检查通过。

### 5. 修正 App session 的离线语义

修改文件：

- `app/src/hooks/use-app-session.ts`
- `app/src/routes/AppRoutes.tsx`

改动：

- `AppSessionController` 增加 `deviceConnection`、`refreshDeviceConnection`。
- 在 `useAppSession()` 内接入 `useAppDeviceConnection()`。
- `verifySession()`、`refreshStoredSession()`、`loadOverview()` 的所有 catch 都必须调用 `classifyApiFailure(error)`。
- `verifySession()` 或 `refreshSession()` 分类为 `network-unreachable`、`timeout`、`http-error`、`unknown` 时：
  - 不调用 `resetSession()`。
  - 保留本地 auth store。
  - 设置 `startupState="ready"`。
  - 保持 `isAuthenticated=true`，让用户进入首页看到离线状态。
- 只有明确 App auth 失效时才登出：
  - `verifySession()` 分类为 `auth-expired`。
  - `refreshSession()` 分类为 `auth-expired`。
  - 用户主动 logout。
- `loadOverview()` 遇到 `auth-expired` 时允许走 refresh；refresh 再次失败后也必须按 `classifyApiFailure()` 结果处理，只有 `auth-expired` 才 `resetSession()`。
- `loadOverview()` 成功后标记设备 `online`。
- `loadOverview()` 分类为 `network-unreachable`、`timeout`、`http-error` 或 `unknown` 时标记设备 `offline`，保留当前 `overview`，并设置更明确错误文案，例如 `本地电脑暂时不可用`。
- `createTerminalSession()`、`deleteTerminalSession()` 前先判断 `deviceConnection.status !== "offline"`；离线时直接阻止并显示用户可读错误。
- `refreshOverview()` 在设备 offline 时先执行 `refreshDeviceConnection()`：
  - 如果 probe 仍失败，只更新设备离线状态并保留当前 overview，不继续请求 `/api/app/home/overview`。
  - 如果 probe 成功，标记 online，再请求 overview。
  - 这样首页下拉刷新就是用户可见的“重新检测设备在线”入口。

验收点：

- App 已登录后，关闭本地电脑后端并重新打开 App，不会跳回登录页。
- 首页显示电脑离线。
- 后端恢复后，首页可通过回前台、网络恢复事件、用户手动刷新或离线退避重试恢复 Online；长期离线时重试频率封顶为每 120 秒一次。

### 6. 让 terminal events websocket 参与设备状态

修改文件：

- `app/src/hooks/use-app-terminal-events-connection.ts`
- `app/src/hooks/use-app-session.ts`

改动：

- `useAppTerminalEventsConnection()` 的 `enabled` 必须绑定设备状态：
  - `enabled = isAuthenticated && Boolean(accessToken) && deviceConnection.status !== "offline"`。
  - 当 `enabled` 从 true 变为 false 时，立即 close 当前 socket、清理 reconnect timer，不再 1200 ms 重连。
  - 当 `enabled` 从 false 变为 true 时，按现有 cursor 逻辑重新换 ticket 并连接。
- `useAppTerminalEventsConnection()` 新增可选回调：

```ts
onServerConnected?: () => void;
onConnectionClose?: (event: CloseEvent) => void;
onConnectionError?: () => void;
onTransportOpen?: () => void;
```

- 只有收到服务端 `type: "connected"` 时调用 `onServerConnected()`；浏览器 raw WebSocket `open` 最多调用 `onTransportOpen()` 记录 `transport-open` 日志，不能 mark online，也不能更新 `lastSeenAt`。
- close/error 时调用 close/error 回调，但不直接登出。
- `useAppSession()` 将服务端 `connected` 映射为 `markDeviceOnline("terminal-events-connected")`。
- 除 terminal-events 服务端 `connected` 外，只有 `/health` 成功或业务 API 成功可以 mark online；raw socket open、readyState OPEN、ticket 请求成功都不能单独把设备标为 online。
- ticket 请求失败必须走 `classifyApiFailure()`；只有 `auth-expired` 能触发 `onAuthExpired()`，网络失败和 timeout 触发设备 health probe 或离线退避。
- close/error 不立即把设备置 offline；先触发一次 health probe。如果 health probe 失败，再置 offline 并进入离线退避重试。这样避免单条 websocket 抖动导致首页频繁闪烁，也避免长期离线时持续高频请求。
- 一旦设备状态进入 offline，terminal-events hook 必须停止自己的 reconnect timer；后续恢复只由 `refreshDeviceConnection()` 成功、回前台成功 probe、网络恢复成功 probe、下拉刷新成功 probe 或离线退避成功 probe 触发。

验收点：

- `/ws/terminal-events` 正常连接时，首页设备状态快速变为 Online。
- websocket 抖动但 `/health` 成功时，首页不闪 Offline。
- `/health` 也失败时，首页转为 Offline。
- 设备 offline 后，不再出现 `/ws/terminal-events` 每 1200 ms 重连。

### 7. 后端给 `/ws/terminal-events` 补 heartbeat

修改文件：

- `backend/src/ws/terminal-events-server.ts`
- `backend/src/ws/terminal-events-server.test.ts`

改动：

- 复用 `createHeartbeatController()`。
- connection 建立后调用 `heartbeat.start()`。
- socket `pong` 时调用 `heartbeat.markAlive()`。
- socket `close` 时调用 `heartbeat.stop()` 并 `unsubscribe()`。

验证：

```bash
pnpm --filter @runweave/backend test -- src/ws/terminal-events-server.test.ts src/ws/heartbeat.test.ts
```

预期：

- 既有 catch-up/live event 测试通过。
- heartbeat 不影响 unauthorized close 行为。

### 8. 首页展示设备在线状态

修改文件：

- `app/src/pages/HomePage.tsx`
- `app/src/components/AppDeviceStatusBadge.tsx`
- `app/src/main.css`

新增组件：

```tsx
interface AppDeviceStatusBadgeProps {
  status: "checking" | "online" | "offline";
  message: string;
  lastSeenAt: number | null;
}
```

UI 要求：

- 放在 Home header 的 `Runweave`/host 附近，不占用终端列表空间。
- `Online` 使用绿色小圆点。
- `Checking` 使用中性或黄色小圆点。
- `Offline` 使用红色或灰红小圆点，并显示最近在线时间，例如 `Last seen 2m ago`。
- 文案必须短，移动宽度下不能挤压 `AppMoreMenu`。
- 如果 `deviceConnection.status === "offline"`：
  - 新建终端按钮禁用。
  - 下拉刷新仍可用，用于手动重试设备在线检测；下拉刷新先 probe `/health`，成功后再刷新 overview。
  - 如果已有 overview，列表继续展示，顶部显示离线提示。
  - 如果没有 overview，显示离线空态，而不是 spinner 无限转。

验收点：

- 在线时首页 header 显示 `Online`。
- 关闭后端后，首页在超时窗口后显示 `Offline`。
- 恢复后端后，首页可通过回前台、网络恢复、离线退避或下拉刷新变回 `Online`；下拉刷新成功后重新加载列表。

### 9. 详情页展示并消费设备在线状态

修改文件：

- `app/src/pages/AppTerminalPage.tsx`
- `app/src/routes/AppRoutes.tsx`
- `app/src/components/TerminalCommandComposer.tsx`
- `app/src/hooks/use-app-terminal-connection.ts`
- `app/src/main.css`

改动：

- `AppTerminalPageProps` 增加 `deviceConnection` 和 `onRefreshDeviceConnection`。
- `AppTerminalPage` 内所有请求 catch 必须走 `classifyApiFailure()`；只有 `auth-expired` 调用 `onAuthExpired()`，`not-found` 只更新 not found UI，网络失败和 timeout 更新设备离线状态。
- `useAppTerminalConnection()` 增加 `enabled?: boolean` 和 `canQueueInput?: boolean`：
  - `AppTerminalPage` 传入 `enabled={deviceConnection.status !== "offline"}`。
  - `AppTerminalPage` 传入 `canQueueInput={deviceConnection.status !== "offline"}`。
  - `enabled=false` 时 close 当前 socket、清理 1200 ms reconnect timer、保持当前 renderer 内容和 metadata，不再连接 `/ws/terminal`。
  - `enabled=false` 或 `canQueueInput=false` 时，`sendInput()` 必须在 hook 边界直接拒绝输入，不写入 socket，也不 push 到 `pendingInputRef`。
  - `sendInput()` 的返回值改成可观测结果，例如 `{ accepted: boolean; reason?: "disabled" | "queue-full" }`；离线拒绝时记录 support log，但不表现为已发送。
  - `enabled=true` 时恢复现有 ticket + websocket 连接流程。
- header 状态优先级：
  - `deviceConnection.status === "offline"`：显示 `Computer Offline`。
  - terminal runtime exited：显示 `Exited`。
  - terminal websocket connected：显示 `Connected`。
  - 其他：显示 `Connecting`。
- 离线时：
  - 在 terminal body 上方显示轻量 overlay：`本地电脑暂时不可用，恢复后会自动重连`。
  - 禁用 composer 发送、图片上传、Stop、删除终端。
  - 不清空 terminal renderer 中已显示的内容。
  - 页面 handler 早返回，不调用会写后端的服务函数；同时 hook 层的 `sendInput()` 也必须拒绝入队，防止键盘输入、renderer input 或未来调用绕过 composer 后继续追加到 `pendingInputRef`。
  - 暂停详情页 `setInterval(refreshTerminalState, 2000)`，不继续请求 `/api/terminal/session/:id/state`。
  - overlay 或 header 提供可点击的重试入口，调用 `onRefreshDeviceConnection()`；成功 online 后再恢复 terminal websocket 和 `/state` 刷新。
- 在线恢复后：
  - `useAppTerminalConnection()` 重新 enabled，现有连接逻辑继续工作。
  - 调用一次 `/api/terminal/session/:id/state` 刷新 Stop 状态。

验收点：

- 进入详情页后关闭后端，header 显示 `Computer Offline`。
- 离线时点击发送或 Stop 不会产生请求，也不会显示“已发送”的假象。
- 离线时即使直接调用 `sendInput()`，`pendingInputRef` 也不会增加；恢复 online 后不会 flush 离线期间输入的旧队列。
- 离线时不再出现 `/ws/terminal` 每 1200 ms 重连，也不再出现 `/state` 每 2000 ms 轮询。
- 用户在详情页点击重试或回到首页下拉刷新时，会立即 probe 设备在线状态。
- 后端恢复后，详情页状态回到 `Connected/Connecting` 的正常链路。

## 验证计划

### 静态验证

```bash
pnpm --filter @runweave/shared test
pnpm --filter @runweave/backend test -- src/server/health.test.ts src/ws/terminal-events-server.test.ts src/ws/heartbeat.test.ts
pnpm --filter @runweave/app typecheck
pnpm --filter @runweave/app build
```

预期：

- shared/backend/App 命令退出码为 0。
- App build 允许保留现有 Vite chunk size warning，但不能有 TypeScript 或 Rollup error。

### 浏览器验收

涉及浏览器操作时必须使用 `$playwright-cli`。

启动：

```bash
pnpm app:dev
```

验收路径：

1. 打开 App 首页。
2. 登录或使用已有登录态进入 `/home`。
3. 观察 header：状态为 `Online`，项目/终端列表正常。
4. 停止本地 backend 进程。
5. 等待离线 probe 超时窗口。
6. 首页 header 变为 `Offline`，已有列表保留或显示离线空态，新建终端不可用。
7. 进入或停留在 `/terminal/:terminalSessionId`。
8. 详情页 header 显示 `Computer Offline`，composer、Stop、删除入口不可执行。
9. 恢复 backend。
10. App 通过回前台、网络恢复事件、手动刷新或离线退避重试恢复 `Online`；手动刷新 overview 后首页列表正常；详情页 websocket 继续重连。

失败判断：

- backend 不可达时 App 被清 session 并跳到登录页。
- 首页只显示泛化 `Failed to fetch`，没有设备离线状态。
- 详情页离线时仍允许发送输入或 Stop。
- 恢复 backend 后，回前台、手动刷新或离线退避重试不能让状态回到 Online。

## 风险与边界

- `GET /health` 当前受 tunnel auth 影响；如果某些部署启用了 `RUNWEAVE_TUNNEL_TOKEN` 且 iPhone 以非 loopback 访问，health 可能返回 401。计划中把这种情况视为“电脑可达但当前连接不可用”，不登出用户，但 UI 仍显示不可用。
- 单条 websocket close 不能直接代表电脑离线；必须用 health probe 复核，避免网络抖动导致 UI 闪烁。
- 离线状态可能持续很久，例如电脑睡眠、后端没启动或 IP 变化；离线重试必须使用退避并封顶到 120 秒，禁止固定 3 秒长期轮询。
- 设备在线状态只在 App 内存中维护；本次不做跨重启的 overview 缓存。
- 终端业务状态仍以后端 `TerminalState` 为准；设备在线状态只控制可达性和操作可用性。

## 建议执行顺序

1. 先做 shared health contract 和 App health probe。
2. 再修正 `useAppSession()` 的离线不登出语义。
3. 接入首页 badge。
4. 接入详情页禁用和状态展示。
5. 最后补 `/ws/terminal-events` heartbeat 与浏览器验收。
