# 终端完成绿点实时 WebSocket 改造计划

日期：2026-06-07

状态：计划稿，尚未实施

## 背景

终端 tab / project 上的小绿点表示：非当前 terminal 中，AI CLI 的一次任务已经完成，可以回去接管。

当前实现已经把完成信号收敛到 explicit completion event：AI CLI hook 通过 `browser-viewer-hook-bridge` 写入 `/internal/terminal-completion`，后端记录 `TerminalCompletionEvent`，前端再读取事件点亮 `completionMarkers`。但前端读取事件仍然是定时轮询：

- `frontend/src/components/terminal/terminal-workspace.tsx` 内部轮询 `/api/terminal/completion-events`。
- 轮询基础间隔是 `2_000ms`，空闲后指数退避，最大 `30_000ms`。
- 因此任务已经完成时，小绿点可能要等下一次轮询才出现。

本计划目标是彻底移除 UI 小绿点对定时轮询的依赖，改成后端实时 WebSocket 推送。

## 当前代码扫描结论

相关现状：

- `packages/shared/src/terminal-protocol.ts`
  - 已有 `TerminalCompletionEvent` 和 `TerminalCompletionEventListResponse`。
  - 现有 `TerminalServerMessage` 属于单 terminal IO WebSocket，不适合作为 workspace 级事件流直接复用。

- `backend/src/routes/terminal-completion.ts`
  - `POST /internal/terminal-completion` 校验 hook token 后写入 completion event。
  - 当前还用 `session.activeCommand` 作为硬门禁。Stop hook 晚到时 `activeCommand` 可能已经变成 `null`，这会造成真实完成事件被忽略。

- `backend/src/terminal/completion-events.ts`
  - `TerminalCompletionEventStore` 是内存短队列，支持 `record()` 和 `listAfter(afterId)`。
  - 当前 store 不具备订阅/广播能力。

- `backend/src/routes/terminal.ts`
  - `GET /api/terminal/completion-events` 返回 `completionEventStore.listAfter(after)`。
  - `POST /api/terminal/session/:id/ws-ticket` 只签发绑定单个 `terminalSessionId` 的 `terminal-ws` ticket。

- `backend/src/ws/terminal-server.ts`
  - `/ws/terminal` 是单 terminal surface 的实时 IO 通道。
  - 连接时会 attach terminal runtime、发送 snapshot/output/metadata/status。
  - 小绿点需要覆盖未激活 terminal，所以不能只靠当前 active terminal 的 `/ws/terminal`。

- `frontend/src/features/terminal/use-terminal-connection.ts`
  - 只处理单 terminal 的 `snapshot`、`output`、`metadata`、`status`、`exit`、`error`。
  - 适合参考重连和 ticket 模式，但不应承载 workspace completion event。

- `frontend/src/components/terminal/terminal-workspace.tsx`
  - `completionMarkers` 是 UI 状态来源。
  - 进入 active terminal 时会清掉该 terminal 的 marker。
  - 当前 completion event 轮询会跳过 active terminal，只点亮非当前 terminal。

- `frontend/src/components/terminal/terminal-workspace-effects.ts`
  - `useSessionMarkerCleanup` 会清理已不存在 session 的 completion marker。
  - 这部分语义应该保留。

## 目标

1. AI completion event 写入后，在线前端在一个 WebSocket 往返内收到事件并点亮非当前 terminal 的小绿点。
2. 删除 `TerminalWorkspace` 中 completion event 的定时轮询和退避逻辑。
3. 页面刚打开、WebSocket 断线重连或切换 backend connection 后，能够通过 cursor catch-up 补齐漏掉的短期事件。
4. 保留当前 UI 语义：当前 active terminal 收到 completion event 不显示未读绿点；切回有绿点的 terminal 后清除绿点。
5. 保留 `GET /api/terminal/completion-events` 作为 CLI、调试、E2E 或兼容读取接口，但前端 workspace 不再定时调用它。

## 非目标

- 不改变黄色 bell marker 的含义和展示优先级。
- 不把普通 terminal 输出、普通命令退出、`activeCommand -> null` 推断为 AI 任务完成。
- 不把现有 `/ws/terminal` 改成 workspace 广播通道。
- 不要求 event store 持久化到磁盘。绿点仍是实时提醒，不是审计记录。
- 不新增前端 `src/` 下的 Vitest 单测。
- 不删除 `GET /api/terminal/completion-events`，第一阶段只让 UI 不再轮询它。

## 推荐架构

新增一个 workspace 级终端事件 WebSocket：

```text
AI CLI Stop hook
  -> browser-viewer-hook-bridge
  -> POST /internal/terminal-completion
  -> TerminalCompletionEventService.record()
      -> 写入短期内存事件队列
      -> 广播给 /ws/terminal-events 在线客户端
  -> TerminalWorkspace 收到 live event
      -> 点亮非当前 terminal / project 小绿点
      -> Electron 下播放完成音
```

新通道：

```text
POST /api/terminal/completion-events/ws-ticket
GET  /ws/terminal-events?token=<ticket>&after=<baselineEventId>
```

`after` 不是轮询游标，而是连接建立时的一次性 catch-up 游标：

- 首次连接：前端先通过 ticket API 拿到 `ticket` 和当前 `baselineEventId`，再用 `after=baselineEventId` 打开 WebSocket。这样 baseline 生成之后发生的 live event 不会被归入“历史事件”而丢失。
- 重连：前端使用本地已确认处理的最新 event id 作为 `after`，补齐断线窗口。
- 切换 `apiBase`：前端清空 cursor 和 marker，重新建立该 backend 的 baseline。

禁止让 WebSocket 在“没有 cursor”时自行读取 `latestEventId` 并跳过历史事件。baseline 必须在 ticket API 中生成并返回；前端必须始终带 `after` 连接。

## 协议设计

在 `packages/shared/src/terminal-protocol.ts` 新增类型：

```ts
export interface CreateTerminalEventsWsTicketResponse {
  ticket: string;
  expiresIn: number;
  baselineEventId: string | null;
}

export type TerminalEventServerMessage =
  | {
      type: "connected";
      acceptedAfter: string | null;
    }
  | {
      type: "completion-events";
      delivery: "catchup";
      events: TerminalCompletionEvent[];
    }
  | {
      type: "completion-event";
      delivery: "live";
      event: TerminalCompletionEvent;
    }
  | {
      type: "error";
      message: string;
    };
```

前端处理规则：

- `connected.acceptedAfter` 只回显服务端接受的订阅游标，不用于初始化或覆盖 cursor。
- `completion-events` / `catchup` 只更新 marker，不播放完成音。
- `completion-event` / `live` 更新 marker；Electron 环境下沿用现有完成音逻辑。
- active terminal 的 event 不设置 marker。
- 找不到对应 session 的 event 不设置 marker；后续 session 列表刷新仍由 `useSessionMarkerCleanup` 清理无效 marker。

## 后端设计

### 1. Completion event service

新增文件：

```text
backend/src/terminal/completion-event-service.ts
```

职责：

- 包装 `TerminalCompletionEventStore`。
- 提供 `record(input, session)`、`listAfter(afterId)`、`getLatestId()`。
- 提供 `subscribe(listener)`，record 后同步通知订阅者。
- 订阅者异常不能影响 record 成功；异常只记录日志。

建议接口：

```ts
export type TerminalCompletionEventListener = (
  event: TerminalCompletionEvent,
) => void;

export class TerminalCompletionEventService {
  record(
    input: RecordTerminalCompletionEventInput,
    session: TerminalSessionRecord,
  ): TerminalCompletionEvent;

  listAfter(afterId: string | null): TerminalCompletionEvent[];

  getLatestId(): string | null;

  subscribe(listener: TerminalCompletionEventListener): () => void;
}
```

`backend/src/terminal/completion-events.ts` 保持为纯内存 store，不直接依赖 WebSocket。

### 2. Workspace event WebSocket server

新增文件：

```text
backend/src/ws/terminal-events-server.ts
backend/src/ws/terminal-events-handshake.ts
```

职责：

- 监听 `/ws/terminal-events`。
- 校验 tunnel auth，与现有 WebSocket upgrade 逻辑一致。
- 校验临时 ticket。
- 建连后发送 `connected`。
- WebSocket 必须要求 query 带 `after` 参数；`after` 可以是 ticket API 返回的 `baselineEventId`，也可以是前端重连时保存的最新 event id。没有 `after` 时返回 error 并关闭连接，避免实现回退到有竞态的“连接时自行 baseline”。
- 建连成功后必须先注册 `TerminalCompletionEventService` listener，再读取 `listAfter(after)` 并发送一次 `completion-events` catch-up，最后继续推送 live event。
- 如果 listener 注册后、catch-up 读取前有新事件写入，该事件可能同时出现在 catch-up 和 live 推送中；前端必须按 event id 去重。不能为了避免重复而把订阅放在 catch-up 之后，因为那会产生漏事件窗口。
- close 时取消订阅。
- 不 attach terminal runtime，不读取 scrollback，不发送 terminal output。

安全边界：

- WebSocket ticket 类型新增为 `terminal-events-ws`。
- ticket 由登录态 access token 换取，TTL 维持 `60_000ms`。
- ticket 不绑定单个 `terminalSessionId`，因为该通道表示当前登录 session 对 terminal workspace 的整体订阅权限。
- 不在 URL 或日志中输出 access token、hook token、完整 temporary token。

### 3. Auth token 扩展

修改文件：

```text
backend/src/auth/jwt.ts
backend/src/auth/service.ts
```

任务：

- `SignedTokenType` 增加 `"terminal-events-ws"`。
- `AuthService.issueTemporaryToken()` 和 `verifyTemporaryToken()` 的 tokenType 联合类型增加 `"terminal-events-ws"`。
- `TokenResource` 不需要新增字段；该 token 可使用空 resource `{}`。
- resource 校验继续保持严格相等语义，避免复用到 viewer/devtools/terminal IO 通道。

### 4. Ticket API

修改文件：

```text
backend/src/routes/terminal.ts
frontend/src/services/terminal.ts
packages/shared/src/terminal-protocol.ts
```

新增接口：

```text
POST /api/terminal/completion-events/ws-ticket
```

后端行为：

- 无登录态返回 `401`。
- `authService` 不存在返回 `503`。
- 成功时签发 `terminal-events-ws` temporary token。
- 成功响应必须同时包含 `baselineEventId: completionEventService.getLatestId()`。前端第一次连接使用这个 baseline 作为 `after`，不要让 WebSocket server 在 handshake 阶段重新计算 baseline。

前端 service：

```ts
export async function createTerminalEventsWsTicket(
  apiBase: string,
  token: string,
): Promise<CreateTerminalEventsWsTicketResponse>;
```

### 5. Completion 写入门禁调整

修改文件：

```text
backend/src/routes/terminal-completion.ts
```

任务：

- 保留 `RUNWEAVE_HOOK_TOKEN` 校验。
- 保留 `terminalSessionId` 存在性校验。
- 保留 source allowlist，例如第一阶段只允许 `codex`、`trae`；如需要支持 `claude`，必须同时确认 launcher 已安装和来源语义。
- 不能退化成 source-only 信任模型。写入层必须保留“source 与最近 AI active command 匹配”的有界门禁。
- 接受条件：
  - 当前 `session.activeCommand` 与 `source` 匹配；或
  - 当前 `session.activeCommand` 已清空，但该 terminal 最近一次 AI active command 与 `source` 匹配，且距离清空时间不超过 `AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS = 30_000`。
- 拒绝条件：
  - source 不在 allowlist。
  - 当前 active command 与 source 不匹配。
  - 最近 AI active command 不存在、与 source 不匹配，或超过 grace window。
- 日志保留 `activeCommand`、`lastAiActiveCommand`、`lastAiActiveCommandClearedAt`、`source`、`rawHookEvent`、`terminalSessionId`，用于排查 late Stop hook 或来源不匹配。

原因：

Stop hook 很可能在 shell integration 已把 `activeCommand` 更新为 `null` 后才到达后端。继续只看当前 `activeCommand` 会造成真实 completion event 被忽略；但完全移除 active command 门禁会让任何继承了 `RUNWEAVE_*` 环境的后续进程伪造成 AI Stop event。短 grace window 是第一阶段的折中：修复 late hook，同时保留现有防误报边界。

实现要求：

- 在后端维护每个 terminal 的最近 AI active command 状态。可以放在 `TerminalSessionManager` 的内存态中，也可以放在 `TerminalCompletionEventService` 的内存态中；第一阶段不需要持久化。
- 每次 terminal metadata 更新时，如果 `activeCommand` 是受支持的 AI CLI，就记录 `{ command, source, observedAt }`。
- 当 metadata 从该 AI CLI 变成 `null` 时，记录 `clearedAt`，供 grace window 使用。
- 如果 metadata 从一个 AI CLI 切到另一个命令，旧 AI grace 立即失效，避免用户运行普通命令后旧 Stop hook 继续点绿点。
- 匹配函数集中实现，例如 `isCompletionSourceAllowedForCommand(source, command)`，不要在 route 和测试中复制映射。

### 6. 服务装配

修改文件：

```text
backend/src/index.ts
```

任务：

- runtime services 中创建 `TerminalCompletionEventService`。
- `createInternalTerminalCompletionRouter` 和 `createTerminalRouter` 统一使用 service。
- attach 新的 `terminal-events` WebSocket server。
- 保持现有 `/ws/terminal` 行为不变。

## 前端设计

### 1. 新增 terminal events connection hook

新增文件：

```text
frontend/src/features/terminal/use-terminal-events-connection.ts
```

职责：

- 用 access token 调 `createTerminalEventsWsTicket()`。
- 建立 `/ws/terminal-events?token=...&after=...`。
- 维护连接状态和自动重连。
- 首次连接前从 `createTerminalEventsWsTicket()` 读取 `baselineEventId`，并把它作为 `after`。
- 收到 `connected` 不能覆盖本地 cursor；cursor 只在实际处理 completion event 后推进。
- 收到 catch-up / live completion event 时调用回调。
- `1008 Unauthorized` 或 ticket API `401` 时调用 `onAuthExpired`。
- 对 catch-up 和 live event 按 `event.id` 去重，因为服务端为了避免漏事件会先注册 listener 再发 catch-up，边界上的 event 允许重复送达。

可以复用 `use-terminal-connection.ts` 的这些模式：

- `toWebSocketBase(apiBase)`。
- 临时 ticket + query token。
- close 后自动重连。
- `onAuthExpired` 处理。

不要复用这些行为：

- terminal snapshot / output / metadata 状态。
- pending input / resize。
- terminal runtime status。

### 2. 替换 TerminalWorkspace 轮询

修改文件：

```text
frontend/src/components/terminal/terminal-workspace.tsx
```

任务：

- 删除现有 completion polling effect。
- 保留 `completionEventCursorRef`，改为 WebSocket reconnect cursor。
- 删除 `hasInitializedCompletionCursorRef`，或将其替换为 WebSocket baseline 语义。
- 抽出 `applyCompletionEvents(events, delivery)`：
  - 忽略 active terminal event。
  - 忽略当前 session 列表不存在的 event。
  - 非 active terminal 设置 `completionMarkers[terminalSessionId] = true`。
  - `delivery === "live"` 且 Electron 下播放完成音。
  - 更新 cursor 到 events 的最大 id。
- `apiBase` 变化时继续清空 marker、bell、cursor 和 session state。

保留现有逻辑：

- active terminal 切换后清除该 terminal 的 completion marker。
- `useSessionMarkerCleanup` 清理不存在 session 的 marker。
- project tab 上根据 session marker 汇总显示绿点。

### 3. 降级策略

第一阶段不做定时轮询 fallback。WebSocket 断线时只重连；重连失败时可以在 UI 内部保留连接错误状态，但不启动轮询。

如果后续需要兼容老后端，可以在 Electron connection 管理层做版本能力判断，再决定是否启用旧轮询。当前计划不引入这个兼容层。

## 文件范围

新增：

- `backend/src/terminal/completion-event-service.ts`
- `backend/src/ws/terminal-events-server.ts`
- `backend/src/ws/terminal-events-handshake.ts`
- `frontend/src/features/terminal/use-terminal-events-connection.ts`

修改：

- `packages/shared/src/terminal-protocol.ts`
- `backend/src/auth/jwt.ts`
- `backend/src/auth/service.ts`
- `backend/src/index.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/routes/terminal-completion.ts`
- `backend/src/terminal/completion-events.ts`
- `backend/src/terminal/manager.ts`
- `backend/src/ws/terminal-server.ts`
- `frontend/src/services/terminal.ts`
- `frontend/src/components/terminal/terminal-workspace.tsx`
- `frontend/tests/terminal.spec.ts`

可能修改：

- `backend/src/ws/terminal-server.test.ts` 仅当需要复用测试 helper。
- `backend/src/routes/terminal-completion.test.ts` 调整 activeCommand 门禁预期。

## 实施步骤

### 1. 定义 shared 协议和 auth token 类型

任务：

- 在 `terminal-protocol.ts` 增加 `CreateTerminalEventsWsTicketResponse` 和 `TerminalEventServerMessage`。
- 在 `auth/jwt.ts` 与 `auth/service.ts` 增加 `"terminal-events-ws"` token type。

验证：

```bash
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
```

预期：

- 类型检查通过。
- `terminal-ws`、`viewer-ws`、`devtools` 的现有 ticket 校验行为不变。

### 2. 新增 completion event service

任务：

- 新增 `TerminalCompletionEventService`。
- `TerminalCompletionEventStore` 增加或暴露 `getLatestId()` 所需能力。
- record 后通知 listener；listener 抛错不影响 record。

验证：

```bash
pnpm --filter ./backend test -- terminal-completion
```

预期：

- completion event 仍能通过 `/internal/terminal-completion` 写入。
- `listAfter(after)` 行为保持不变。

### 3. 新增 `/ws/terminal-events`

任务：

- 新增 handshake 校验。
- 新增 `attachTerminalEventsWebSocketServer(...)`。
- `backend/src/index.ts` 中 attach 该 server。
- 建连发送 `connected`。
- 带 `after` 时发送一次 catch-up。
- 订阅 service 并实时发送 live event。

验证：

```bash
pnpm --filter ./backend test -- terminal-events terminal-completion
```

预期：

- 无 ticket / 错 ticket / token type 不匹配时 WebSocket 被拒绝。
- 合法 ticket 能连接。
- record 新事件后，在线 socket 收到 `completion-event`。
- 带 `after` 重连能收到遗漏的 `completion-events`。

### 4. 新增 ticket API 和前端 service

任务：

- 后端新增 `POST /api/terminal/completion-events/ws-ticket`。
- 前端新增 `createTerminalEventsWsTicket()`。
- E2E 测试环境继续使用现有 access token 换 ticket。

验证：

```bash
pnpm --filter ./backend test -- terminal
pnpm --filter ./frontend typecheck
```

预期：

- 登录态成功换取 ticket。
- 未登录返回 `401`。
- ticket 不能用于 `/ws/terminal`。

### 5. 前端接入实时事件并删除轮询

任务：

- 新增 `useTerminalEventsConnection()`。
- `TerminalWorkspace` 使用该 hook。
- 删除 completion polling effect 和 `BASE_INTERVAL` / `MAX_INTERVAL` 退避逻辑。
- 抽出 `applyCompletionEvents()`，统一处理 catch-up 和 live event。
- live event 播放完成音，catch-up 不播放。

验证：

```bash
pnpm --filter ./frontend typecheck
```

手工检查：

```bash
rg "completion-events" frontend/src/components/terminal frontend/src/features/terminal frontend/src/services/terminal -n
rg "BASE_INTERVAL|MAX_INTERVAL|pollCompletionEvents" frontend/src/components/terminal/terminal-workspace.tsx -n
```

预期：

- `TerminalWorkspace` 不再有 completion polling effect。
- `frontend/src/services/terminal.ts` 仍保留 HTTP list API 和新增 ticket API。

### 6. 调整 completion 写入门禁

任务：

- `terminal-completion.ts` 不再因为 `session.activeCommand` 已清空而直接忽略真实 late hook event。
- 增加最近 AI active command 记录和 `AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS = 30_000` grace window。
- 写入 completion event 前必须调用集中匹配函数，确认 source 与当前 AI command 或 grace window 内的最近 AI command 匹配。
- source 不在 allowlist 时仍忽略。
- 日志保留 `activeCommand`、`lastAiActiveCommand`、`lastAiActiveCommandClearedAt`、`source`、`rawHookEvent`、`terminalSessionId`。

验证：

```bash
pnpm --filter ./backend test -- terminal-completion
```

预期：

- `activeCommand` 当前匹配 source 时，event 能被记录。
- `activeCommand: null` 但最近 AI active command 在 30 秒 grace window 内匹配 source 时，event 能被记录。
- `activeCommand: null` 且没有匹配的最近 AI active command，或最近匹配超过 30 秒时，event 被忽略。
- `activeCommand` 当前为不匹配的另一个命令时，event 被忽略。
- source 不合法时仍不记录。
- token 不合法时仍返回 `401`。

### 7. E2E 覆盖实时绿点

修改文件：

```text
frontend/tests/terminal.spec.ts
```

建议用例：

1. 打开两个 terminal。
2. 当前停留在 terminal A。
3. 对 terminal B 调用 `/internal/terminal-completion` 模拟 hook event。
4. 断言 terminal B tab 或 project tab 在短时间内显示 completion marker。
5. 切到 terminal B 后 marker 消失。

断言要求：

- 不等待 2s 轮询窗口；优先使用较短 timeout，例如 `1000ms` 到 `1500ms`。
- 不依赖普通 shell 命令结束。

验证：

```bash
pnpm --filter ./frontend exec playwright test tests/terminal.spec.ts --grep "completion"
```

预期：

- completion marker 能实时出现。
- active terminal 不显示未读 marker。

### 8. 全量验证

命令：

```bash
pnpm typecheck
pnpm lint
pnpm --filter ./backend test -- terminal-completion terminal
pnpm --filter ./frontend exec playwright test tests/terminal.spec.ts --grep "completion"
```

预期：

- 所有命令通过。
- 无新增前端 Vitest 单测。
- `git diff` 中没有 Windows 打包、无关 UI 重构或无关格式化。

## 验收标准

- 非当前 terminal 的 AI completion event 能在 WebSocket live event 到达后立即点亮绿点。
- 页面空闲超过 `30s` 后，任务完成也不再等待轮询退避。
- WebSocket 断线期间产生的 completion event，重连后通过 `after` catch-up 补齐。
- 当前 active terminal 收到 completion event 不显示未读绿点。
- 切到有绿点的 terminal 后，绿点消失。
- 切换 `apiBase` / backend connection 后，不串用旧 backend 的 marker 或 cursor。
- `GET /api/terminal/completion-events` 保留，但 `TerminalWorkspace` 不再定时调用它。
- 后端拒绝未授权 WebSocket、错误 ticket type 和错误 token。
- completion hook 在 `activeCommand` 清空后的 30 秒 grace window 内到达时，仍能记录并推送事件。
- completion hook 在没有当前或最近匹配 AI command 的情况下到达时，后端拒绝记录，避免 source-only 误报。
- ticket API 生成 baseline 之后、WebSocket 建连之前产生的 completion event 不会被首连 baseline 吞掉。

## 风险与取舍

- 新增 workspace 级 WebSocket 会多一个长连接，但消息低频，成本远低于轮询。
- event store 仍是内存队列，backend 重启期间的 completion event 不可恢复；这是当前绿点提醒语义可接受的边界。
- 如果前端断线时间过长且事件超过 store 的 `MAX_COMPLETION_EVENTS` 保留窗口，catch-up 可能漏事件。当前 store 上限是 200 条，第一阶段不扩展持久化。
- `activeCommand` hard gate 改为“当前匹配或 30 秒 grace window 内最近匹配”。这个窗口过短会漏掉异常延迟的真实 hook，过长会增加旧进程误报风险；第一阶段固定为 30 秒，后续如果有日志证据再调整。
- 如果同时运行多个 backend，tmux pane 内的 `RUNWEAVE_HOOK_ENDPOINT` 必须仍指向创建该 pane 的 backend。现有 backend 启动时会 pin endpoint 到当前监听端口，本计划不改变这条边界。

## 回滚方案

- 保留 `GET /api/terminal/completion-events` 和 `TerminalCompletionEventStore.listAfter()`。
- 如果 WebSocket 方案上线后出现阻塞问题，可以临时恢复 `TerminalWorkspace` 中旧的 polling effect。
- 回滚不需要迁移数据，因为 completion event 没有持久化 schema。
