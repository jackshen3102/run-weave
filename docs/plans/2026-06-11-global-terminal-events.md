# 全局 Terminal Events 推送改造计划

## 背景

当前 Runweave 已经有两类终端 WebSocket：

- `/ws/terminal`：单个 terminal 的详情通道，负责 snapshot、output、input、resize、signal、metadata、runtime status。
- `/ws/terminal-events`：全局 terminal 事件通道，当前主要承载 completion event，用于 Web 工作区里的后台终端完成标记，也就是“小绿点”。

App 终端详情页当前为了判断 Codex 是否在运行，会每 2 秒调用：

```text
GET /api/terminal/session/:terminalSessionId/state
```

这带来两个问题：

- App 侧出现大量 `app terminal state request started/completed` 诊断日志。
- 状态同步是单 terminal 轮询，不符合后续“全局事件通知”的方向。

新的设计要求：

- Terminal state 变化必须走 `/ws/terminal-events`。
- 推送必须是全局的，不只推当前 terminal。
- Web 和 App 共享同一个事件通道与事件模型。
- 后续事件通知也要挂在这条全局事件流上。
- `/ws/terminal` 继续保持单 terminal I/O 通道职责，不新增 agent state 推送职责。

## 目标

1. 将 `/ws/terminal-events` 从 completion-only 推送升级为全局 terminal event bus。
2. 将 Codex terminal state 变化作为全局事件推送，覆盖所有 terminal。
3. Web 端继续通过同一通道驱动小绿点，并能接收未来新增的状态和通知事件。
4. App 端接入 `/ws/terminal-events`，用全局状态事件替代 2 秒 HTTP 轮询。
5. 保留 `/api/terminal/session/:id/state` 作为调试、CLI 或兜底查询接口。

## 非目标

- 不把 `terminal_state_changed` 挂到 `/ws/terminal`。
- 不删除 `/ws/terminal` 现有 snapshot/output/input/resize/signal/metadata/status 能力。
- 不在前端 `src/` 或 App React hook 下新增 Vitest 单测。
- 不重写终端 runtime、tmux、PTY、shell integration 的主体逻辑。
- 不在本阶段引入持久化数据库；沿用当前内存事件队列和 cursor catchup 模式。
- 不改 Codex hook 协议本身，只消费已有 `SessionStart`、`UserPromptSubmit`、`Stop`。

## 当前代码基线

- `packages/shared/src/terminal-protocol.ts`
  - 已有 `TerminalCompletionEvent`。
  - 已有 `TerminalEventServerMessage`，当前只支持 `completion-events` 和 `completion-event`。
  - 已有 `TerminalState`、`TerminalStateResponse`、`AgentHookStateRequest`。

- `backend/src/terminal/completion-event-service.ts`
  - 当前是 completion event 的内存队列和订阅服务。
  - 支持 `record()`、`listAfter()`、`subscribe()`。

- `backend/src/ws/terminal-events-server.ts`
  - 当前监听 `/ws/terminal-events`。
  - 建连后发送 `connected` 和 `completion-events` catchup。
  - 订阅 completion event live 推送。

- `backend/src/routes/terminal.ts`
  - `POST /api/terminal/completion-events/ws-ticket` 当前返回 `baselineEventId`。
  - 该 baseline 来自 `options.completionEventService?.getLatestId()`，语义是 completion-only。
  - 全局事件改造后必须迁移为 `TerminalEventService.getLatestId()`，否则新连接默认 cursor 会漏掉 state/notification 事件，或在 reconnect/catchup 时出现错误 replay。

- `frontend/src/features/terminal/use-terminal-events-connection.ts`
  - 当前只处理 `completion-events` 和 `completion-event`。
  - Web 工作区用它更新 completion marker。

- `frontend/src/components/terminal/terminal-workspace.tsx`
  - `applyCompletionEvents()` 根据 completion events 给非当前 session 打 marker。

- `app/src/pages/AppTerminalPage.tsx`
  - 当前用 HTTP polling 刷新 `TerminalState`。
  - `TerminalState` 驱动停止按钮和 slash command 输入模式。

## 事件模型

### 统一事件 Envelope

在 `packages/shared/src/terminal-protocol.ts` 新增全局事件 envelope。

```ts
export type TerminalEventKind =
  | "completion"
  | "terminal_state_changed"
  | "terminal_notification";

export interface TerminalEventEnvelope {
  id: string;
  kind: TerminalEventKind;
  terminalSessionId: string;
  projectId: string | null;
  createdAt: string;
  payload:
    | TerminalCompletionEventPayload
    | TerminalStateChangedEventPayload
    | TerminalNotificationEventPayload;
}
```

### Completion Payload

现有 `TerminalCompletionEvent` 的业务字段迁入 payload。为了降低迁移风险，第一阶段可以保留 `TerminalCompletionEvent` 类型作为兼容别名或转换输入，但 `/ws/terminal-events` 对外统一发送 envelope。

```ts
export interface TerminalCompletionEventPayload {
  source: "claude" | "codex" | "trae" | "unknown";
  completionReason: TerminalCompletionReason;
  commandName: string | null;
  rawHookEvent: string | null;
  hookEvent: string;
  cwd: string | null;
}
```

### Terminal State Payload

```ts
export type TerminalStateChangeReason =
  | "agent_hook"
  | "metadata"
  | "interrupt"
  | "exit";

export interface TerminalStateChangedEventPayload {
  previous: TerminalState;
  next: TerminalState;
  reason: TerminalStateChangeReason;
}
```

### Notification Payload

```ts
export interface TerminalNotificationEventPayload {
  level: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  source: "codex" | "terminal" | "system";
  dedupeKey?: string;
  action?: {
    type: "open_terminal";
    terminalSessionId: string;
  };
}
```

### WebSocket Message

将 `TerminalEventServerMessage` 泛化：

```ts
export type TerminalEventServerMessage =
  | {
      type: "connected";
      acceptedAfter: string | null;
    }
  | {
      type: "terminal-events";
      delivery: "catchup";
      events: TerminalEventEnvelope[];
    }
  | {
      type: "terminal-event";
      delivery: "live";
      event: TerminalEventEnvelope;
    }
  | {
      type: "error";
      message: string;
    };
```

兼容策略：

- 不再新增 `completion-events` 和 `completion-event` 的新消费者。
- 第一阶段可以让 server 同时发送旧 completion message 和新 generic message，或一次性迁移 Web consumer。
- 推荐一次性迁移 Web consumer，避免同一事件被处理两次。

## 后端实施计划

### 1. 引入全局 TerminalEventService

文件范围：

- 新增或重命名：`backend/src/terminal/terminal-event-service.ts`
- 调整：`backend/src/terminal/completion-event-service.ts`
- 调整：`backend/src/index.ts`

职责：

- 分配全局递增 `id`。
- 保存最近事件内存队列。
- 提供 `record(input)`、`listAfter(after)`、`subscribe(listener)`。
- 对所有事件类型使用同一个 cursor 空间。

建议接口：

```ts
export class TerminalEventService {
  record(
    input: Omit<TerminalEventEnvelope, "id" | "createdAt">,
  ): TerminalEventEnvelope;
  listAfter(after: string | null): TerminalEventEnvelope[];
  subscribe(listener: (event: TerminalEventEnvelope) => void): () => void;
  getLatestId(): string | null;
}
```

验收：

- completion、terminal state、notification 三类事件共享递增 id。
- `listAfter("N")` 只返回 id 大于 N 的事件。
- `subscribe()` 收到所有 kind 的 live event。
- `getLatestId()` 返回全局事件队列中的最新 envelope id，不是 completion-only id。

### 2. 改造 completion 记录

文件范围：

- `backend/src/routes/terminal-completion.ts`
- `backend/src/terminal/completion-event-service.ts`
- `backend/src/ws/terminal-events-server.ts`
- `packages/shared/src/terminal-protocol.ts`

要求：

- `/internal/terminal-completion` 继续接受当前请求体。
- 记录时生成 `kind: "completion"` 的 `TerminalEventEnvelope`。
- response 可以短期继续返回 `{ event }`，但 `event` 应该是 envelope，或同时带兼容字段。
- Web 小绿点逻辑改为读取 `event.kind === "completion"`。

验收：

- 后台 terminal completion 后，Web 端非当前 session 仍出现小绿点。
- 重连 `/ws/terminal-events` 后，catchup 能拿到 completion envelope。

### 3. TerminalStateService 发布状态变更事件

文件范围：

- `backend/src/terminal/terminal-state-service.ts`
- `backend/src/routes/terminal-state.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/ws/terminal-server.ts`
- `backend/src/index.ts`

要求：

- `TerminalStateService` 保持唯一状态判定入口。
- `handleAgentHook()`、`setShellActiveCommand()`、interrupt、exit 等状态变化路径必须走同一个去重发布逻辑。
- 只有 `previous` 和 `next` 不同时记录 `terminal_state_changed`。
- 事件里必须带 `terminalSessionId` 和可获得的 `projectId`。

建议实现：

```ts
type TerminalStatePublishContext = {
  projectId: string | null;
  reason: TerminalStateChangeReason;
};

private setAndPublish(
  terminalSessionId: string,
  next: TerminalState,
  context: TerminalStatePublishContext,
): TerminalState {
  const previous = this.getStoredOrShellIdle(terminalSessionId);
  const saved = this.store.set(terminalSessionId, next);
  if (previous.state !== next.state || previous.agent !== next.agent) {
    this.eventService.record({
      kind: "terminal_state_changed",
      terminalSessionId,
      projectId: context.projectId,
      payload: { previous, next, reason: context.reason },
    });
  }
  return saved;
}
```

注意：

- `getCurrent()` 不应发布事件，它是只读查询。
- `session.status === "exited"` 仍然硬判为 `shell_idle`。
- metadata 导致 `activeCommand` 从非 Codex 变成 Codex 时，发布 `agent_idle`。
- Codex hook `UserPromptSubmit` 发布 `agent_running`。
- Codex hook `Stop`、interrupt 成功后发布 `agent_idle`。
- session exit 发布 `shell_idle`。

验收：

- 同一个状态重复设置不产生重复事件。
- `UserPromptSubmit` 产生 `agent_running` 全局事件。
- `Stop` 或 interrupt 产生 `agent_idle` 全局事件。
- 非 Codex session 不误发 Codex 状态事件。

### 4. 改造 `/ws/terminal-events`

文件范围：

- `backend/src/ws/terminal-events-server.ts`
- `backend/src/ws/terminal-events-server.test.ts`
- `backend/src/ws/terminal-events-handshake.ts`
- `backend/src/routes/terminal.ts`

要求：

- 继续使用现有 ticket、`after` cursor、auth 和 tunnel auth。
- `POST /api/terminal/completion-events/ws-ticket` 的 `baselineEventId` 必须改为来自 `TerminalEventService.getLatestId()`。
- 如果接口路径短期仍保留 `completion-events/ws-ticket`，返回 payload 语义也必须是全局 terminal events baseline，不允许继续使用 completion-only baseline。
- 如新增更准确的别名路径，例如 `/api/terminal/events/ws-ticket`，旧路径必须保持兼容并返回同一个全局 baseline。
- 建连后发送：

```ts
{ type: "connected", acceptedAfter }
{ type: "terminal-events", delivery: "catchup", events: service.listAfter(after) }
```

- live 时发送：

```ts
{ type: "terminal-event", delivery: "live", event }
```

验收：

- `after` cursor 对所有事件 kind 生效。
- 新 ticket 的 `baselineEventId` 等于全局 `TerminalEventService.getLatestId()`。
- 在 ticket 创建之后、WebSocket 建连之前产生的 state/notification 事件，建连时能通过 `after=baselineEventId` catchup 收到。
- 在 ticket 创建之前已经存在的 state/notification 事件，不会被新连接默认 replay。
- 一个 WebSocket 连接能收到不同 terminal 的事件。
- 未授权连接仍然按当前逻辑关闭。

## 前端 Web 实施计划

### 5. 泛化 useTerminalEventsConnection

文件范围：

- `frontend/src/features/terminal/use-terminal-events-connection.ts`
- `frontend/src/components/terminal/terminal-workspace.tsx`

要求：

- `useTerminalEventsConnection` 不再暴露 completion-only callback。
- 改为暴露 `onEvents(events, delivery)` 或拆分后的 callbacks。
- 内部 cursor 仍以 envelope `id` 去重和推进。
- `terminal-events` catchup 和 `terminal-event` live 都走同一个去重逻辑。

建议接口：

```ts
onTerminalEvents: (
  events: TerminalEventEnvelope[],
  delivery: "catchup" | "live",
) => void;
```

### 6. 保持小绿点行为

文件范围：

- `frontend/src/components/terminal/terminal-workspace.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`

要求：

- `kind === "completion"` 时沿用当前 marker 逻辑。
- 只给非当前 active terminal 打 completion marker。
- 未知 kind 不应导致报错。

验收：

- Web 端后台 terminal completion 后小绿点仍出现。
- active terminal 的 completion 不打小绿点。
- catchup completion 不播放声音，live completion 保持当前声音策略。

### 7. 接收全局 terminal state

文件范围：

- `frontend/src/components/terminal/terminal-workspace.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`，仅在本阶段需要展示状态时调整

要求：

- 不扩展 `TerminalSessionListItem`，不修改 `/api/terminal/session` 列表 payload 合约。
- Web workspace 维护独立的 `terminalStateBySessionId` 状态表：

```ts
const [terminalStateBySessionId, setTerminalStateBySessionId] = useState<
  Record<string, TerminalState>
>({});
```

- 收到 `kind === "terminal_state_changed"` 时，只更新 `terminalStateBySessionId[event.terminalSessionId]`。
- 如果后续 Web UI 要展示 agent 状态，通过 `terminalStateBySessionId[session.terminalSessionId]` 读取，不把实时状态塞进 `sessions` 数组。
- 新增或刷新 sessions 时，可以保留已有 state map；删除 session 时同步清理对应 key。
- 不要求本阶段一定改变 Web UI 展示，但 `terminalStateBySessionId` 要可被后续组件消费。
- 不影响现有 `metadata` 更新 cwd / activeCommand 的路径。

验收：

- 非当前 terminal 的 state event 也能更新 `terminalStateBySessionId`。
- `TerminalSessionListItem` 类型和 `/api/terminal/session` 响应不新增 `terminalState` 字段。
- state event 不影响 terminal output 渲染。

## App 实施计划

### 8. App 接入 `/ws/terminal-events`

文件范围：

- 新增：`app/src/hooks/use-app-terminal-events-connection.ts`
- 调整：`app/src/pages/AppTerminalPage.tsx`
- 调整：`app/src/services/terminal.ts`

要求：

- App 新增全局 terminal events 连接，使用与 Web 一致的 ticket 接口。
- 如果 `createTerminalEventsWsTicket` 只在 Web service 中存在，需要迁移或复制到 App service，保持接口一致。
- AppTerminalPage 删除 2 秒 `/state` polling。
- AppTerminalPage 初始状态可以从页面已有 `initialSession.terminalState` 或一次性 `/state` 查询获得；后续状态必须由 events 推送更新。
- 当前详情页只用匹配当前 `terminalSessionId` 的 `terminal_state_changed` 驱动 Stop/Send 和 slash command。
- 其它 terminal 的事件可以先缓存到 App session map，供首页列表后续消费。

验收：

- App terminal detail 不再每 2 秒请求 `/state`。
- Codex `UserPromptSubmit` 后，App 当前详情页按钮切到 stop。
- Codex `Stop` 或 interrupt 后，App 当前详情页按钮回到 send。
- 其它 terminal 的状态事件不会被当前详情页误用。

## 通知事件实施计划

### 9. 增加 terminal_notification 记录能力

文件范围：

- `packages/shared/src/terminal-protocol.ts`
- `backend/src/terminal/terminal-event-service.ts`
- 后续具体业务入口按需求接入

要求：

- 本阶段只建立事件类型和服务能力。
- 不强制实现完整通知中心 UI。
- 对需要用户感知的事件，可以记录 `terminal_notification` envelope。

验收：

- 后端可以记录 notification envelope。
- `/ws/terminal-events` live 和 catchup 都能传输 notification。
- Web/App 未实现 UI 时，未知或未消费 notification 不报错。

## 验证计划

### 自动化验证

运行：

```bash
pnpm typecheck
pnpm test -- backend/src/ws/terminal-events-server.test.ts backend/src/terminal/terminal-state-service.test.ts backend/src/routes/terminal-state.test.ts
```

预期：

- TypeScript 类型检查通过。
- terminal events server 测试覆盖 generic envelope、catchup、live、auth。
- terminal state service 测试覆盖状态去重、agent hook、metadata、exit。
- terminal state route 测试仍通过，证明 HTTP `/state` 查询保留。

### Web 手工验证

必须使用 `$playwright-cli`。

步骤：

1. 启动 `pnpm dev`。
2. 打开 Web terminal workspace。
3. 建立两个 terminal。
4. 在后台 terminal 触发 completion event。
5. 验证小绿点仍出现在后台 terminal。
6. 在一个 terminal 中触发 Codex `UserPromptSubmit` 和 `Stop`。
7. 验证 `/ws/terminal-events` Network message 中出现 `terminal_state_changed`，且包含正确 `terminalSessionId`。

失败判断：

- 小绿点不出现，说明 completion 兼容迁移失败。
- state event 只在当前 terminal 出现，说明全局事件流没有覆盖所有 terminal。
- `/ws/terminal` 出现 `terminal_state_changed`，说明职责边界实现错误。

### App 手工验证

必须使用 `$playwright-cli` 或项目已有 App 调试方式；涉及浏览器操作时只能使用 `$playwright-cli`。

步骤：

1. 启动 App 本地流程。
2. 打开 terminal detail。
3. 观察 Network，不应看到持续 2 秒一次的 `/api/terminal/session/:id/state`。
4. 触发 Codex running 状态。
5. 验证当前 detail 的 composer 按钮切换为 stop。
6. 触发 Codex stop 或点击 stop。
7. 验证 composer 按钮回到 send。

失败判断：

- `/state` 仍持续轮询，说明旧 effect 未删除。
- 非当前 terminal state event 改变当前详情页按钮，说明过滤错误。
- WS 断线后无法恢复状态，说明 catchup cursor 或重连逻辑有缺口。

## 风险和回滚

- 风险：一次性泛化 `TerminalEventServerMessage` 会影响 Web 小绿点。
  - 缓解：优先补 `terminal-events-server` 和 `useTerminalEventsConnection` 的类型与行为测试。

- 风险：状态事件重复发布导致 UI 抖动。
  - 缓解：`TerminalStateService` 统一做 previous/next 去重。

- 风险：App 初始状态在 WS 连接前短暂不准确。
  - 缓解：保留初始 session payload 或一次性 `/state` 查询；禁止恢复周期轮询。

- 风险：全局事件过多导致内存队列增长。
  - 缓解：沿用当前 completion event 队列的 bounded buffer 策略，明确最大保留数量。

回滚方式：

- 保留 `/api/terminal/session/:id/state`，必要时可以临时恢复 App 单次查询或短期轮询。
- `/ws/terminal` 不参与本次状态推送，回滚不会影响终端 I/O。

## 验收标准

- `/ws/terminal-events` 成为 completion、terminal state、notification 的统一全局事件通道。
- Web 小绿点行为不回退。
- App terminal detail 不再周期轮询 `/state`。
- 任意 terminal 的 state 变化都会以全局事件发送，Web/App 都能收到。
- `/ws/terminal` 不新增 `terminal_state_changed` 事件。
- HTTP `/state` 接口保留且可用于调试或兜底。
