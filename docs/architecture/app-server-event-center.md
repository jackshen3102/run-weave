# app-server Event Center

`app-server` 是 Runweave 的本机全局 Event Center。它独立于 backend 生命周期，
负责事件写入、查询、实时订阅和本地持久化；backend、hook、Electron、CLI 都只是
普通 client。

当前阶段不由 app-server 管理 terminal、不启动 backend、不分配业务端口，也不替换
backend 既有 `/ws/terminal-events`。

## 启动、CLI 管理与状态文件

app-server 的生命周期只由 CLI 或 app-server 可执行入口管理。产品客户端不直接 import
app-server 源码或 runtime helper 启动服务：

- CLI 提供 `rw app-server status` 与 `rw app-server start`。
- packaged Electron 通过 runtime release 中的 CLI entry 执行
  `rw app-server start`，再把发现到的连接信息传给 backend。
- backend 只发现现有 app-server，不负责启动。

hook bridge 只发现 app-server 并写事件，不负责启动 app-server。app-server 自动启动失败时，
backend、hook 和 CLI 的既有主流程必须继续 degraded 运行。

启动命令：

```bash
pnpm app-server:start
```

开发启动：

```bash
pnpm app-server:dev
```

默认状态目录：

```text
~/.runweave/app-server/
  app-server.lock.json
  app-server-token
  app-server-events.jsonl
```

环境变量：

- `RUNWEAVE_APP_SERVER_STATE_DIR`：覆盖状态目录。
- `RUNWEAVE_APP_SERVER_PORT`：指定监听端口；为空或非法时使用动态端口。

app-server 只监听 `127.0.0.1`。启动时先读取 lock 文件；如果 lock 中 pid 存活，
且 `GET /healthz` 返回 `service: "runweave-app-server"`、`protocolVersion: 1`
并匹配 pid，新进程不会抢占 owner，只打印已有地址后退出。

`pnpm app-server:start` 会先构建 CLI，再通过 CLI 启动 app-server。分发产物使用 build
后的 CLI 和 app-server Node 入口，不依赖源码仓库中的 `pnpm` 或 `tsx`。

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

`status` 只发现现有 owner，不启动 app-server；`start` 通过 CLI 子进程启动 bundled
app-server entry。输出包含
`baseUrl`、`pid`、`hasToken`、lock 路径和 health 信息，但不会打印 token 明文。

packaged Electron 使用 runtime release manifest 中的 CLI entry 运行
`rw app-server start`，并把 app-server entry 作为 CLI 内部执行目标传入。Electron
退出时不停止 app-server；app-server 视为本机全局服务，而不是 Electron 或 backend 子进程。

## 验证入口

```bash
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/shared typecheck
```
