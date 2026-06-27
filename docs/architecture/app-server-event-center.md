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
  app-server.log
  runtime/
    current.json
    releases/<releaseId>/
      manifest.json
      app-server/index.cjs
```

这里同时保存状态和当前激活的 app-server runtime。代码可以来自任意 repo、分支、
Electron bundle 或发布包，但默认运行入口必须先安装/激活到这个全局 home，再由 CLI
启动。

生命周期规则：

- CLI 提供 `rw app-server status` 与 `rw app-server start`。
- `rw app-server install --entry <path> --release-id <id>` 只安装/激活 runtime。
- `rw app-server start` 只启动当前 home 的 `runtime/current.json` 指向的 runtime。
- `rw app-server restart` 只重启当前 owner，不隐式 build、install 或 pull 代码。
- packaged Electron 先把自己 runtime release 中的 app-server entry 安装到全局
  app-server home。若当前 owner 已经运行同一个 release，则复用；若 owner 不存在
  或运行的 `releaseId` 不一致，则通过 runtime release 中的 CLI entry 执行
  `rw app-server start` 或 `rw app-server restart`。
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

## 实时消费

实时消费使用 WebSocket：

```text
WS /events/stream?after=<lastEventId>&kind=<kind>
```

同一个连接可以传多个 `kind` 参数。不传 `kind` 表示订阅所有事件。

连接成功后，server 按顺序发送：

1. `connected`：确认连接建立，不表示有事件可处理。
2. `events`：从持久化事件日志查询 `after` 之后的 catchup 事件。
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
4. 对 `events.events` 按数组顺序逐条调用 handler。
5. 对 live `event` 调用同一个 handler。
6. handler 成功后，再把该事件 `id` 保存为新的 `lastEventId`。
7. WebSocket 断开后，重新读取已保存 cursor 并重连。

这个模型是 at-least-once。handler 失败、进程崩溃或 cursor 写入失败时，同一事件
可能在重连后再次投递；consumer handler 必须幂等。

## Backend 接入

backend 启动时通过环境变量或 `~/.runweave/app-server` 下的 lock/token 发现 app-server。
发现失败不会阻塞 backend 启动，只记录日志并继续使用原有能力。backend 不 import
`@runweave/app-server`，也不启动 app-server。

发现成功后，backend 会：

- 发布 `backend.started`。
- 连接 `/events/stream?kind=agent.completion`。
- 只处理 `terminalSessionId` 或 `projectId` 属于当前 backend 的事件。
- 在 handler 成功后推进本地 cursor。

当前 backend cursor 保存在 backend 存储目录下的 `app-server-event-cursors.json`。

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

packaged Electron 使用 runtime release manifest 中的 app-server entry 更新全局
app-server runtime。若运行中的 owner 已经是刚安装的 release，Electron 只复用；
若运行中的 owner 是旧 release，Electron 使用 manifest 中的 CLI entry 运行
`rw app-server restart`，避免安装了新 Runtime 但 app-server 仍跑旧代码。
Electron 退出时不停止 app-server；app-server 视为本机全局服务，而不是 Electron
或 backend 子进程。

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
