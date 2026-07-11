# app-server Event Center

`app-server` 是 Runweave 的本机全局 Event Center。它独立于 backend 生命周期，
负责事件写入、查询、实时订阅和本地持久化；backend、hook、Electron、CLI 都只是
普通 client。

当前阶段不由 app-server 管理 terminal、不启动 backend、不分配业务端口，也不替换
backend 既有 `/ws/terminal-events`。

## Global Singleton、runtime 与状态文件

app-server 是一个本机 Global Singleton。默认情况下，整个系统只使用一个
app-server home：

```text
~/.runweave/app-server/
  app-server.lock.json
  app-server-token
  app-server-events.jsonl
  app-server-thread-state.json
  app-server.log
  runtime/
    current.json
    releases/<releaseId>/
      manifest.json
      app-server/index.cjs
```

这里同时保存状态和当前激活的 app-server runtime。代码可以来自任意 repo、分支或发布包，
但默认运行入口必须先安装/激活到这个全局 home，再由 CLI 启动。Electron 只检查现有
app-server 是否可用，不安装、启动或重启它。

事件数据写入 `app-server-events.jsonl`。它是 app-server 的本地事件存储，不是无限保留
的诊断日志；默认只保留最近 7 天事件。启动时会清理超过保留窗口的旧事件并重写 JSONL
文件，运行中也会周期性清理。清理旧事件不重置 event id，新的事件仍按历史最大 id 继续
递增，避免 consumer cursor 因保留窗口裁剪而漏掉新事件。

并发写入由两层队列保证顺序：EventCenter 串行执行完整的
`append -> projection -> sync -> notify` 事务，EventStore 另外串行保护 id 分配、dedupe
检查和 JSONL 追加。主日志与本地 cloud sync mirror 因此共享同一条单调事件序列。

`app-server-thread-state.json` 保存从事件投影出来的 latest ThreadRef 视图。它不是新的
事实源；文件损坏或丢失时，app-server 会从 event log 重建。

本地 cloud sync 模拟目录默认写到 `~/.runweave/app-server-cloud-sync-sim/`，包含事件镜像、
latest projection、sync cursor 和 manifest。测试必须通过
`RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR` 指到临时目录，避免污染默认同步模拟状态。

生命周期规则：

- CLI 提供 `rw app-server status` 与 `rw app-server start`。
- `rw app-server install --entry <path> --release-id <id>` 只安装/激活 runtime。
- `rw app-server start` 只启动当前 home 的 `runtime/current.json` 指向的 runtime。
- `rw app-server restart` 只重启当前 owner，不隐式 build、install 或 pull 代码。
- packaged Electron 只检查 app-server 是否已启动；如果不可用，只弹出提示，不执行
  `rw app-server start`、`rw app-server restart` 或 runtime 安装。
- backend 只发现现有 app-server，不负责启动。

hook bridge 只发现 app-server 并写事件，不负责启动 app-server。app-server 自动启动失败时，
backend、hook 和 CLI 的既有主流程必须继续 degraded 运行。

本地源码安装到默认全局 home：

```bash
pnpm app-server:install
```

启动默认全局 owner：

```bash
pnpm app-server:start
```

测试环境必须使用独立 home，不能和正式环境共享 state/runtime：

```bash
pnpm app-server:install:test
pnpm app-server:start:test
```

测试 home 默认是：

```text
~/.runweave/app-server-test/
```

正式和测试 app-server 可以并存，因为它们使用不同的 lock/token/event log/runtime。
它们不能共享同一个 home；同一个 home 内仍然只有一个 owner。

为了让测试阶段命令形态保持全局唯一，可以安装本地 shim：

```bash
pnpm cli:shim:local
```

它会写入 `~/.runweave/bin/rw`，让同一个 `rw` 命令指向当前 repo 的 CLI，并设置
`RUNWEAVE_APP_SERVER_HOME=~/.runweave/app-server-test`。这样用户仍然执行同一个
全局命令，但背后的 app-server home 是隔离的测试环境。

环境变量：

- `RUNWEAVE_APP_SERVER_HOME`：切换 app-server home，用于正式/测试 channel 隔离。
- `RUNWEAVE_APP_SERVER_PORT`：指定监听端口；为空或非法时使用动态端口。
- `RUNWEAVE_APP_SERVER_STATE_DIR`：底层状态目录覆盖，仅用于脚本化验证；常规测试
  应优先切换 `RUNWEAVE_APP_SERVER_HOME`。
- `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`：覆盖本地 cloud sync 模拟目录，验证和自动化必须使用临时目录。

app-server 只监听 `127.0.0.1`。启动时先读取 lock 文件；如果 lock 中 pid 存活，
且 `GET /healthz` 返回 `service: "runweave-app-server"`、`protocolVersion: 1`
并匹配 pid，新进程不会抢占 owner，只打印已有地址后退出。

lock 文件必须记录 owner 的来源，便于排查：

```json
{
  "pid": 123,
  "host": "127.0.0.1",
  "port": 54321,
  "source": "global",
  "releaseId": "local-2026-06-27-090000",
  "entry": "~/.runweave/app-server/runtime/releases/.../app-server/index.cjs",
  "runtimeRoot": "~/.runweave/app-server/runtime"
}
```

## 发现与鉴权

client 优先通过环境变量发现 app-server：

```text
RUNWEAVE_APP_SERVER_URL=http://127.0.0.1:<port>
RUNWEAVE_APP_SERVER_TOKEN=<token>
```

没有环境变量时，client 读取默认状态目录中的 `app-server.lock.json` 和
`app-server-token`。

除 `/healthz` 和 `/readyz` 外，所有 HTTP 与 WebSocket API 都要求 bearer token：

```text
Authorization: Bearer <token>
```

带非 loopback `Origin` 的请求会被拒绝。

## 事件 API

写入事件：

```text
POST /events
```

查询历史事件：

```text
GET /events?after=<eventId>&kind=<kind>&limit=<limit>
```

查询最新事件 id：

```text
GET /events/latest
```

事件 id 是全局单调递增字符串。`dedupeKey` 相同的重复写入会返回已有事件，不追加
新的 JSONL 记录。

## ThreadRef 状态查询

app-server 会从 `agent.hook` 与 `agent.completion` 投影轻量 ThreadRef。ThreadRef 只保存
当前状态和归属上下文，不保存完整 thread 正文、prompt、模型输出或 token。

状态映射：

- `agent.hook` + `SessionStart` -> `starting`
- `agent.hook` + `UserPromptSubmit` -> `running`
- `agent.hook` + `Stop` -> `idle`
- `agent.completion` + `completionReason=hook_stop` 且 raw hook event 是 `Stop` / `SubagentStop` -> `idle`
- `agent.completion` + `completionReason=ai_process_exit` -> `completed`
- `notify`、`manual` 和无法解释的 completion 不覆盖已有明确状态

状态变化会追加普通事件：

```text
thread.state.changed
```

该事件进入同一 event log 和 `/events/stream`，但 projector 会忽略它，避免递归投影。

查询接口：

```text
GET /threads?projectId=<id>&terminalSessionId=<id>&terminalPanelId=<id>&agent=<agent>&status=<status>&after=<eventId>&limit=<n>
GET /threads/:threadId
GET /sync/status
```

`/threads` 返回按 `lastEventId` 升序的 ThreadRef 列表；展示层如果需要“running 优先”或
“更新时间倒序”，必须自行排序。`/sync/status` 只暴露本地同步模拟状态和最近错误，不暴露
bearer token、Authorization、cookie 或完整事件正文。

backend 为已登录 Web 前端提供代理：

```text
GET /api/app-server/threads
GET /api/app-server/threads/:threadId
```

代理只在 backend 侧读取 app-server lock/token 并转发轻量 ThreadRef 响应。App Server 未发现、
不可达或返回非预期状态时，代理返回 503；前端不直接接触 App Server token。

## 实时消费

实时消费使用 WebSocket：

```text
WS /events/stream?after=<lastEventId>&kind=<kind>
```

同一个连接可以传多个 `kind` 参数。不传 `kind` 表示订阅所有事件。

连接成功后，server 按顺序发送：

1. `connected`：确认连接建立，不表示有事件可处理。
2. 一个或多个 `events`：按 `limit` 作为批大小，从持久化事件日志完整查询 `after`
   之后的 catchup 事件。
3. `event`：连接期间新写入的 live 事件。

消息类型：

```ts
type AppServerEventStreamMessage =
  | { type: "connected"; acceptedAfter: string | null }
  | { type: "events"; delivery: "catchup"; events: AppServerEventEnvelope[] }
  | { type: "event"; delivery: "live"; event: AppServerEventEnvelope }
  | { type: "error"; message: string };
```

app-server 不维护每个 consumer 的 ack 或 cursor。consumer 必须自己保存
`lastEventId`，并在断线后用这个 cursor 重连。

推荐 consumer 流程：

1. 启动时读取本地 `lastEventId`，没有则使用 `after=0`。
2. 连接 `/events/stream?after=<lastEventId>`。
3. 收到 `connected` 时不推进 cursor。
4. 对每一批 `events.events` 按数组顺序逐条检查 ownership；相关事件调用 handler。
5. 对 live `event` 调用同一个 handler。
6. 相关事件 handler 成功后，或事件确认与当前 backend 无关后，把该事件 `id` 保存为
   新的 `lastEventId`。
7. WebSocket 断开后，重新读取已保存 cursor 并重连。

这个模型是 at-least-once。handler 失败、进程崩溃或 cursor 写入失败时，同一事件
可能在重连后再次投递；consumer handler 必须幂等。

## Backend 接入

backend 启动时通过环境变量或 `~/.runweave/app-server` 下的 lock/token 发现 app-server。
发现失败不会阻塞 backend 启动，只记录日志并继续使用原有能力。backend 不 import
`@runweave/app-server`，也不启动 app-server。

发现成功后，backend 会：

- 发布 `backend.started`。
- 连接 `/events/stream?kind=agent.hook&kind=agent.completion`。
- 只处理 `terminalSessionId` 或 `projectId` 属于当前 backend 的事件。
- 相关事件在 handler 成功后推进 cursor；无 ownership 事件跳过 handler 后也推进 cursor。

当前 backend cursor 保存在 backend 存储目录下的 `app-server-event-cursors.json`。

`agent.hook` 与 `agent.completion` 在 backend 里的职责不同。`agent.hook` 会被规范化为
TerminalState hook 事件；`agent.completion` 只作为受限 Stop fallback：当它明确表示
`completionReason="hook_stop"` 且 raw hook event 是 `Stop` / `SubagentStop` 时，backend
可以复用 agent hook processor 更新 `TerminalState`。当前 backend consumer 不把
app-server `agent.completion` 写入 `TerminalCompletionEventService`，因此它不产生
`kind="completion"` 的 terminal event，也不驱动 Agent Team loop。Agent Team loop 的
completion 输入仍来自 backend 直连 `/internal/terminal-completion`。

app-server 自身的 `dedupeKey` 只保证 Event Center event log 幂等。由于当前没有把
app-server completion 桥接进 backend completion feed，也不存在跨 app-server / backend
直连的 completion feed 去重；后续若要让 app-server completion 也驱动 loop，必须先补齐
跨通道共同去重键和 completion feed 入口去重。

## Hook 接入

hook bridge 会自动发现 app-server，并把 Stop 等 hook 事件双写到 Event Center：

- `agent.hook`
- `agent.completion`

同时保留既有 backend fallback：

- `/internal/terminal/agent-hook`
- `/internal/terminal-completion`

因此 app-server 不可用、token 错误或写入失败时，不会阻断现有 backend hook 链路。
缺少 `RUNWEAVE_TERMINAL_SESSION_ID` 时，hook bridge 不写 app-server，也不写 backend。

hook bridge 不启动 app-server。短生命周期 hook 路径只按
环境变量和 `~/.runweave/app-server` 下的 lock/token 发现现有 owner。

## CLI 与 Electron 诊断

CLI 诊断命令：

```bash
rw app-server status
rw app-server start
```

`status` 只发现现有 owner，不启动 app-server；`start` 从当前 home 的
`runtime/current.json` 启动 app-server。输出包含 `baseUrl`、`pid`、`hasToken`、
lock 路径、runtime root、current runtime 和 health 信息，但不会打印 token 明文。

Electron 只做 app-server 可用性诊断。dev 与 packaged Electron 在应用窗口创建后都会
检查一次；Web 前端创建终端会话前也会通过 Electron IPC 触发一次 fire-and-forget
检查。若服务未启动，Electron 弹出提示但不阻断应用启动、终端创建或 backend 启动，
也不会自动启动、重启或安装 app-server。若服务已启动，则 packaged backend 启动路径
会把发现到的连接信息传给 backend。Electron 退出时不停止 app-server；app-server 视为
本机全局服务，而不是 Electron 或 backend 子进程。

## 本地更新流程

`pnpm runweave:update` 是本地安装/更新入口。它的 planner 同时判断三个组件：

- Desktop App：Electron shell/native 文件变化、缺少历史 state、shell version
  升级时选择完整 App 更新。
- Desktop Runtime：backend/frontend/CLI 等 runtime-loadable 文件变化时选择 runtime
  热更新。
- App Server：`app-server/`、`packages/shared` 中的 app-server 协议、CLI app-server
  命令、app-server 安装/验证脚本变化时，单独执行 app-server runtime 安装和重启。

dry-run 会同时输出桌面更新模式和 app-server 动作：

```bash
pnpm runweave:update --dry-run
```

关键输出：

```text
[runweave-update] selected mode: runtime|app
[runweave-update] selected app-server action: update|skip
[runweave-update] app-server home: ~/.runweave/app-server
```

实际执行时，桌面更新和 app-server 更新是两个独立组件动作：

1. `mode=runtime` 时先构建并安装 Desktop Runtime；除非传入 `--no-restart`，否则重启
   桌面端。
2. `mode=app` 时构建并替换 `/Applications/Runweave.app`，然后重新打开桌面端。
3. `app-server action=update` 时构建当前源码中的 app-server bundle，安装到
   `app-server home/runtime/releases/<releaseId>`，再通过 `rw app-server restart`
   切换运行中的全局 owner。

可以显式控制 app-server 组件：

```bash
pnpm runweave:update --app-server=update
pnpm runweave:update --app-server=skip
pnpm runweave:update --app-server-home=$HOME/.runweave/app-server-test
```

`--no-restart` 只表示不重启桌面端，不能和 `app-server action=update` 组合。
如果只想安装 Desktop Runtime 且不重启任何本地服务，必须显式使用
`--app-server=skip --no-restart`。

`--app-server-home` 用于测试 channel。正式更新默认使用
`~/.runweave/app-server`；测试更新必须使用独立 home，例如
`~/.runweave/app-server-test`，避免污染正式 singleton。

## 验证入口

```bash
pnpm runweave:update:test-cases
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/shared typecheck
```
