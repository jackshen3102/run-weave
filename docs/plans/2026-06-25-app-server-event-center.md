# 桌面端全局 app-server 第一阶段：Event Center

## 背景

本计划替代 `docs/plans/2026-06-25-desktop-runtime-event-hub.md` 中“在 backend 内部升级 Runtime Event Hub”的方向。

新的产品边界是：

- 根目录新增独立应用 `app-server/`。
- `app-server` 是一个可以单独启动的本地应用，对标 Codex App Server 的本地控制平面形态。
- 一台电脑中同一时间只允许有一个 Runweave app-server owner。
- 上层的终端、不同 CLI、多个 Runweave backend 实例、Electron App、后续其它客户端，都共享同一个 app-server。
- `app-server` 不属于 `backend`，也不由某个 backend 生命周期拥有；`backend` 只是 app-server 的生产者或消费者。

第一阶段只建立 Event Center。其它能力只保留扩展位置，不在本阶段实现。

## 当前代码事实

- workspace 当前包含 `app`、`frontend`、`backend`、`electron`、`packages/*`，尚未包含 `app-server`。
- backend 现有 `backend/src/terminal/terminal-event-service.ts` 是进程内内存事件服务。
- backend 现有 `/ws/terminal-events` 是 backend 自己的 terminal event stream。
- backend 启动时会 pin `RUNWEAVE_HOOK_ENDPOINT` 和 `RUNWEAVE_COMPLETION_HOOK_ENDPOINT` 到当前 backend，说明 hook 投递目标与 backend 实例绑定是现有问题点。
- Electron 侧已经有 `backend.lock.json` 处理 packaged backend owner，但这不是全局 app-server owner。

## 目标

第一阶段目标是建立一个独立的、全局单例的本地 Event Center：

1. 根目录新增 `app-server/` 应用，可通过 pnpm 单独运行。
2. app-server 启动时完成全局单例发现与 owner lock。
3. app-server 提供事件写入、事件查询、事件实时订阅能力。
4. app-server 使用本地持久化事件日志，app-server 重启后历史事件仍可查询。
5. hook bridge 在第一阶段迁移为 app-server 事件生产者，将 Hooks 事件写入全局 Event Center。
6. backend、CLI、Electron 后续都可以作为普通 client 连接 app-server。
7. 第一阶段至少提供一个 repo 内脚本或最小 client，验证多个生产者与多个订阅者共享同一个 app-server。

## 非目标

第一阶段不做以下事情：

- 不做 terminal 管理。
- 不做 backend 启停。
- 不做端口分配。
- 不做 Runtime Lease Registry。
- 不做 workflow/orchestrator。
- 不做审批系统。
- 不替换现有 backend API。
- 不迁移现有 `/ws/terminal-events` 的所有消费方。
- 不要求 backend 立刻依赖 app-server 才能启动。
- 不切断现有 hook bridge 到 backend 的 `/internal/terminal/agent-hook` 和 `/internal/terminal-completion` 链路。
- 不改变现有桌面通知与飞书通知行为。
- 不引入 Redis、NATS、Kafka 等外部 broker。
- 不开放非 loopback 网络访问。
- 不新增非 E2E 单测文件。

## 一阶段架构

目标拓扑：

```text
Terminal hooks / CLI / backend instances / Electron / future clients
                            |
                  Runweave app-server
                            |
       ------------------------------------------------
       Event ingest    Event query    Event stream
                            |
                    SQLite event log
```

app-server 不直接控制业务资源。它只负责事件：

- `POST /events`：写入事件。
- `GET /events`：按 cursor 查询事件。
- `GET /events/latest`：查询最新事件 id。
- `WS /events/stream`：先 catchup，再推 live 事件。
- `GET /healthz` / `GET /readyz`：健康检查与单例发现。

## 技术选型

### 应用形态

新增 package：

```text
app-server/
  package.json
  tsconfig.json
  src/
    index.ts
    config.ts
    singleton.ts
    auth.ts
    event-center.ts
    event-store.ts
    http-server.ts
    websocket-server.ts
```

workspace 修改：

- `pnpm-workspace.yaml` 增加 `app-server`。
- root `package.json` 增加脚本：
  - `app-server:dev`
  - `app-server:start`
  - `app-server:typecheck`

package 建议：

- 包名：`@runweave/app-server`
- runtime：Node + TypeScript ESM
- HTTP：优先复用 `express`
- WebSocket：复用 `ws`
- 入站校验：复用 `zod`
- 持久化：第一选择 `node:sqlite`

### SQLite 选型约束

优先使用 `node:sqlite`，原因是 app-server 是独立本地应用，第一阶段应避免新增 native npm dependency。

实施前必须验证：

```bash
node -e "import('node:sqlite').then(() => console.log('ok'))"
```

停止条件：

- 如果当前项目目标 Node runtime 不支持 `node:sqlite`，不要继续实现 SQLite event log。
- 先输出替代方案：`better-sqlite3`、`sqlite3`、或文件 append-only log。

### 协议类型

共享协议放在：

```text
packages/shared/src/app-server-events.ts
```

并从 `packages/shared/src/index.ts` 导出。不要放进 `packages/common`，因为这是跨 backend / frontend / electron / CLI / app-server 的协议合约。

## 全局单例设计

app-server 在本机只允许一个 owner。

默认状态目录：

```text
~/.runweave/app-server/
  app-server.lock.json
  app-server-token
  app-server.sqlite
```

lock 文件：

```json
{
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 47321,
  "startedAt": "2026-06-25T00:00:00.000Z",
  "version": "0.1.0"
}
```

启动流程：

1. 读取 lock 文件。
2. 如果 lock 中 pid 存活，并且 `GET /healthz` 返回 200，则当前进程不抢占 owner，输出已有 app-server 地址后退出。
3. 如果 pid 不存在，或 health check 失败，则清理旧 lock。
4. 监听 `127.0.0.1` 的动态端口。
5. 生成或读取本机 token。
6. 写入 lock 文件。
7. 启动 HTTP 与 WebSocket 服务。
8. 进程退出时尽力删除 lock；异常退出时依赖下次启动清理 stale lock。

约束：

- 第一阶段只监听 `127.0.0.1`。
- 不支持 `0.0.0.0`。
- 不支持远程连接。
- token 文件权限应尽量设置为 `0600`。

## 认证模型

所有非 health 请求都需要本机 bearer token：

```text
Authorization: Bearer <token>
```

token 来源：

- server 启动时读取 `~/.runweave/app-server/app-server-token`。
- 不存在则生成高熵 token 并写入。
- 客户端通过 lock 文件定位 host/port，通过 token 文件读取 token。

接口约束：

- `GET /healthz` 不要求 token，只允许无 `Origin` 的 localhost 请求。
- `GET /readyz` 不要求 token，只表示 listener 已准备好。
- `POST /events`、`GET /events`、`GET /events/latest`、`WS /events/stream` 必须校验 token。
- 带非 loopback `Origin` 的请求第一阶段直接拒绝。

## 事件模型

第一阶段不要复用 `TerminalEventEnvelope` 作为顶层协议，避免把 app-server 绑定到 terminal 领域。

新增通用事件：

```ts
export interface AppServerEventEnvelope {
  id: string;
  version: 1;
  kind: string;
  source: AppServerEventSource;
  scope?: AppServerEventScope;
  dedupeKey?: string | null;
  correlationId?: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AppServerEventSource {
  app: "app-server" | "backend" | "electron" | "cli" | "hook" | "unknown";
  instanceId: string;
  pid?: number;
}

export interface AppServerEventScope {
  projectId?: string | null;
  terminalSessionId?: string | null;
  runId?: string | null;
  cwd?: string | null;
}
```

写入请求：

```ts
export interface CreateAppServerEventRequest {
  kind: string;
  source: AppServerEventSource;
  scope?: AppServerEventScope;
  dedupeKey?: string | null;
  correlationId?: string | null;
  payload: unknown;
}
```

命名约定：

```text
terminal.session.created
terminal.session.deleted
terminal.state.changed
agent.completion
agent.hook
notification.created
diagnostic.created
app_server.started
```

第一阶段不强制定义所有 kind 的 payload schema，但 `kind`、`source`、`payload` 必须存在。

## SQLite 数据模型

主表：

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_json TEXT NOT NULL,
  scope_json TEXT,
  dedupe_key TEXT,
  correlation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX events_kind_id_idx ON events(kind, id);
CREATE INDEX events_correlation_id_id_idx ON events(correlation_id, id);
CREATE UNIQUE INDEX events_dedupe_key_unique_idx
  ON events(dedupe_key)
  WHERE dedupe_key IS NOT NULL;
```

第一阶段不需要 consumer cursor 表。客户端用 `after` cursor 自己恢复即可。hook bridge 只是事件生产者，不需要 consumer cursor。

后续如果要 durable consumer，再增加：

```sql
CREATE TABLE event_consumer_cursors (
  consumer_id TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

## HTTP API

### `GET /healthz`

用途：单例发现。

响应：

```json
{
  "ok": true,
  "pid": 12345,
  "version": "0.1.0"
}
```

### `GET /readyz`

用途：启动检查。

响应：

```json
{
  "ready": true
}
```

### `POST /events`

用途：写入事件。

请求：

```json
{
  "kind": "agent.completion",
  "source": {
    "app": "hook",
    "instanceId": "hook-abc",
    "pid": 12345
  },
  "scope": {
    "projectId": "project-1",
    "terminalSessionId": "session-1",
    "cwd": "/Users/bytedance/Code/browser-hub/feature"
  },
  "dedupeKey": "hook:session-1:stop:0001",
  "correlationId": "run-1",
  "payload": {
    "summary": "done"
  }
}
```

响应：

```json
{
  "event": {
    "id": "1",
    "version": 1,
    "kind": "agent.completion",
    "source": {
      "app": "hook",
      "instanceId": "hook-abc",
      "pid": 12345
    },
    "scope": {
      "projectId": "project-1",
      "terminalSessionId": "session-1",
      "cwd": "/Users/bytedance/Code/browser-hub/feature"
    },
    "dedupeKey": "hook:session-1:stop:0001",
    "correlationId": "run-1",
    "payload": {
      "summary": "done"
    },
    "createdAt": "2026-06-25T00:00:00.000Z"
  }
}
```

重复 `dedupeKey`：

- 返回已有事件，HTTP status 使用 200。
- 不新增第二条事件。

### `GET /events?after=&kind=&limit=`

用途：按 cursor 查询历史事件。

规则：

- `after` 为空时返回最早可用事件，按 id 升序。
- `after` 非数字时返回 400。
- `kind` 可重复传入，表示按 kind 过滤。
- `limit` 默认 100，最大 500。

响应：

```json
{
  "events": [],
  "latestEventId": "12"
}
```

### `GET /events/latest`

用途：获取最新事件 id。

响应：

```json
{
  "latestEventId": "12"
}
```

## WebSocket API

路径：

```text
WS /events/stream?after=123&kind=agent.completion&kind=diagnostic.created
```

握手：

- 使用 `Authorization: Bearer <token>`。
- 必须校验 loopback 与 token。

消息：

```ts
export type AppServerEventStreamMessage =
  | { type: "connected"; acceptedAfter: string | null }
  | { type: "events"; delivery: "catchup"; events: AppServerEventEnvelope[] }
  | { type: "event"; delivery: "live"; event: AppServerEventEnvelope }
  | { type: "error"; message: string };
```

连接流程：

1. WebSocket 连接成功。
2. server 发送 `connected`。
3. server 从 SQLite 查询 `after` 之后的事件，发送 `catchup`。
4. server 订阅内存 fanout，后续发送 `live`。
5. client 断线后用最后收到的 event id 作为 `after` 重连。

## 第一阶段：Hooks 事件迁移

第一阶段必须把 Hooks 事件迁移进 app-server Event Center。迁移方式是“双写 + fallback”，不是立即替换 backend 现有 hook endpoint。

### 当前 Hooks 链路

当前插件 hook 入口：

- `plugins/toolkit/hooks.json`
  - 注册 `PostToolUse`、`SessionStart`、`Stop`、`SubagentStop`、`UserPromptSubmit`。
  - 命令最终执行 `plugins/toolkit/hooks/runweave-hook-dispatch.cjs`。

- `plugins/toolkit/hooks/runweave-hook-dispatch.cjs`
  - 推断 hook 来源：`codex`、`trae`、`claude` 或 `unknown`。
  - 启动 `plugins/toolkit/hooks/runweave-hook-bridge.cjs`。

- `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
  - 从 stdin 读取 hook payload。
  - 读取 tmux 环境中的 `RUNWEAVE_*`。
  - 要求存在 `RUNWEAVE_HOOK_TOKEN` 与 `RUNWEAVE_TERMINAL_SESSION_ID`，否则跳过上报。
  - 对 `SessionStart`、`UserPromptSubmit`、`Stop` 发 agent state hook 到 backend `/internal/terminal/agent-hook`。
  - 对 Stop / SubagentStop / notify / ai_process_exit / manual completion 发 completion hook 到 backend `/internal/terminal-completion`。
  - 继续触发桌面通知与飞书通知。

现有 backend 接收端：

- `backend/src/routes/terminal-state.ts`
  - `/internal/terminal/agent-hook`
  - 根据 `terminalSessionId`、`agent`、`hookEvent` 更新 terminal state。

- `backend/src/routes/terminal-completion.ts`
  - `/internal/terminal-completion`
  - 校验 active command / grace command 后记录 completion event。

### 迁移目标

迁移后的第一阶段链路：

```text
AI CLI Hook
  -> runweave-hook-dispatch.cjs
  -> runweave-hook-bridge.cjs
       -> POST app-server /events          (新增，优先尝试)
       -> POST backend agent/completion    (保留，现有行为)
       -> desktop / Feishu notify          (保留，现有行为)
```

目标：

1. 每次 Runweave terminal 内的 hook invocation 都能形成一条 app-server 事件。
2. Stop / SubagentStop 等 completion hook 仍能形成 `agent.completion` 事件。
3. app-server 不可用时，hook bridge 仍按现有逻辑写 backend endpoint，不影响当前产品行为。
4. backend endpoint 不可用时，如果 app-server 可用，hook event 仍会进入全局事件日志。
5. hook bridge 始终静默失败，不让 AI CLI hook 因 Runweave 上报失败而失败。

### hook bridge 发现 app-server

新增 `plugins/toolkit/hooks/app-server-client.cjs`，供 `runweave-hook-bridge.cjs` 复用。

发现顺序：

1. 如果环境变量存在，优先使用：
   - `RUNWEAVE_APP_SERVER_URL`
   - `RUNWEAVE_APP_SERVER_TOKEN`
2. 否则读取默认文件：
   - `~/.runweave/app-server/app-server.lock.json`
   - `~/.runweave/app-server/app-server-token`
3. 读取 lock 后请求 `GET /healthz`。
4. health 成功后才认为 app-server 可用。
5. 任一步失败都返回 `null`，不抛出到 hook 主流程。

约束：

- hook bridge 不启动 app-server。
- hook bridge 不抢占 app-server lock。
- hook bridge 不直接读写 SQLite。
- hook bridge 不要求 app-server 存在；app-server 是增强链路，不是现有 hook 上报的硬依赖。

### Hooks 事件映射

新增事件 kind：

```text
agent.hook
agent.completion
```

#### `agent.hook`

每次 hook bridge 在 Runweave terminal 内被调用，并且存在 `RUNWEAVE_TERMINAL_SESSION_ID` 时，写入 `agent.hook`。

请求示例：

```json
{
  "kind": "agent.hook",
  "source": {
    "app": "hook",
    "instanceId": "codex:terminal-1",
    "pid": 12345
  },
  "scope": {
    "projectId": "project-1",
    "terminalSessionId": "terminal-1",
    "cwd": "/Users/bytedance/Code/browser-hub/feature"
  },
  "dedupeKey": "hook:codex:terminal-1:Stop:thread-1:1700000000000",
  "correlationId": "thread-1",
  "payload": {
    "source": "codex",
    "rawHookEvent": "Stop",
    "normalizedEvent": "stop",
    "stateHookEvent": "Stop",
    "threadId": "thread-1",
    "commandName": null,
    "completionReason": "hook_stop",
    "tmuxEnvRefresh": {
      "refreshed": true
    }
  }
}
```

字段规则：

- `source.app` 固定为 `"hook"`。
- `source.instanceId` 使用 `${source}:${terminalSessionId}`。
- `scope.terminalSessionId` 来自 `RUNWEAVE_TERMINAL_SESSION_ID`。
- `scope.projectId` 来自 `RUNWEAVE_PROJECT_ID`。
- `scope.cwd` 优先来自 payload.cwd，否则使用 `process.env.PWD`。
- `correlationId` 优先使用 Codex `threadId`，没有则为 `null`。
- `payload.rawHookEvent` 使用原始 hook event，例如 `Stop`、`SubagentStop`、`SessionStart`、`UserPromptSubmit`、`PostToolUse`。
- `payload.normalizedEvent` 使用现有 `normalizeEventName()` 结果。
- `payload.stateHookEvent` 使用现有 `toAgentHookStateEvent()` 结果，没有则为 `null`。

`dedupeKey`：

- 第一阶段 hook payload 不一定有稳定唯一 id。
- 可使用 `hook:${source}:${terminalSessionId}:${rawHookEvent}:${threadId ?? "no-thread"}:${Date.now()}`。
- 这类 dedupeKey 不用于强幂等，只用于后续排查和可选去重。
- 如果后续 hook payload 提供唯一 id，再改用稳定 id。

#### `agent.completion`

当现有逻辑判断 `shouldRecordCompletion === true` 时，除 `agent.hook` 外，再写入 `agent.completion`。

请求示例：

```json
{
  "kind": "agent.completion",
  "source": {
    "app": "hook",
    "instanceId": "codex:terminal-1",
    "pid": 12345
  },
  "scope": {
    "projectId": "project-1",
    "terminalSessionId": "terminal-1",
    "cwd": "/Users/bytedance/Code/browser-hub/feature"
  },
  "dedupeKey": "completion:codex:terminal-1:Stop:thread-1:1700000000000",
  "correlationId": "thread-1",
  "payload": {
    "source": "codex",
    "completionReason": "hook_stop",
    "commandName": null,
    "rawHookEvent": "Stop",
    "hookEvent": "Stop",
    "cwd": "/Users/bytedance/Code/browser-hub/feature",
    "summary": "done"
  }
}
```

字段应与现有 `/internal/terminal-completion` body 保持语义一致：

- `payload.source`
- `payload.completionReason`
- `payload.commandName`
- `payload.rawHookEvent`
- `payload.hookEvent`
- `payload.cwd`
- `payload.summary`

这样第二阶段 backend 订阅 `agent.completion` 时，可以无损映射回现有 completion 处理逻辑。

### hook 来源边界

第一阶段只迁移现有 hook source 识别能力，不扩大 Trae family 识别范围。

当前真实代码链路中：

- `plugins/toolkit/hooks/runweave-hook-dispatch.cjs` 只识别 `codex`、`trae`、`claude`。
- `plugins/toolkit/hooks/runweave-hook-bridge.cjs` 的 `normalizeSource()` 也只保留 `claude`、`codex`、`trae`，其它值会变成 `unknown`。
- Electron launcher script 内嵌的 hook bridge 逻辑同样只展示 `claude`、`codex`、`trae`。

因此第一阶段 hook bridge 只承诺产生：

```text
claude | codex | trae | unknown
```

`packages/shared` 的 app-server 协议可以为后续保留 `traecli`、`traex`，但本阶段 Hooks 迁移验收不能要求区分 `trae`、`traecli`、`traex`。如果后续确实要区分 Trae family，需要单独扩展：

- `plugins/toolkit/hooks/runweave-hook-dispatch.cjs`
- `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
- `electron/src/hooks/hook-launcher-script.ts`
- `electron/resources/hooks/runweave-hook-bridge.cjs`
- `scripts/verify-toolkit-hooks.mjs`

### hook bridge 执行顺序

`runweave-hook-bridge.cjs` 主流程调整为：

1. 刷新 tmux `RUNWEAVE_*` 环境。
2. 解析 args、stdin payload、source、raw event、thread id、completion reason。
3. 如果没有 `RUNWEAVE_TERMINAL_SESSION_ID`，保持现有行为：只写 debug log，不上报 app-server，也不上报 backend。
4. 尝试发现 app-server。
5. 如果发现 app-server，先写 `agent.hook`。
6. 如果 `stateHookEvent` 存在，继续按现有逻辑写 backend `/internal/terminal/agent-hook`。
7. 如果 `shouldRecordCompletion` 为 true：
   - 触发桌面通知与飞书通知。
   - 如果发现 app-server，写 `agent.completion`。
   - 继续按现有逻辑写 backend `/internal/terminal-completion`。
8. 所有 app-server 写入失败只写 debug log，不影响 backend 写入。
9. backend 写入失败保持现有静默策略。

说明：

- app-server 写入放在 backend 写入之前，是为了让全局事件日志尽量记录“hook 已发生”，即使 backend endpoint 后续失败。
- backend 写入仍保留，是为了第一阶段不改变 terminal state、completion marker、orchestrator 的现有行为。

### hook bridge 错误处理

新增 debug log message：

```text
hook bridge app-server unavailable
hook bridge posted app-server hook event
hook bridge posted app-server completion event
hook bridge app-server post failed
```

要求：

- 不把 token 写入 debug log。
- endpoint 继续使用 `redactEndpoint()`。
- app-server unavailable 与 post failed 都不能设置非 0 exit code。
- app-server 返回 401/403 时记录 status，但不重试。
- 网络错误不重试，避免 hook 阻塞 AI CLI。

### app-server 入站校验补充

为 Hooks 事件补充 zod 校验：

- `kind` 必须是 `agent.hook` 或 `agent.completion`，或符合通用 kind 格式。
- `source.app` 必须允许 `"hook"`。
- `scope.terminalSessionId` 对 Hooks 事件必须存在。
- `payload` 必须是 object。
- `agent.completion.payload.source` 对 Hooks 迁移第一阶段必须是 `"claude" | "codex" | "trae" | "unknown"`；共享协议可预留 `"traecli" | "traex"` 给后续扩展。
- `agent.completion.payload.completionReason` 必须是 `"hook_stop" | "notify" | "ai_process_exit" | "manual"`。

第一阶段不要让 app-server 查询 backend session 是否存在。app-server 是全局事件中心，只做结构校验，不做 backend 业务归属校验。

### 需要同步的 hook 资产

需要修改两份 hook bridge 资产：

- `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
- `electron/resources/hooks/runweave-hook-bridge.cjs`

如果新增 helper，也需要同步：

- `plugins/toolkit/hooks/app-server-client.cjs`
- `electron/resources/hooks/app-server-client.cjs`

同时检查同步脚本：

- `scripts/sync-toolkit-plugin.mjs`

要求：

- 插件源目录与 Electron resource 副本保持一致。
- `pnpm toolkit:sync` 后不应丢失新增 helper。

### Hooks 迁移验收

#### 1. app-server 可用时 hook 写入全局事件

操作：

- 启动 app-server。
- 使用现有 `scripts/verify-toolkit-hooks.mjs` 或新增验证路径模拟 Stop hook。

预期：

- hook bridge 仍向 mock backend 写 `/internal/terminal/agent-hook`。
- hook bridge 仍向 mock backend 写 `/internal/terminal-completion`。
- app-server `GET /events?after=0&kind=agent.hook` 能查到 `agent.hook`。
- app-server `GET /events?after=0&kind=agent.completion` 能查到 `agent.completion`。
- `agent.completion.payload.summary` 等于现有提取结果。

#### 2. app-server 不可用时 fallback 到现有 backend

操作：

- 不启动 app-server。
- 运行现有 hook verification。

预期：

- 现有 backend mock 仍收到 2 个请求：`/internal/terminal/agent-hook` 与 `/internal/terminal-completion`。
- hook 进程 exit code 仍为 0。
- debug log 只记录 app-server unavailable，不影响主流程。

#### 3. 缺少 Runweave terminal identity 时不上报

操作：

- 不设置 `RUNWEAVE_TERMINAL_SESSION_ID`。
- 运行 hook launcher。

预期：

- 不写 app-server。
- 不写 backend。
- 与当前 `scripts/verify-toolkit-hooks.mjs` 中 “launcher without Runweave identity must not post any request” 语义一致。

#### 4. Codex / Trae 来源保持准确

操作：

- 分别以 codex 与 trae 模拟 Stop hook。

预期：

- `agent.hook.payload.source` 分别为 `codex` 与 `trae`。
- `agent.completion.payload.source` 分别为 `codex` 与 `trae`。
- 不要求本阶段区分 `trae`、`traecli`、`traex`；当前 hook source 链路只输出 `trae`。

#### 5. app-server 401 不影响 backend

操作：

- 设置错误的 app-server token。
- 保持 backend mock endpoint 可用。

预期：

- app-server 写入失败。
- backend mock 仍收到现有请求。
- hook exit code 为 0。

## 文件范围

### 新增

- `app-server/package.json`
  - scripts：`dev`、`start`、`build`、`typecheck`、`lint`。

- `app-server/tsconfig.json`
  - 继承根目录 `tsconfig.base.json`。

- `app-server/src/index.ts`
  - 启动入口。
  - 解析配置、初始化 singleton、启动 HTTP/WS。

- `app-server/src/config.ts`
  - 解析状态目录、host、port、token 路径、sqlite 路径。

- `app-server/src/singleton.ts`
  - lock 读取、pid 检查、health check、stale lock 清理、lock 写入与释放。

- `app-server/src/auth.ts`
  - token 生成、读取、写入、HTTP/WS 校验。

- `app-server/src/event-store.ts`
  - SQLite schema 初始化。
  - append、listAfter、getLatest、dedupeKey 查询。

- `app-server/src/event-center.ts`
  - 内存 listener set。
  - `record()` 写 SQLite 后 fanout。
  - `subscribe()` 返回 unsubscribe。

- `app-server/src/http-server.ts`
  - HTTP routes。

- `app-server/src/websocket-server.ts`
  - `/events/stream` upgrade、catchup、live fanout、heartbeat。

- `packages/shared/src/app-server-events.ts`
  - app-server 事件协议类型。

- `plugins/toolkit/hooks/app-server-client.cjs`
  - hook bridge 专用 app-server discovery 与 `POST /events` helper。
  - 只读取 app-server lock/token，不启动 app-server，不读写 SQLite。

- `electron/resources/hooks/app-server-client.cjs`
  - Electron resource 副本，与插件源保持一致。

### 修改

- `pnpm-workspace.yaml`
  - 增加 `app-server`。

- `package.json`
  - 增加 app-server 相关 root scripts。

- `packages/shared/src/index.ts`
  - 导出 app-server event 协议。

- `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
  - 双写 Hooks 事件到 app-server。
  - 保留现有 backend agent hook / completion hook 上报。
  - 保留现有桌面通知与飞书通知。

- `electron/resources/hooks/runweave-hook-bridge.cjs`
  - 同步插件源 hook bridge 修改。

- `scripts/sync-toolkit-plugin.mjs`
  - 确认新增 hook helper 会同步到 Electron resources 与插件缓存。

- `scripts/verify-toolkit-hooks.mjs`
  - 增加 app-server 可用时的 `agent.hook` / `agent.completion` 写入断言。
  - 增加 app-server 不可用时仍 fallback 到 backend endpoint 的断言。
  - 增加 app-server token 错误时不影响 backend endpoint 的断言。

### 第一阶段不修改

- 不修改 `backend/src/terminal/terminal-event-service.ts` 的现有行为。
- 不修改 `backend/src/ws/terminal-events-server.ts` 的现有协议。
- 不修改 Electron backend runtime owner 逻辑。

## 第二阶段：backend 监听 app-server 事件

第二阶段目标是让 backend 作为 app-server 的普通 client 接入事件中心。backend 不直接读 SQLite，不 import `app-server/src/*`，只通过 app-server 对外协议监听和发布事件。

### backend 接入目标

1. backend 启动时发现当前全局 app-server。
2. backend 能向 app-server 发布事件。
3. backend 能按 `kind` 订阅 app-server 事件。
4. backend 能按 `scope` 判断事件是否属于自己。
5. backend 对会触发副作用的事件使用 durable cursor，处理成功后再推进 cursor。
6. app-server 不可用时，backend 不能启动失败；只能降级为不接入全局事件中心。

### 监听模型

backend 通过 WebSocket 监听：

```text
backend startup
  -> read ~/.runweave/app-server/app-server.lock.json
  -> read ~/.runweave/app-server/app-server-token
  -> connect WS /events/stream?after=<cursor>&kind=agent.completion
  -> receive catchup events
  -> receive live events
  -> dispatch to backend handlers
```

不要让 backend 全量监听所有消息。backend 必须按 kind 明确订阅：

```text
agent.completion
agent.hook
notification.created
diagnostic.created
```

第一批建议只接 `agent.completion`，因为它和现有 hook completion / orchestrator 消费链路最接近。

### backend 侧文件范围

新增：

- `backend/src/app-server/discovery.ts`
  - 读取 app-server lock 与 token。
  - 调用 `/healthz` 确认 owner 是可用 app-server。
  - 返回 `{ baseUrl, token }` 或 `null`。

- `backend/src/app-server/client.ts`
  - 封装 HTTP `POST /events`、`GET /events`。
  - 封装 WebSocket `/events/stream` 连接。
  - 不包含业务 handler。

- `backend/src/app-server/event-consumer.ts`
  - 提供 durable consumer 框架。
  - 负责读取 cursor、连接 stream、处理 catchup/live、顺序 dispatch、重连退避。
  - handler 成功后保存 cursor。

- `backend/src/app-server/event-cursor-store.ts`
  - 保存 backend 消费 app-server 事件的 cursor。
  - 第一版可使用 backend 现有 storage path 下的 JSON 文件，例如 `app-server-event-cursors.json`。
  - cursor key 使用 `consumerId`，不要只按 kind 存，避免后续多个 consumer 冲突。

- `backend/src/app-server/ownership.ts`
  - 封装 scope 归属判断。
  - 根据 `terminalSessionManager` 判断 `terminalSessionId` 或 `projectId` 是否属于当前 backend。

- `backend/src/app-server/handlers/agent-completion.ts`
  - 将 `agent.completion` 映射到现有 completion/orchestrator 处理入口。
  - 第一版可以只记录 diagnostic log 或桥接到现有 `TerminalCompletionEventService`，具体实现以不改变现有 hook 行为为约束。

修改：

- `backend/src/index.ts`
  - 创建 runtime services 后初始化 app-server client。
  - 如果发现 app-server，启动 backend event consumer。
  - 如果未发现 app-server，仅记录 info/warn，不影响 backend 正常启动。
  - shutdown 时关闭 WebSocket consumer。

- `backend/src/terminal/completion-event-service.ts`
  - 后续可增加“本地 completion 事件同步发布到 app-server”的 adapter。
  - 第二阶段先保持本地事件行为不变，避免打断现有 `/ws/terminal-events`。

- `packages/shared/src/app-server-events.ts`
  - 如需要，为 `agent.completion` 增加 payload 类型守卫。

### backend durable consumer 语义

监听 API 建议形态：

```ts
appServerEventConsumer.start({
  consumerId: `backend:${backendInstanceId}:agent-completion`,
  kinds: ["agent.completion"],
  isRelevant: (event) =>
    isEventOwnedByThisBackend(event, terminalSessionManager),
  handler: async (event) => {
    await handleAgentCompletion(event);
  },
});
```

处理规则：

- `catchup` 和 `live` 走同一套 dispatch。
- 同一 consumer 内按 event id 串行处理。
- handler 成功后才保存 cursor。
- handler 失败时不推进 cursor，并记录错误。
- WebSocket 断开后使用已保存 cursor 重连。
- 重连退避使用指数退避加上限，避免 app-server 不可用时刷日志。

### scope 归属判断

因为 app-server 是全电脑唯一的，未来可能有多个 backend 实例同时连接。backend 不能消费不属于自己的事件。

归属规则：

```ts
function isEventOwnedByThisBackend(event: AppServerEventEnvelope): boolean {
  const terminalSessionId = event.scope?.terminalSessionId;
  if (terminalSessionId) {
    return terminalSessionManager.getSession(terminalSessionId) !== null;
  }

  const projectId = event.scope?.projectId;
  if (projectId) {
    return terminalSessionManager.getProject(projectId) !== null;
  }

  return false;
}
```

约束：

- 没有 `scope` 的事件默认不触发 backend 副作用。
- 只有全局 diagnostic/logging consumer 可以选择消费无 scope 事件。
- `source.app === "backend"` 且 `source.instanceId` 等于当前 backend instance 时，应避免回环处理。

### cursor 存储

cursor 文件建议放在 backend 自己的 storage root 下，不放在 app-server 目录：

```text
<backend storage>/app-server-event-cursors.json
```

示例：

```json
{
  "backend:instance-1:agent-completion": {
    "lastEventId": "128",
    "updatedAt": "2026-06-25T00:00:00.000Z"
  }
}
```

要求：

- cursor 只在 handler 成功后推进。
- cursor 写入失败时，handler 结果不能被视为 durable 成功，需要记录错误并在下次重放。
- handler 必须幂等，不能假设事件只会处理一次。

### backend 发布事件

backend 发布事件也通过 app-server HTTP API：

```text
POST /events
```

第一批可同步发布：

- backend 启动：`backend.started`
- terminal session 创建：`terminal.session.created`
- terminal session 删除：`terminal.session.deleted`
- terminal state 变化：`terminal.state.changed`

约束：

- 发布失败不能影响现有 backend 业务操作成功。
- 发布失败只记录日志。
- `dedupeKey` 应尽量使用业务唯一键，例如 `terminal.session.created:<sessionId>`。

### backend 接入验收

#### 1. app-server 不存在时 backend 可正常启动

操作：

- 确保 app-server 未启动。
- 启动 backend。

预期：

- backend 正常启动。
- 日志说明未发现 app-server 或全局事件中心不可用。
- 现有 terminal/project/session 功能不受影响。

#### 2. backend 能发现 app-server

操作：

- 启动 app-server。
- 启动 backend。

预期：

- backend 读取 lock/token 成功。
- backend health check app-server 成功。
- backend 建立 `/events/stream` WebSocket。

#### 3. backend 只消费归属自己的事件

操作：

- 写入一个 `agent.completion`，scope 使用当前 backend 已知 `terminalSessionId`。
- 写入另一个 `agent.completion`，scope 使用不存在的 `terminalSessionId`。

预期：

- backend 只处理第一条。
- 第二条被跳过，并可记录 debug 级别日志。

#### 4. cursor 生效

操作：

- backend 处理一条 `agent.completion`。
- 重启 backend。
- app-server 保留历史事件。

预期：

- backend 使用保存的 cursor 重连。
- 已成功处理的事件不会再次触发副作用。

#### 5. handler 失败不推进 cursor

操作：

- 构造 handler 失败场景。
- 观察 cursor 文件。

预期：

- cursor 不推进。
- backend 重连或重启后会再次收到该事件。

### backend 验证命令

```bash
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/shared typecheck
git diff --check
```

如果接入路径影响 Web 页面 terminal event 行为，再补充 `$playwright-cli` 验证现有 terminal-events 相关路径。

## 验收闭环

### 1. 单例启动

验证：

```bash
pnpm --filter @runweave/app-server dev
```

预期：

- app-server 正常启动。
- 写入 `~/.runweave/app-server/app-server.lock.json`。
- 写入或复用 `~/.runweave/app-server/app-server-token`。
- `GET /healthz` 返回 200。

再启动第二个 app-server：

```bash
pnpm --filter @runweave/app-server dev
```

预期：

- 第二个进程发现已有 owner。
- 第二个进程不抢占、不新建 SQLite、不覆盖 token。
- 输出已有 app-server 地址后退出。

### 2. 事件写入与查询

使用 curl 或 repo 内脚本写入事件：

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"diagnostic.created","source":{"app":"cli","instanceId":"manual"},"payload":{"message":"hello"}}' \
  http://127.0.0.1:$PORT/events
```

查询：

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/events?after=0"
```

预期：

- 返回事件 id 为 string。
- payload 与写入内容一致。
- `latestEventId` 更新。

### 3. dedupeKey 幂等

连续两次使用同一个 `dedupeKey` 写入。

预期：

- 两次返回同一个事件 id。
- SQLite 中只新增一条记录。

### 4. WebSocket catchup + live

步骤：

1. 打开一个 WebSocket client，连接 `/events/stream?after=0`。
2. 确认收到 `connected` 与 `catchup`。
3. 另一个进程 `POST /events`。
4. WebSocket client 收到 `live`。
5. 断开重连，带上最后 event id。

预期：

- 重连后不会重复收到已处理事件。
- 新事件按 id 升序收到。

### 5. app-server 重启恢复

步骤：

1. 写入事件 A。
2. 停止 app-server。
3. 重新启动 app-server。
4. `GET /events?after=0`。

预期：

- 可以查到事件 A。
- 最新 event id 沿用 SQLite 中的最大 id，不从 1 重置。

### 6. Hooks 事件迁移

验证：

```bash
pnpm toolkit:verify-hooks
```

预期：

- app-server 可用时，Stop hook 会写入 `agent.hook` 与 `agent.completion`。
- app-server 不可用时，现有 backend hook endpoint 仍收到 agent/completion 请求。
- app-server token 错误时，backend hook endpoint 仍收到 agent/completion 请求。
- 缺少 `RUNWEAVE_TERMINAL_SESSION_ID` 时，不写 app-server，也不写 backend。
- hook 进程在上述场景 exit code 都为 0。

## 验证命令

第一阶段最小验证：

```bash
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/shared typecheck
pnpm toolkit:verify-hooks
git diff --check
```

如果 root workspace 因新 package 影响全局构建，再补充：

```bash
pnpm typecheck
```

涉及浏览器页面验收时才使用 `$playwright-cli`；本阶段纯 app-server API 验收不要求浏览器。

## 风险与处理

### app-server 单例误判

风险：lock 中 pid 存活但不是 app-server。

处理：

- 不只看 pid。
- 必须 health check 成功且返回 app-server 标识后才复用。
- health check 失败则视为 stale lock。

### token 泄露

风险：本机 token 被其它进程读取。

处理：

- token 文件权限设为 `0600`。
- 第一阶段只监听 `127.0.0.1`。
- 拒绝带不可信 Origin 的请求。

### SQLite 写入并发

风险：多个进程直接写同一个 SQLite 导致锁竞争。

处理：

- 第一阶段只有 app-server 写 SQLite。
- 其它进程只能通过 HTTP/WS 访问 app-server。

### 和现有 backend event stream 并存

风险：开发者误以为 app-server 已经替代 backend `/ws/terminal-events`。

处理：

- 第一阶段文档明确：backend terminal event stream 保持原样。
- app-server Event Center 是新全局事件中心，不自动迁移旧消费者。

## 后续阶段预留

### 第二阶段：backend 接入 app-server

目标与文件范围见上文“第二阶段：backend 监听 app-server 事件”。该阶段仍不要求 app-server 替换现有 backend `/ws/terminal-events`，只要求 backend 能作为普通 client 发布和监听全局事件。

### 第三阶段：Hook 链路收敛

目标：

- 基于第一阶段已完成的 hook bridge 双写，把 backend 从“被 hook bridge 直接调用”迁移为“订阅 app-server 的 `agent.hook` / `agent.completion`”。
- 当 backend 订阅消费稳定后，评估关闭 hook bridge 对 `/internal/terminal/agent-hook` 和 `/internal/terminal-completion` 的默认直写。
- 保留兼容 fallback：app-server 不可用或 backend 未完成订阅迁移时，hook bridge 仍可回退到现有 backend hook endpoint。
- 最终目标是 hook bridge 只负责向 app-server 写事件，backend、Electron、CLI 都通过 app-server 订阅消费。

### 第四阶段：Runtime Lease Registry

目标：

- 在 app-server 中增加资源 owner 与 lease。
- 管理 backend instance、hook endpoint、terminal session、browser profile、dev server 等资源。
- 解决多个服务和多个客户端互相打架的问题。

### 第五阶段：Notification Center

目标：

- 基于 app-server event log 做桌面端消息中心。
- 支持未读、已读、按 project/session/run 过滤。
- 展示 hook completion、diagnostic warning、human gate、agent 状态变更。
