# Codex 中断状态补偿校准方案

> 状态：已被 App Server 下沉方案取代。当前实现不再由 backend 启动
> `CodexInterruptStateReconciler`；补偿轮询位于 App Server，发现 Codex thread
> 状态不一致时追加同协议 `agent.hook Stop` 补偿事件。当前架构以
> `docs/architecture/app-server-architecture.md` 的 “Codex Thread 状态补偿” 为准。

## 目标

在现有 Hook 事件偶发不可靠时，为 Codex 终端的中断状态增加一个 backend 侧补偿校准机制：

1. 只处理当前终端执行命令为 `codex` 的 session。
2. 只处理最近 3 小时内活跃的 session。
3. 从 CodeDesk App Server 的 Event Center 拉取最新 `agent.hook` / `agent.completion` 事件。
4. 将 App Server 事件推导出的 Codex 状态与 backend 当前数据库状态比对。
5. 发现差异时，写回 `TerminalStateService` / session store，并通过现有 `/ws/terminal-events` 推送 `terminal_state_changed`，让 App 与 Web 客户端刷新。

## 非目标

- 不处理 shell idle 状态。`activeCommand=null` 或当前命令不是 `codex` 的 session 直接跳过。
- 不处理 `trae`、`traecli`、`traex` 或其它 agent。
- 不新增单元测试文件。本仓库正式自动化测试以 Playwright E2E 为主；该方案第一阶段可通过 typecheck/lint 与手工 App Server 事件验证。
- 不新增 App Server “按 session 查询状态”的 API。当前 App Server 已有事件日志查询能力，第一阶段应复用它。
- 不改变 `POST /api/terminal/session/:id/interrupt` 的现有行为；该接口当前仍负责发送 ESC，并在当前 session 有 agent 时写入一次 `Stop` 状态。

## 当前代码事实

### 本地状态模型

- `TerminalState` 只有四类状态：`shell_idle`、`agent_starting`、`agent_idle`、`agent_running`，agent 类型包含 `codex`、`trae`、`traex`、`traecli`。定义在 `packages/shared/src/terminal-protocol.ts`。
- `TerminalStateService.handleAgentHook()` 已经把 `UserPromptSubmit` 映射为 `agent_running`，把其它 hook 映射为 `agent_idle`。实现位置：`backend/src/terminal/terminal-state-service.ts`。
- `TerminalStateService.setAndPublish()` 在状态变化时会：
  - 写入 `TerminalStateStore`；
  - 调用 `onStateChange`，当前 wired 到 `terminalSessionManager.updateSessionTerminalState()`；
  - 如果传入 context，则记录 `terminal_state_changed` 事件。
- backend 初始化时已经把 `onStateChange` 接到 session store：`backend/src/index.ts` 创建 `TerminalStateService` 时传入 `terminalSessionManager.updateSessionTerminalState()`。

### 客户端推送链路

- `TerminalEventService.record()` 会把事件放入内存事件队列并同步通知 listener。
- `/ws/terminal-events` 会订阅 `TerminalEventService`，向连接的客户端发送 live event，并在连接时发送 catchup events。实现位置：`backend/src/ws/terminal-events-server.ts`。
- Web 端 `frontend/src/components/terminal/terminal-workspace-events.ts` 已消费 `terminal_state_changed` 并更新 `terminalStateBySessionId`。
- App 端 `app/src/hooks/use-app-session.ts` 已按 `terminal_state_changed` 更新 App terminal overview 中的 `terminalState` 与展示状态。

结论：补偿任务只要通过 `TerminalStateService` 产生带 context 的状态变更，就能自然复用当前 DB 写入与 Web/App 推送链路。

### App Server 能力

- backend 已有 `AppServerClient.listEvents({ after, kinds, limit })`，通过 `GET /events?after=...&kind=...&limit=...` 拉取事件。
- App Server HTTP 层已支持：
  - `POST /events`
  - `GET /events`
  - `GET /events/latest`
- App Server event store 默认保留 7 天事件，`GET /events` 单次最多返回 500 条。
- backend 当前已经有 `AppServerEventConsumer` 通过 WebSocket 增量消费 `agent.hook` 与 `agent.completion`，并调用 `handleAgentHookEvent()` / `handleAgentCompletionEvent()`。

结论：补偿校准不需要直接读 App Server 的文件或 SQLite，也不需要 import `app-server/src/*`。backend 只能通过 App Server HTTP/WS 协议访问事件。

### 当前中断兼容逻辑

`POST /api/terminal/session/:id/interrupt` 当前会：

1. 向终端发送 ESC。
2. 如果当前 session 能识别出 agent，则调用 `TerminalStateService.handleAgentHook(session.id, agent, "Stop", { reason: "interrupt" })`。

这说明现有代码已经有“中断后本地乐观写 idle”的临时兼容。新增补偿机制的职责不是替代 interrupt API，而是在 Hook/App Server 事件漏消费、WS 断线或 backend cursor 漏推进后，把状态重新校准回来。

## 推荐方案

新增一个 backend 侧 `CodexInterruptStateReconciler`，作为 App Server event consumer 的低频兜底。

它不维护独立中断表，使用当前已有 terminal session 数据作为“中断列表”的事实来源：

- `TerminalSessionManager.listSessions()`
- `TerminalSessionRecord.status`
- `TerminalSessionRecord.activeCommand`
- `TerminalSessionRecord.lastActivityAt`
- `TerminalSessionRecord.terminalState`

### 筛选规则

每轮只纳入满足以下条件的 session：

1. `session.status === "running"`
2. `session.activeCommand` 的 basename 是精确 `codex`
3. `session.lastActivityAt >= now - 3h`
4. `terminalStateService.getCurrent(session.id, session)` 当前为 `{ state: "agent_running", agent: "codex" }`

第 4 条是范围收缩：只有客户端会展示 Stop / 中断态的 Codex running session 才需要补偿。`agent_idle/codex`、`agent_starting/codex`、`shell_idle/null` 都不在第一阶段处理。

### 拉取规则

第一阶段不按 session 单独调用 App Server。每轮用同一个 App Server client 拉取：

```ts
client.listEvents({
  after: cursor,
  kinds: ["agent.hook", "agent.completion"],
  limit: 500,
});
```

cursor 建议复用 `AppServerEventCursorStore`，但使用独立 consumer id，例如：

```ts
codex - interrupt - state - reconciler;
```

不能复用现有 `APP_SERVER_AGENT_EVENT_CONSUMER_ID`，否则会和实时 consumer 互相推进 cursor。

如果本轮存在候选 session，但 cursor 后事件超过 500 条，应循环分页直到：

- 返回事件数量小于 500；或
- 已处理到 `latestEventId`；或
- 达到单轮最大页数，例如 10 页。

### 事件解释规则

只考虑同时满足以下条件的事件：

1. `event.scope?.terminalSessionId` 命中候选 session。
2. `event.payload.source === "codex"`。
3. event 类型是：
   - `agent.hook` 且 hook 可解释为 `UserPromptSubmit` 或 `Stop`；
   - `agent.completion` 且 `completionReason === "hook_stop"`，并且 raw hook event 可解释为 stop。

状态推导：

- `agent.hook` + `UserPromptSubmit` -> `{ state: "agent_running", agent: "codex" }`
- `agent.hook` + `Stop` -> `{ state: "agent_idle", agent: "codex" }`
- `agent.completion` + `hook_stop` -> `{ state: "agent_idle", agent: "codex" }`

同一个 session 在同一轮出现多条事件时，以 App Server event id 最大的事件为准。App Server event id 是递增数字字符串，现有 event store 用 `nextId` 递增生成。

### 比对与写入规则

对每个候选 session：

1. 找到该 session 最新可解释事件。
2. 如果没有事件，跳过。
3. 如果事件推导状态等于当前本地状态，跳过。
4. 如果事件推导状态为 `agent_idle/codex`，且本地当前仍是 `agent_running/codex`，调用：

```ts
terminalStateService.handleAgentHook(session.id, "codex", "Stop", {
  projectId: session.projectId,
  reason: "agent_hook",
});
```

5. 如果事件推导状态为 `agent_running/codex`，第一阶段不建议由 reconciler 主动从 idle/start 推到 running，因为本方案的目标是修复“中断后仍显示 running”。需要恢复 running 的场景仍由实时 `UserPromptSubmit` hook 负责。

这样做的好处是：

- 写 DB 仍走 `TerminalStateService` 的现有路径。
- 推送仍走 `terminal_state_changed`，Web/App 无需改协议。
- 不绕过 `TerminalStateService`，避免 store 与 event service 状态不一致。

### 定时策略

建议参数：

- 启动延迟：backend 连接 App Server 成功后 10 秒启动。
- 周期：30 秒。
- 活跃窗口：3 小时。
- 单轮最大事件页数：10 页。
- 单轮最大候选 session：100 个。超过时按 `lastActivityAt` 降序取最新 100 个。
- App Server 不可用：记录 warn/debug，不影响 backend 启动。

### 并发与幂等

- reconciler 内部必须有 `running` 标记；上一轮未结束时跳过下一轮。
- 事件处理必须幂等：当前状态等于目标状态时不写库、不发事件。
- cursor 只能在一页事件完成处理后推进到该页最后一个 event id。
- 如果处理某页失败，不推进 cursor，下轮重试。

## 文件范围

### 新增

- `backend/src/app-server/codex-interrupt-state-reconciler.ts`
  - 定时任务主体。
  - 筛选候选 Codex session。
  - 调用 `AppServerClient.listEvents()`。
  - 从事件推导最新状态。
  - 调用 `TerminalStateService` 写入状态。

### 修改

- `backend/src/index.ts`
  - 在 App Server 连接成功后创建并启动 reconciler。
  - 在 backend shutdown / service dispose 时停止 reconciler。
  - 注意不要影响现有 `AppServerEventConsumer`。

- `backend/src/app-server/handlers/agent-hook.ts`
  - 可选：抽出 hook payload 解析 helper，避免 reconciler 重写一份解析逻辑。

- `backend/src/app-server/handlers/agent-completion.ts`
  - 可选：抽出 completion payload 解析 helper，避免 reconciler 重写一份解析逻辑。

### 不修改

- `packages/common/*`
- `packages/shared/*`，除非执行时发现必须新增 `TerminalStateChangeReason`。第一阶段可以复用 `"agent_hook"`，不需要扩协议。
- Web/App 客户端代码。现有 `terminal_state_changed` 消费链路已经满足刷新需求。
- `app-server/src/*`。当前事件 API 足够。

## 验收标准

### 静态验证

```bash
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
```

如果当前包名或脚本不同，以 `package.json` 中实际 backend 包名为准。

### 行为验证

1. 启动 backend 与 App Server。
2. 创建一个当前 `activeCommand=codex` 的 terminal session。
3. 让本地 DB 中该 session 保持 `agent_running/codex`。
4. 向 App Server 写入属于该 session 的 `agent.completion` 事件：
   - `kind: "agent.completion"`
   - `scope.terminalSessionId` 为该 session id
   - `payload.source: "codex"`
   - `payload.completionReason: "hook_stop"`
   - `payload.rawHookEvent: "Stop"`
5. 等待 reconciler 下一轮执行。
6. 预期：
   - backend session 的 `terminalState` 更新为 `agent_idle/codex`；
   - `/ws/terminal-events` 客户端收到 `terminal_state_changed`；
   - Web terminal tab 的 working/Stop 状态消失；
   - App overview 中对应 terminal 的 display status 从 running 变为 idle。

### 负向验证

以下场景必须不更新状态：

- session `activeCommand=null`。
- session `activeCommand="zsh"`、`"bash"`、`"node"` 或其它非 `codex` 命令。
- session 当前为 `agent_idle/codex`。
- session `lastActivityAt` 早于 3 小时。
- App Server 事件 `payload.source !== "codex"`。
- App Server 事件没有 `scope.terminalSessionId` 或 session 不属于当前 backend。

## 风险与控制

### 风险：把旧事件重放成错误状态

控制：

- 独立 cursor 只向前推进。
- 每轮只处理最近 3 小时活跃 session。
- 只从 `agent_running/codex` 收敛到 `agent_idle/codex`，不从 idle 推 running。

### 风险：和实时 consumer 重复处理

控制：

- 状态写入前比较当前状态。
- `TerminalStateService.setAndPublish()` 本身只在状态变化时发布事件。
- reconciler 使用独立 cursor，不抢现有 consumer cursor。

### 风险：App Server 事件很多导致单轮过重

控制：

- `limit=500`。
- 单轮最多 10 页。
- 候选 session 最多 100 个。
- 上一轮未结束则跳过下一轮。

### 风险：shell idle 被误修正

控制：

- 明确要求 `activeCommand` 当前 basename 为 `codex`。
- `activeCommand=null` 不使用 `lastAiActiveCommand` grace window。
- 不调用 `processTerminalAgentHook()` 的宽松路径；reconciler 应在自己的候选筛选中先排除非当前 Codex session。

## 建议实施顺序

1. 抽出或复用 `agent.hook` / `agent.completion` payload 解析逻辑。
2. 新增 `CodexInterruptStateReconciler`，只实现 dry-run 日志与候选筛选。
3. 接入 App Server `listEvents()`，实现分页与独立 cursor。
4. 实现事件到 `agent_idle/codex` 的保守收敛。
5. 接入 `backend/src/index.ts`，随 App Server 连接启动，随 backend 停止。
6. 跑 backend typecheck/lint。
7. 用手工 App Server 事件完成行为验证。
