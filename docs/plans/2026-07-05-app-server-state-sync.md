# App Server 状态中心与本地云同步模拟实现计划

## 目标

把 App Server 从“本机事件中转中心”推进到第一阶段“轻量状态中心 + 本地云同步模拟入口”。

实现完成后，App Server 应具备以下能力：

1. 继续保持现有 `/events` append-only 事件中心能力。
2. 从 `agent.hook` / `agent.completion` 事件投影出轻量 Thread / Agent Session 状态。
3. 提供状态查询 API，供 backend、CLI 或后续 UI 查询当前 thread / agent session 状态。
4. 通过 WebSocket 继续推送原始事件，并额外推送状态变化事件。
5. 将原始事件镜像、latest projection、同步 cursor 和 manifest 写入本地固定目录，模拟后续云端同步。
6. backend 可以基于 App Server 状态/事件补齐 terminal state，真实 Codex 终端场景可验证。

对应测试计划：

- `docs/testing/app-server-state-sync-test-cases.md`

## 非目标

- 不接真实云端服务。
- 不实现账号体系、团队空间、远程权限模型、端到端加密或冲突合并。
- 不把 Codex / Trae / TraeCLI / Traex 的完整 thread 对话详情保存到 App Server。
- 不改 hook bridge 自动启动策略；hook 仍然只发现并 best-effort 写入 App Server。
- 不让 backend 或 Electron 直接 import `app-server/src/*` 启动服务。
- 不移除既有 backend direct fallback。
- 不引入单元测试文件。本仓库仍按项目约束使用 typecheck、lint、app-server 验证脚本、Playwright E2E 和真实行为核对。

## 当前代码事实

- `app-server/src/event-store.ts` 负责 append-only JSONL 事件存储、7 天 retention、dedupe 和按 id 查询。
- `app-server/src/event-center.ts` 在事件创建后同步通知进程内 listener。
- `app-server/src/http-server.ts` 提供 `/events`、`/events/latest`、`/healthz`、`/readyz`。
- `app-server/src/websocket-server.ts` 提供 `/events/stream`，连接时发送 catchup，之后发送 live event。
- `packages/shared/src/app-server-events.ts` 定义事件 envelope、source、scope、stream message 类型；scope 已包含 `projectId`、`terminalSessionId`、`terminalPanelId`、`runId`、`cwd`。
- `backend/src/app-server/*` 已通过 App Server HTTP/WS 消费事件，并按 ownership 过滤后更新 backend terminal state。
- `docs/architecture/app-server-architecture.md` 当前定义 App Server 是事件中心，不做跨机器同步；本计划会扩展该定位，需要同步更新架构文档。

## 核心设计

### 事件与状态分层

继续保持事件为事实源：

- 原始事件只追加，不因 projection 改写。
- Thread / Agent Session 状态是从事件投影出来的当前视图。
- 状态 projection 可以删除并从 event log 重建。
- 本地同步目录是“云同步模拟 sink”，不能成为 App Server 运行的唯一事实源。

### 本地状态存储选择

第一阶段继续使用文件存储，不引入 SQLite：

- 当前机器 Node `v22.12.0` 环境曾不支持 `node:sqlite`，已有 App Server event center 选择 JSONL 并验证通过。
- 文件存储更符合第一阶段“可人工检查”的目标。
- 状态数据轻量，规模可控。

建议新增状态文件位于 App Server state dir：

```text
<stateDir>/
  app-server-events.jsonl
  app-server-thread-state.json
  app-server-agent-session-state.json
  app-server-state-sync-cursor.json
```

本地云同步模拟目录默认：

```text
~/.runweave/app-server-cloud-sync-sim/
```

测试和自动化必须允许覆盖：

```bash
RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR=/tmp/runweave-app-server-cloud-sync-sim
```

### 轻量状态模型

在 `packages/shared/src/app-server-events.ts` 增加共享类型。

```ts
export type AppServerAgentKind =
  | "claude"
  | "codex"
  | "trae"
  | "traecli"
  | "traex"
  | "unknown";

export type AppServerAgentRunStatus =
  | "starting"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "unknown";

export interface AppServerThreadRef {
  threadId: string;
  agent: AppServerAgentKind;
  status: AppServerAgentRunStatus;
  projectId: string | null;
  terminalSessionId: string | null;
  terminalPanelId: string | null;
  runId: string | null;
  cwd: string | null;
  detailRef?: {
    provider: AppServerAgentKind;
    id: string;
  } | null;
  sourceInstanceId: string | null;
  lastEventId: string;
  lastHookEvent: string | null;
  lastCompletionReason: AppServerCompletionReason | null;
  lastActivityAt: string;
  updatedAt: string;
}

export interface AppServerAgentSessionRef {
  agentSessionId: string;
  agent: AppServerAgentKind;
  status: AppServerAgentRunStatus;
  threadId: string | null;
  projectId: string | null;
  terminalSessionId: string | null;
  terminalPanelId: string | null;
  runId: string | null;
  cwd: string | null;
  sourceInstanceId: string | null;
  lastEventId: string;
  lastHookEvent: string | null;
  lastCompletionReason: AppServerCompletionReason | null;
  lastActivityAt: string;
  updatedAt: string;
}
```

### 主键规则

ThreadRef 主键：

1. 优先 `event.correlationId`。
2. 如果 payload 中存在 `threadId`，可作为同等来源。
3. 如果都没有，生成降级 key：

```text
unknown-thread:<agent>:<terminalSessionId>:<terminalPanelId>:<sourceInstanceId>
```

AgentSessionRef 主键：

```text
<agent>:<threadId>
```

无 threadId 时：

```text
<agent>:<terminalSessionId>:<terminalPanelId>:<sourceInstanceId>
```

规则目的：

- 同一 terminalSessionId 的多 panel 不能互相覆盖。
- 不同 agent 不能互相覆盖。
- 后续事件补上真实 threadId 时，应迁移或关联降级记录，避免留下两个 active running 状态。

### 状态投影规则

仅以下事件会更新状态：

- `agent.hook`
- `agent.completion`

映射：

- `agent.hook` + `SessionStart` -> `starting`
- `agent.hook` + `UserPromptSubmit` -> `running`
- `agent.hook` + `Stop` -> `idle`
- `agent.completion` + `completionReason=hook_stop` 且 raw hook event 是 Stop / SubagentStop -> `idle`
- `agent.completion` + `completionReason=ai_process_exit` -> `completed`
- `notify`、`manual`、无法解释事件不覆盖当前明确状态

同一记录的事件顺序以 App Server event id 为准。旧事件不得覆盖新事件。

### 状态变化事件

新增 App Server event kind：

- `thread.state.changed`
- `agent_session.state.changed`

这两个事件由 App Server projection 产生，仍写入同一个 event log，并通过 `/events/stream` 推送。

要求：

- 原始事件 append 成功后再执行 projection。
- projection 发现状态变化时，写入状态变化事件。
- 状态变化事件本身不能再次触发 projection 循环。
- dedupe 命中的原始事件不得重复产生状态变化事件。

### 本地云同步模拟

新增同步 sink，默认写入：

```text
~/.runweave/app-server-cloud-sync-sim/
```

目录结构：

```text
events/app-server-events.jsonl
projections/threads.jsonl
projections/agent-sessions.jsonl
projections/latest-threads.json
projections/latest-agent-sessions.json
cursors/upload-cursor.json
manifests/sync-manifest.json
```

同步语义：

- 原始事件和状态变化事件都追加到 `events/app-server-events.jsonl`。
- 每次 ThreadRef 变化追加一行到 `projections/threads.jsonl`。
- 每次 AgentSessionRef 变化追加一行到 `projections/agent-sessions.jsonl`。
- latest 文件保存完整当前视图，便于人工检查。
- cursor 记录最后成功同步的 event id。
- manifest 记录 schema version、app-server instance、state dir、sync dir、lastSyncAt、lastError。

同步失败不能阻断 `/events` 主流程；应记录 degraded 信息并在后续写入时尝试恢复。

## API 合约

### 查询 ThreadRef 列表

```text
GET /threads?projectId=&terminalSessionId=&terminalPanelId=&agent=&status=&limit=&after=
```

响应：

```ts
export interface AppServerThreadListResponse {
  threads: AppServerThreadRef[];
  latestEventId: string | null;
}
```

### 查询单个 ThreadRef

```text
GET /threads/:threadId
```

响应：

```ts
export interface AppServerThreadResponse {
  thread: AppServerThreadRef;
}
```

未找到返回 `404`。

### 查询 AgentSessionRef 列表

```text
GET /agent-sessions?projectId=&terminalSessionId=&terminalPanelId=&agent=&status=&limit=&after=
```

响应：

```ts
export interface AppServerAgentSessionListResponse {
  agentSessions: AppServerAgentSessionRef[];
  latestEventId: string | null;
}
```

### 查询同步状态

```text
GET /sync/status
```

响应：

```ts
export interface AppServerSyncStatusResponse {
  enabled: boolean;
  syncDir: string;
  latestSyncedEventId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}
```

### 鉴权

- 新增状态查询 API 与 `/events` 一样要求 bearer token。
- `/healthz`、`/readyz` 仍不要求 token。
- 非 loopback Origin 仍按现有规则拒绝。

## 文件范围

### `packages/shared/src/app-server-events.ts`

职责：

- 增加 `AppServerAgentKind`、`AppServerAgentRunStatus`。
- 增加 ThreadRef / AgentSessionRef 类型。
- 增加状态查询 response 类型。
- 扩展 `AppServerEventStreamMessage` 如有必要；优先复用现有 `event` / `events` 消息。

约束：

- 不破坏现有 `AppServerEventEnvelope` 字段。
- 新增字段必须向后兼容。

### `app-server/src/state-store.ts`（新增）

职责：

- 维护 ThreadRef 和 AgentSessionRef 的内存 map。
- 从 state JSON 文件初始化。
- 原子写入 latest state JSON。
- 提供 list/get/upsert。
- 支持从 event log 重建。

### `app-server/src/state-projector.ts`（新增）

职责：

- 接收 `AppServerEventEnvelope`。
- 判断是否需要投影。
- 根据状态映射规则生成 ThreadRef / AgentSessionRef。
- 返回状态变化结果，供 event center 记录 `thread.state.changed` 和 `agent_session.state.changed`。

约束：

- 不处理 `thread.state.changed` / `agent_session.state.changed`，避免循环。
- 不保存完整 thread 详情。
- 不让无法解释事件覆盖明确状态。

### `app-server/src/cloud-sync-sim.ts`（新增）

职责：

- 解析 sync dir。
- 写入事件镜像。
- 写入 projection JSONL。
- 写入 latest JSON。
- 写入 cursor 和 manifest。
- 暴露 sync status。

约束：

- 写失败不 throw 到 HTTP 主流程。
- 不写 token、Authorization header、cookie、secret 等敏感值到 manifest/latest。

### `app-server/src/event-center.ts`

修改：

- 注入 state projector、state store、cloud sync sim。
- `record()` append 原始事件后：
  1. 同步原始事件到 cloud sync sim。
  2. 执行 projection。
  3. 状态变化时追加状态变化事件。
  4. 通知 listener。
- dedupe 命中时不能重复 projection。

注意：

- 为避免递归复杂度，建议将内部状态变化事件写入 store 的 helper 与外部 `record()` 分离。
- listener 收到事件顺序必须保持原始事件在前，状态变化事件在后。

### `app-server/src/event-store.ts`

修改：

- 保持现有 append-only JSONL 语义。
- 如果需要 internal append API，确保仍统一生成单调递增 event id。
- 暴露初始化后已加载 events，供 state store 重建 projection；或由 App Server index 初始化时调用 `listAfter({ after: null })`。

### `app-server/src/http-server.ts`

修改：

- 注册 `/threads`、`/threads/:threadId`、`/agent-sessions`、`/sync/status`。
- 复用现有 auth 和 Origin 规则。
- 为查询参数添加 zod 校验。

### `app-server/src/websocket-server.ts`

修改：

- 保持 `/events/stream`。
- 状态变化事件作为普通 event 推送。
- kind filter 能过滤 `thread.state.changed` 和 `agent_session.state.changed`。

### `app-server/src/config.ts`

修改：

- 增加 sync dir 解析。
- 默认 `~/.runweave/app-server-cloud-sync-sim/`。
- 支持 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`。

### `app-server/src/index.ts`

修改：

- 初始化 state store。
- 初始化 cloud sync sim。
- 启动时从 event log 重建 projection，或加载 state JSON 后做一致性校验。
- 将 state store / sync sim 注入 HTTP app 和 event center。

### `scripts/verify-app-server-state-sync.mjs`（新增）

职责：

- 使用临时 state dir 和 sync dir 启动 App Server。
- 覆盖 `docs/testing/app-server-state-sync-test-cases.md` 中 ASTS-001 到 ASTS-022 的核心自动化路径。
- 检查 event log、projection、latest、cursor、manifest。
- 不污染默认 home。

### `package.json`

修改：

- 增加脚本：

```json
"app-server:verify-state-sync": "node ./scripts/verify-app-server-state-sync.mjs"
```

### `backend/src/app-server/*`

第一阶段最小改动：

- 保留现有 event consumer。
- 如新增 App Server 状态 API client，放在 `backend/src/app-server/client.ts`，通过 HTTP 调用，不 import app-server 源码。
- backend terminal state 补齐仍优先复用 `TerminalStateService`，不能直接改 DB。

### 文档

修改：

- `docs/architecture/app-server-architecture.md`
  - 将 App Server 定位从“只做事件中心”扩展为“事件中心 + 轻量状态中心 + 本地同步模拟”。
  - 明确不拥有完整 thread 内容。
  - 明确本地 sync sim 不是正式云。

- `docs/testing/app-server-state-sync-test-cases.md`
  - 实现过程中如果 API 名称或状态枚举有调整，必须同步更新测试计划。

## 分阶段实施

### 阶段 1：共享协议与配置

1. 修改 `packages/shared/src/app-server-events.ts`。
2. 增加状态类型、response 类型、状态变化 event payload 类型。
3. 修改 `app-server/src/config.ts` 增加 sync dir。
4. 验证：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/app-server typecheck
```

通过标准：

- 现有 app-server event 类型调用点不报错。
- 新类型可被 app-server 和 backend 引用。

### 阶段 2：状态存储与 projector

1. 新增 `state-store.ts`。
2. 新增 `state-projector.ts`。
3. 从事件投影 ThreadRef / AgentSessionRef。
4. 支持 dedupe 不重复投影。
5. 支持重启从 event log 恢复。
6. 验证：

```bash
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
```

通过标准：

- ASTS-001 到 ASTS-012 可被脚本或手工 HTTP 调用验证。

### 阶段 3：本地云同步模拟

1. 新增 `cloud-sync-sim.ts`。
2. 写入 events mirror、projection JSONL、latest JSON、cursor、manifest。
3. 同步失败降级，不阻断 `/events`。
4. 验证：

```bash
RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR="$(mktemp -d)" pnpm app-server:verify-state-sync
```

通过标准：

- ASTS-013 到 ASTS-016 通过。
- 默认目录不被自动化污染。

### 阶段 4：HTTP / WS API

1. 在 `http-server.ts` 注册状态查询 API。
2. 保持 token 和 Origin 行为一致。
3. 确认 `/events/stream` 能推送状态变化 event。
4. 验证 ASTS-017 到 ASTS-019。

通过标准：

- 未授权请求返回 `401`。
- 状态查询过滤正确。
- WS catchup/live 正常。

### 阶段 5：Backend 集成

1. 评估现有 `backend/src/app-server/event-consumer.ts` 是否足够消费状态变化 event。
2. 对 terminal state 补齐仍复用 `TerminalStateService`。
3. 不直接改 backend session store。
4. 加强 ownership 过滤，避免其它 backend/project/session 的事件污染当前 backend。
5. 验证 ASTS-020 到 ASTS-022。

通过标准：

- backend DB 和 `/ws/terminal-events` 都通过现有 state service 链路更新。
- 旧 fallback 不回退。

### 阶段 6：真实场景验收

必须先完成：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm app-server:verify-state-sync
git diff --check
```

然后执行：

- ASTS-023 真实 Codex 终端完整运行。
- ASTS-024 多 panel 并发 agent。
- ASTS-025 App Server 重启期间事件恢复。
- ASTS-026 离线本地同步补偿。

涉及 Web 页面验收时必须使用 `$playwright-cli`，并保存关键证据：

- App Server `/events` 响应片段。
- ThreadRef / AgentSessionRef 响应。
- 本地同步目录关键 JSON。
- backend `/api/terminal/session/:id/state` 响应。
- Web 页面截图或 DOM 断言。

## 验收标准

实现完成必须满足：

- 现有 `pnpm app-server:verify` 和 `pnpm app-server:verify-cli-start` 不回退。
- App Server 可从事件生成 ThreadRef / AgentSessionRef。
- projection 可从 event log 重建。
- 状态变化通过 `/events/stream` 推送。
- 本地同步模拟目录可人工检查，包含事件镜像、latest projection、cursor、manifest。
- sync 写失败不影响主事件写入和状态投影。
- backend 状态补齐不直接改 DB，必须经过 `TerminalStateService`。
- 多 panel 场景不会用 `terminalSessionId` 覆盖所有 panel 的状态。
- 不保存完整 thread 详情正文。
- 不泄露 token 到 manifest/latest projection。

## 风险与处理

### 风险：事件和状态变化事件递归

处理：

- projector 忽略 `thread.state.changed` 和 `agent_session.state.changed`。
- event center 内部区分 external record 和 internal derived record。

### 风险：状态 projection 与 event log 不一致

处理：

- event log 是事实源。
- projection 可重建。
- 启动时如果 state JSON 无法解析，记录错误并从 event log 重建。

### 风险：本地同步失败阻塞主流程

处理：

- sync sim 捕获错误，写入 `lastError`。
- `/events` 仍按 event store 和 projection 结果返回。
- 下次事件写入重试同步。

### 风险：多 panel 状态互相覆盖

处理：

- ThreadRef 主键优先 threadId。
- 无 threadId 时 key 必须包含 `agent + terminalSessionId + terminalPanelId + sourceInstanceId`。
- 测试 ASTS-008 和 ASTS-024 必须覆盖。

### 风险：敏感数据进入同步目录

处理：

- projection/latest/manifest 不写 token、Authorization、cookie、secret。
- 原始 event payload 如包含敏感数据，测试报告必须明确风险；后续可单独设计 payload redaction。

### 风险：旧客户端不识别新事件 kind

处理：

- 保持 envelope 不变。
- backend/clients 对未知 kind 应忽略。
- ASTS-030 覆盖回滚兼容。

## 回滚策略

若上线后发现问题：

1. 保留 `/events` 旧路径不变。
2. 可通过配置禁用 state projection 和 sync sim。
3. 删除或忽略 projection 文件不影响 event log。
4. backend 可退回只消费原有 `agent.hook` / `agent.completion`。
5. 不需要迁移或删除已有 `app-server-events.jsonl`。

## 完成后文档更新

实现完成后必须更新：

- `docs/architecture/app-server-architecture.md`
- `docs/testing/app-server-event-center-test-cases.md`（如原有验证脚本增加覆盖）
- `docs/testing/app-server-state-sync-test-cases.md`（保持与实际 API 一致）

## 待确认点

1. 默认同步目录是否确认使用 `~/.runweave/app-server-cloud-sync-sim/`。
2. 状态 API 路径是否接受 `/threads` 与 `/agent-sessions`。
3. 无 threadId 的降级 key 是否接受 `agent + terminalSessionId + terminalPanelId + sourceInstanceId`。
4. `ai_process_exit` 第一阶段是否确认为 `completed`，而不是 `idle`。
