# App 设备在线测试案例

本文档用于验证 App “设备在线”能力。这里的“设备在线”指手机当前配置的本地电脑后端可达、后端进程可响应、并且 App 可以继续使用该电脑上的项目和终端能力；它不是 terminal session 的 `running/exited`，也不是 `TerminalState` 的 `agent_running/agent_idle`。

涉及打开页面、点击、输入、下拉刷新、截图或浏览器自动化时，必须使用 `$playwright-cli`，不要使用其它浏览器操作方案。

## 目标契约

- 本地电脑后端不可达时，App 不应清登录态，不应跳回登录页。
- 设备 offline 时，只允许设备级 `/health` 退避 probe 和用户手动 retry，不允许 terminal-events WS、terminal WS、详情 `/state` 继续高频请求。
- 用户可通过首页下拉刷新或详情页重试按钮立即检测设备是否恢复在线。
- 只有 `/health` 成功、业务 API 成功、或 terminal-events 服务端 `type: "connected"` 才能把设备标为 online；raw WebSocket `open` 不能标记 online。
- 设备 offline 时，发送输入、Stop、上传图片、删除终端、新建终端等写后端操作必须被阻止。
- 设备 offline 时，`useAppTerminalConnection().sendInput()` 在 hook 边界拒绝输入，不允许追加到 pending input 队列。
- auth 失效和设备离线必须通过统一失败分类区分；只有 `auth-expired` 或用户主动 logout 能触发 `resetSession()`。

## 相关文件

- 权威边界：`docs/architecture/app-mobile.md`
- App session：`app/src/hooks/use-app-session.ts`
- App 设备连接：`app/src/hooks/use-app-device-connection.ts`
- App 失败分类：`app/src/services/api-failure.ts`
- App health probe：`app/src/services/device-health.ts`
- App 首页：`app/src/pages/HomePage.tsx`
- App 详情：`app/src/pages/AppTerminalPage.tsx`
- Terminal events WS hook：`app/src/hooks/use-app-terminal-events-connection.ts`
- Terminal WS hook：`app/src/hooks/use-app-terminal-connection.ts`
- 后端 health：`backend/src/server/health.ts`
- 后端 terminal-events WS：`backend/src/ws/terminal-events-server.ts`

## 测试环境

启动 App 开发环境：

```bash
pnpm app:dev
```

建议使用临时 profile，避免旧登录态和旧 session 干扰：

```bash
export BROWSER_PROFILE_DIR="$(mktemp -d)"
pnpm app:dev
```

浏览器验收时使用 `$playwright-cli` 打开 App 页面。测试过程中如果需要停止或恢复 backend，优先停止 `pnpm app:dev` 中的 backend 子进程；如果脚本不方便单独停止 backend，可以重启整个 `pnpm app:dev`，但测试记录里必须写清楚停止的是整个 dev 环境还是仅 backend。

## 观测点

- UI：
  - 首页 header 设备状态：`Online` / `Checking` / `Offline`。
  - 首页离线提示、下拉刷新行为、新建终端按钮状态。
  - 详情页 header：`Computer Offline` / `Connected` / `Connecting`。
  - 详情页 composer、Stop、删除入口、重试入口。
- Network：
  - `/health` 请求次数和间隔。
  - `/ws/terminal-events` 是否停止 1200 ms 重连。
  - `/ws/terminal` 是否停止 1200 ms 重连。
  - `/api/terminal/session/:id/state` 是否停止 2000 ms 轮询。
  - offline 时是否还有 `/api/app/home/overview`、`/input`、`/interrupt`、`/clipboard-image` 等写请求。
- 状态：
  - 本地 auth store 是否保留。
  - `deviceConnection.status`、`lastSeenAt`、`reason`。
  - `pendingInputRef` 是否在 offline 期间保持不增加。

## 自动化/静态验证

| ID            | 范围                      | 命令                                                                                                     | 预期                                                      |
| ------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| DO-STATIC-001 | shared/backend health     | `pnpm --filter @runweave/backend test -- src/server/health.test.ts`                                      | `/health` payload 测试通过                                |
| DO-STATIC-002 | terminal-events heartbeat | `pnpm --filter @runweave/backend test -- src/ws/terminal-events-server.test.ts src/ws/heartbeat.test.ts` | terminal-events 既有消息和 heartbeat 测试通过             |
| DO-STATIC-003 | App 类型检查              | `pnpm --filter @runweave/app typecheck`                                                                  | 无 TS error                                               |
| DO-STATIC-004 | App 构建                  | `pnpm --filter @runweave/app build`                                                                      | 无 TypeScript / Rollup error；允许现有 Vite chunk warning |

## API 失败分类测试

| ID          | 场景                    | 步骤                                                                       | 预期                                                         |
| ----------- | ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| DO-FAIL-001 | 401 归类为 auth-expired | 构造 `new ApiError("Unauthorized", 401, null)` 调用 `classifyApiFailure()` | 返回 `kind="auth-expired"`；调用方允许 `resetSession()`      |
| DO-FAIL-002 | 404 归类为 not-found    | 构造 `new ApiError("Not found", 404, null)`                                | 返回 `kind="not-found"`；不触发登出；详情可显示资源不存在    |
| DO-FAIL-003 | 其他 HTTP 错误          | 构造 `new ApiError("Bad gateway", 502, null)`                              | 返回 `kind="http-error"`；不触发登出；可标记设备 unavailable |
| DO-FAIL-004 | timeout                 | 使用 `AbortController` 触发 abort error                                    | 返回 `kind="timeout"`；不触发登出                            |
| DO-FAIL-005 | 网络不可达              | 构造 fetch `TypeError("Failed to fetch")` 或等价错误                       | 返回 `kind="network-unreachable"`；不触发登出                |
| DO-FAIL-006 | unknown 不登出          | 构造普通 `new Error("boom")`                                               | 返回 `kind="unknown"`；默认不触发登出                        |

## 首页设备在线测试

| ID          | 场景                    | 步骤                                                                                      | 预期                                                                                              |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DO-HOME-001 | 初始在线                | 启动 `pnpm app:dev`；用 `$playwright-cli` 打开 App 首页；登录或使用已有登录态进入 `/home` | 首页 header 显示 `Online`；列表正常；`lastSeenAt` 有值                                            |
| DO-HOME-002 | 后端不可达不登出        | 已登录停留首页；停止本地 backend；等待 `/health` 超时窗口                                 | 首页显示 `Offline`；不跳 `/login`；auth store 保留；已有 overview 不被清空                        |
| DO-HOME-003 | Offline 时下拉刷新失败  | 后端保持停止；在首页下拉刷新                                                              | 立即发起一次 `/health` probe；probe 失败后仍为 `Offline`；不请求 `/api/app/home/overview`；不登出 |
| DO-HOME-004 | Offline 时下拉刷新恢复  | 后端停止后进入 Offline；恢复 backend；首页下拉刷新                                        | 立即 `/health` 成功，状态变 `Online`；随后请求 `/api/app/home/overview` 并刷新列表                |
| DO-HOME-005 | Offline 禁止新建终端    | 后端停止并进入 Offline；点击项目的新建终端入口                                            | 按钮禁用或操作被阻止；不发送 `POST /api/terminal/session`                                         |
| DO-HOME-006 | 长期 offline 不高频轮询 | 后端保持停止 5 分钟；记录 network                                                         | `/health` 退避为 `5s -> 15s -> 30s -> 60s -> 120s`，封顶后约 120s 一次；没有固定 3s 请求          |
| DO-HOME-007 | 后台停止退避            | 后端停止并进入 Offline；让 App 页面不可见或切后台                                         | 离线退避 timer 停止；回前台立即 probe 一次，并重新安排退避                                        |

DO-HOME-007 判定补充：

- 触发首页 refresh 或手动 retry 后，先等待该次 `/health` probe 完成，并确认页面仍为 `Offline`；这次主动 probe 不计入后台退避观测窗口。
- 切到 `about:blank` 或其它标签页后，必须先确认 App 页已真实进入后台，例如在 App 页上下文读取到 `document.visibilityState === "hidden"`，或能观测到 `visibilitychange` / `pagehide` / `blur` 等后台事件。
- 只有在确认 App 页已经后台后，才开始统计后台窗口内的 network；后台窗口内不应出现新的 `/health` 退避 probe。
- 如果自动化环境中切换标签页后 App 页仍为 `document.visibilityState === "visible"` 且 `document.hasFocus() === true`，说明该环境没有真实制造后台状态；此时出现 `/health` 不能直接判定为 DO-HOME-007 失败，应先修正测试前置条件。
- 切回 App 页后，应立即出现一次 `/health` probe；这次前台恢复 probe 是预期行为。

## Terminal-events WebSocket 测试

| ID            | 场景                       | 步骤                                                                                                                  | 预期                                                                                       |
| ------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| DO-EVENTS-001 | 服务端 connected 才 Online | 正常连接 `/ws/terminal-events`；观察消息                                                                              | 收到服务端 `type="connected"` 后才允许 `markDeviceOnline("terminal-events-connected")`     |
| DO-EVENTS-002 | raw open 不算 Online       | 模拟或拦截 terminal-events WS：让 raw WebSocket `open` 发生，但服务端不发送 `type="connected"`，随后发 error 或 close | 只能记录 `transport-open` 日志；不得更新 `lastSeenAt`；不得把状态改为 `Online`             |
| DO-EVENTS-003 | Unauthorized 不误判在线    | 使用无效 ticket 连接 `/ws/terminal-events`                                                                            | 服务端发 error 并 1008 close；App 不 mark Online；若分类为 `auth-expired` 才触发 auth 处理 |
| DO-EVENTS-004 | Offline 停止重连           | 已连接 terminal-events；停止 backend；进入 Offline                                                                    | hook close 当前 socket 并清理 reconnect timer；不再每 1200 ms 连接 `/ws/terminal-events`   |
| DO-EVENTS-005 | 恢复后重连                 | Offline 后恢复 backend；下拉刷新或回前台 probe 成功                                                                   | terminal-events hook 重新 enabled，换 ticket 后连接，并收到服务端 `connected`              |

## 详情页设备在线测试

| ID            | 场景                     | 步骤                                                   | 预期                                                                                       |
| ------------- | ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| DO-DETAIL-001 | 初始在线进入详情         | 在线状态下从首页打开一个 terminal                      | header 显示 `Connected` 或 `Connecting`；terminal 输出正常；`/state` 按现有逻辑刷新        |
| DO-DETAIL-002 | 详情页离线展示           | 停留详情页；停止 backend；等待设备进入 Offline         | header 显示 `Computer Offline`；body 显示离线 overlay；不清空已渲染终端内容                |
| DO-DETAIL-003 | Offline 暂停 terminal WS | 详情页进入 Offline 后观察 network                      | 不再每 1200 ms 重连 `/ws/terminal`                                                         |
| DO-DETAIL-004 | Offline 暂停 /state      | 详情页进入 Offline 后观察 network                      | 不再每 2000 ms 请求 `/api/terminal/session/:id/state`                                      |
| DO-DETAIL-005 | Offline 阻止发送         | 详情页 Offline；尝试点击发送或触发发送 handler         | 不发送 `/input`；UI 不显示已发送；support log 记录 disabled/rejected                       |
| DO-DETAIL-006 | Offline 阻止 Stop        | 详情页 Offline；点击 Stop                              | 不发送 `/interrupt`；不做本地乐观状态修改                                                  |
| DO-DETAIL-007 | Offline 阻止图片上传     | 详情页 Offline；选择图片                               | 不发送 `/clipboard-image`；保留输入框内容；显示或记录设备离线                              |
| DO-DETAIL-008 | Offline 阻止删除         | 详情页 Offline；尝试删除终端                           | 不发送 `DELETE /api/terminal/session/:id`；不导航丢失当前页                                |
| DO-DETAIL-009 | 详情页重试恢复           | 详情页 Offline；恢复 backend；点击 overlay/header 重试 | 立即 `/health` 成功；状态变 Online；重新启用 terminal WS；请求一次 `/state` 刷新 Stop 状态 |

## Pending Input 队列测试

本组包含 white-box/harness 用例和浏览器黑盒用例。`pendingInputRef` 与 `sendInput()` 返回值属于 hook 内部状态；如果页面运行时没有显式 test harness 暴露这些能力，不能仅因为无法读取内部 ref 而判定用例失败。

| ID           | 场景                                        | 步骤                                                                                                                                                                    | 预期                                                                                                                                       |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DO-QUEUE-001 | White-box: Offline sendInput 不入队         | 前置：存在 test harness 或 dev-only hook 暴露 `sendInput()` 调用结果和 pending queue 长度；详情页进入 Offline；通过 harness 调用 `sendInput("echo should-not-send\\n")` | 返回 `{ accepted: false, reason: "disabled" }` 或等价结果；pending queue 长度不增加                                                        |
| DO-QUEUE-002 | Black-box: Offline UI 不发送输入            | 详情页进入 Offline；确认 composer disabled；尝试点击发送、键盘输入或强制触发输入相关 UI 事件                                                                            | 不发送 `/input`；UI 不显示已发送；不要求读取 `pendingInputRef`                                                                             |
| DO-QUEUE-003 | Black-box: Offline 期间输入不会恢复后 flush | Offline 时尝试输入带唯一 marker 的命令，例如 `echo should-not-send-<timestamp>`；恢复 backend 并等待 terminal WS 重连                                                   | 旧输入不会 flush 到终端；terminal 输出中不出现该 marker                                                                                    |
| DO-QUEUE-004 | Online 后正常入队/发送                      | 恢复 Online 后调用 `sendInput("echo online-ok\\n")`，或通过 UI 发送等价命令                                                                                             | socket open 时直接发送；socket 短暂未 open 且 `canQueueInput=true` 时才允许进入 pending queue；UI 路径应产生 `/input` 或 terminal WS input |
| DO-QUEUE-005 | White-box: Queue full 与 disabled 可区分    | 前置：存在 test harness；分别制造 queue full 和 offline disabled 两种情况                                                                                               | 返回 reason 能区分 `"queue-full"` 与 `"disabled"`；日志不混淆                                                                              |

## Session 与 Auth 测试

| ID          | 场景                             | 步骤                                                                      | 预期                                                                                                |
| ----------- | -------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| DO-AUTH-001 | verify 网络失败不登出            | 已登录；停止 backend；重新打开 App 触发 `verifySession()`                 | `classifyApiFailure()` 为 `network-unreachable` 或 `timeout`；不 `resetSession()`；进入首页 Offline |
| DO-AUTH-002 | refresh 网络失败不登出           | 让 access token 需要 refresh；停止 backend；触发 `refreshStoredSession()` | 不清 auth store；首页 Offline；不跳登录                                                             |
| DO-AUTH-003 | refresh 401 才登出               | backend 在线；让 refresh token 无效；触发 refresh                         | `auth-expired`；清 auth store；跳登录                                                               |
| DO-AUTH-004 | overview 401 后 refresh 成功     | backend 在线；overview 返回 401；refresh 成功                             | 不登出；重新请求 overview；设备 Online                                                              |
| DO-AUTH-005 | overview 401 后 refresh 网络失败 | overview 返回 401 后停止 backend；refresh 请求网络失败                    | 不登出；设备 Offline；保留当前 overview                                                             |
| DO-AUTH-006 | terminal 404 不登出              | 打开已删除 terminal 或请求不存在 terminal detail                          | 显示终端不存在；不清 auth store；不标记设备 offline                                                 |

## 验收失败判定

任意一项出现都视为失败：

- 本地电脑不可达时 App 清登录态或跳到登录页。
- Offline 后仍每 1200 ms 连接 `/ws/terminal-events`。
- Offline 后仍每 1200 ms 连接 `/ws/terminal`。
- Offline 后仍每 2000 ms 请求 `/api/terminal/session/:id/state`。
- Offline 后仍可发送 `/input`、`/interrupt`、`/clipboard-image`、`DELETE /session/:id` 或 `POST /session`。
- raw WebSocket `open` 直接把设备状态改为 `Online`。
- `pendingInputRef` 在 Offline 期间增长，或恢复 Online 后 flush 离线期间输入。
- `refreshStoredSession()` 对网络失败、timeout、普通 HTTP error 或 unknown error 调用 `resetSession()`。
