# app-server CLI-owned 启动完整性检查方案

## 背景与目标

当前代码把 app-server 从“产品侧源码依赖启动”调整为“CLI 拥有启动生命周期”：

- CLI 提供 `rw app-server status/start`，负责启动 bundled app-server entry。
- Electron 只通过 runtime release 中的 CLI entry 执行 `rw app-server start`。
- backend 和 hook bridge 只发现 app-server，发现失败时 degraded 运行，不启动 app-server。
- runtime release manifest 必须包含 `cli.entry` 与 `appServer.entry`，并通过路径与 hash 校验。

本方案用于检查这次改动是否完整、完备，尤其覆盖正常路径、报错路径、容错路径、并发与回归边界。

## 检查范围

必须覆盖的代码入口：

- `packages/runweave-cli/src/commands/app-server.ts`：CLI status/start、stale lock 清理、子进程启动、输出脱敏。
- `packages/shared/src/app-server-node.ts`：状态目录、lock/token、env 优先发现、health 校验。
- `app-server/src/index.ts`、`app-server/src/singleton.ts`、`app-server/src/http-server.ts`、`app-server/src/websocket-server.ts`：服务启动、单例、HTTP/WS、鉴权与事件 API。
- `electron/src/app-server-cli.ts`、`electron/src/backend-runtime.ts`、`electron/src/runtime-release.ts`：Electron 通过 CLI 启动 app-server，失败后 backend degraded 启动，runtime manifest 校验。
- `backend/src/index.ts`、`backend/src/app-server/*`：backend discover-only、事件消费、cursor 推进与 ownership 过滤。
- `electron/src/hooks/*`、`scripts/verify-toolkit-hooks.mjs`：hook 双写 app-server，同时保留 backend fallback，且不自动启动 app-server。
- `scripts/verify-app-server-event-center.mjs`、`scripts/verify-app-server-cli-start.mjs`：自动化验收脚本。

不纳入本次检查的范围：

- 不新增 Web/App UI 行为验收，除非后续把 app-server 状态暴露到浏览器页面；一旦涉及浏览器页面验收，必须使用 `$playwright-cli`。
- 不检查 Windows/Linux Electron 打包；本项目默认只验证本地 mac 客户端路径。
- 不把 terminal 事件系统替换为 app-server；backend 既有 `/ws/terminal-events` 仍是独立链路。

## 成功标准

1. CLI 是唯一产品级 app-server 启动入口；backend 和 hook bridge 没有 import 或 spawn app-server 的启动逻辑。
2. 空状态、已有 owner、stale lock、并发启动、缺失 app-server entry 都有明确行为并被验证。
3. backend/hook 在 app-server 不可用、token 错误、写入失败时不阻断原有主流程。
4. HTTP/WS 事件 API 的鉴权、Origin、参数、payload 校验能拒绝非法请求且不污染 JSONL 日志。
5. Electron runtime release 对 `cli.entry`、`appServer.entry`、路径逃逸、hash、shell version 不匹配有回退或失败路径。
6. CLI 和 shared 里的 app-server discover/status 语义保持一致：状态目录、env 优先级、health 协议、stale lock、token 脱敏一致。
7. 验证结束后没有残留 app-server 进程、临时状态目录或明文 token 输出。

## 分层检查矩阵

### 1. 静态结构检查

命令：

```bash
rg -n "@runweave/app-server|ensureAppServer|app-server.*start|RUNWEAVE_CLI_APP_SERVER_ENTRY" backend electron/src/hooks packages/runweave-cli/src electron/src packages/shared/src
rg -n "token|app-server-token|RUNWEAVE_APP_SERVER_TOKEN" scripts packages/runweave-cli/src electron/src backend/src app-server/src
git diff --check
```

期望：

- backend 只出现 `discoverAppServer` 和 `AppServerClient` 相关 client 逻辑，不出现启动 app-server 的 import/spawn。
- hook bridge 只发现和写事件，不创建 lock，不调用 CLI start。
- Electron 的启动路径只在 `electron/src/app-server-cli.ts` 通过 CLI entry 触发。
- CLI JSON 输出只包含 `hasToken`、`tokenPath`，不输出 token 明文。
- `git diff --check` 无空白错误。

失败判定：

- backend/hook 出现 app-server 启动逻辑。
- stdout/stderr、日志、JSON 输出中包含 token 明文。
- `packages/common` 被用于 Node 协议、backend、Electron 或 CLI 合约。

### 2. 类型、lint 与构建入口

命令：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
```

期望：

- shared、app-server、CLI、Electron、backend 的类型边界一致。
- `@runweave/shared/src/app-server-node.ts` 可被 backend/Electron 使用。
- `@runweave/cli` 可独立构建并携带 `dist/app-server`。

失败判定：

- CLI 需要源码仓库的 `tsx`、`pnpm` 或 app-server 源码才能运行。
- Electron CJS bundle 无法引用 CLI/app-server entry。

### 3. app-server 核心事件能力

命令：

```bash
pnpm app-server:verify
```

当前已覆盖：

- 单例 owner：第二个 app-server 复用已有 owner，不抢占 lock/token。
- `POST /events`、`GET /events`、dedupeKey 去重。
- WebSocket catchup 和 live delivery，包含多个 subscriber。
- 重启后 JSONL 事件恢复，event id 继续单调递增。

补充检查：

- 读取脚本结束后的临时状态目录，确认被清理。
- 通过 `ps -p <pid>` 或脚本内 stop 逻辑确认测试 owner 已退出。

失败判定：

- 第二个进程覆盖 token 或 lock。
- dedupeKey 重复追加 JSONL。
- WebSocket catchup 漏事件、live delivery 重复投递或 event id 回退。
- 重启后 latest id 丢失。

### 4. CLI start/status 生命周期

命令：

```bash
pnpm app-server:verify-cli-start
```

当前已覆盖：

- 空状态目录执行 `rw app-server status` 不启动 owner，也不创建 lock。
- 空状态目录执行 `rw app-server start` 能启动 owner。
- start 后再次执行 `rw app-server status` 返回同一 `baseUrl` 和 pid。
- 第二次 start 复用同一 owner。
- stale lock 会被清理并替换为健康 owner。
- 5 个并发 start 最终收敛到同一个 `baseUrl`。
- 缺失 `RUNWEAVE_CLI_APP_SERVER_ENTRY` 时 start 非 0 退出，返回 `started: false`。
- 所有 JSON 输出不包含 token 明文。

期望：

- 第一次 status：`available: false`，不创建 lock。
- start：`started: true`，包含 `baseUrl`、`pid`、`lockPath`、`hasToken: true`。
- 第二次 status：`available: true`，pid 与 start 返回一致。
- 所有 JSON 输出不包含 token 明文。

失败判定：

- `status` 产生副作用并启动 app-server。
- `start` 超时后仍返回 0。
- 并发启动产生多个健康 owner。
- 缺失 entry 时输出 token、抛非结构化异常或留下健康 lock。

### 5. 鉴权、Origin 与非法输入

`docs/testing/app-server-event-center-test-cases.md` 中 AS-EC-007 已由
`pnpm app-server:verify` 自动化覆盖。

检查项：

- `GET /healthz`、`GET /readyz` 无 token 返回 200。
- `POST /events`、`GET /events`、`GET /events/latest`、`WS /events/stream` 缺 token 或 token 错误返回 401。
- 带 `Origin: https://example.com` 的 mutation 请求返回 403。
- `GET /events?after=abc` 返回 400。
- `GET /events?limit=0` 返回 400。
- `agent.hook` 缺 `scope.terminalSessionId` 返回 400。
- `agent.hook` 的 payload 非 object 返回 400。
- `agent.completion` 的 source 或 completionReason 非允许值返回 400。
- 非法请求后 JSONL 行数不增加。
- 合法 `agent.completion` 返回 201，并可通过 `GET /events?kind=agent.completion` 查询。

失败判定：

- 任一受保护接口绕过 bearer token。
- 非 loopback Origin 能写入事件。
- 400 case 仍追加 JSONL。
- WebSocket 非法 query 进入正常连接并发送 catchup。

### 6. backend discover-only 与 degraded 行为

静态检查：

```bash
rg -n "@runweave/app-server|spawn\\(|ensureAppServer|RUNWEAVE_CLI_APP_SERVER_ENTRY" backend/src
```

运行检查：

1. 不启动 app-server，启动 backend。
2. 确认 backend 正常监听 `/health`，日志只记录 app-server discovery failure 或 degraded 信息。
3. 启动 app-server 后再启动 backend。
4. 写入 scoped 与 unscoped `agent.completion`。
5. 断开 WebSocket 或停止 app-server，观察 backend 重连与 cursor 行为。

期望：

- app-server 不可用不阻断 backend start。
- app-server 可用时 backend 发布 `backend.started`。
- consumer 只处理属于当前 backend 的 `terminalSessionId` 或 `projectId`。
- handler 成功后才推进 cursor。
- handler 失败时 cursor 不推进，重连后按 at-least-once 语义重新投递。

失败判定：

- backend 启动 app-server。
- app-server 不可用导致 backend 退出。
- unscoped 或不属于当前 backend 的事件被处理。
- handler 失败仍推进 cursor。

### 7. hook bridge 双写与 fallback

命令：

```bash
pnpm toolkit:verify-hooks
```

期望：

- Codex Stop 和 Trae Stop hook 继续写既有 backend fallback endpoint。
- app-server 可用时额外写 `agent.hook` 与 `agent.completion`。
- app-server 401、连接失败或写入失败不影响 backend fallback。
- 缺少 `RUNWEAVE_TERMINAL_SESSION_ID` 时 app-server 和 backend 都不写。
- 没有 app-server 环境变量和状态文件时，hook 不创建 `~/.runweave/app-server/app-server.lock.json`。
- hook 进程退出码保持 0。

失败判定：

- app-server 写失败阻断 backend fallback。
- hook 自动启动 app-server。
- 缺 terminal identity 时仍写事件。

### 8. Electron runtime 与 packaged backend

命令：

```bash
pnpm runtime:build
```

检查生成的 `.runtime-artifacts/<releaseId>/manifest.json`：

- `cli.entry` 为 `cli/index.cjs`。
- `appServer.entry` 为 `app-server/index.cjs`。
- `backend.entry`、`cli.entry`、`appServer.entry` 都在 release 目录内，不允许绝对路径或 `..`。
- `files` 中包含 backend、CLI、app-server、frontend 产物 hash。

Electron 启动路径检查：

- `electron/src/main.ts` 调用 `startPackagedBackend` 时注入 `ensureAppServerViaCli`。
- `electron/src/app-server-cli.ts` 执行 `process.execPath <cliEntry> app-server start`，并传入 `RUNWEAVE_CLI_APP_SERVER_ENTRY=<appServerEntry>`。
- `electron/src/backend-runtime.ts` 只在 `ensureAppServer` 成功时给 backend 注入 `RUNWEAVE_APP_SERVER_URL/TOKEN`。

容错 case：

- external manifest 缺 `cli.entry` 或 `appServer.entry`：`resolveExternalRuntimeRelease` 返回 null，走 bundled 或 last-known-good。
- manifest entry 为绝对路径或包含 `..`：返回 null。
- hash 不匹配：返回 null。
- shell version 不匹配：返回 null。
- CLI start 非 0 或 start 后 discover 失败：Electron 记录 warn，backend 不带 app-server env 继续启动。

失败判定：

- Electron 直接 import app-server 源码启动。
- runtime manifest 缺 CLI/app-server entry 仍被接受。
- CLI start 失败导致 packaged backend 不启动。

### 9. 错误与容错总表

| 场景                  | 触发方式                                       | 期望行为                                      | 验证方式                                     |
| --------------------- | ---------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| stale lock            | 写入不存在 pid 的 lock                         | CLI/app-server 清理 stale lock 并启动新 owner | `pnpm app-server:verify-cli-start`           |
| 健康 owner 已存在     | 重复 start                                     | 复用原 owner，不覆盖 token                    | `pnpm app-server:verify-cli-start`、检查 pid |
| 并发 start            | 同一 state dir 同时 start 5 次                 | 收敛到一个 `baseUrl`                          | `pnpm app-server:verify-cli-start`           |
| 缺 app-server entry   | `RUNWEAVE_CLI_APP_SERVER_ENTRY` 指向不存在文件 | start 非 0，`started:false`，不留健康 lock    | `pnpm app-server:verify-cli-start`           |
| start 超时            | entry 存在但不写健康 lock                      | CLI 非 0；Electron degraded                   | 增加临时 fake entry 脚本                     |
| token 缺失或错误      | protected HTTP/WS 不带 token 或错 token        | 401，不写事件                                 | 补充 AS-EC-007 自动化                        |
| 非 loopback Origin    | `Origin: https://example.com`                  | 403，不写事件                                 | 补充 AS-EC-007 自动化                        |
| 非法 query            | `after=abc`、`limit=0`                         | 400 或 WS policy close                        | 补充 AS-EC-007 自动化                        |
| 非法 hook payload     | 缺 terminalSessionId、payload 非 object        | 400，不写事件                                 | 补充 AS-EC-007 自动化                        |
| app-server 不可用     | backend/hook 无 app-server env/lock            | backend/hook 原能力继续                       | backend smoke、`pnpm toolkit:verify-hooks`   |
| app-server 写失败     | token 错误、连接拒绝                           | hook fallback 继续，退出码 0                  | `pnpm toolkit:verify-hooks`                  |
| runtime manifest 损坏 | 缺 entry、hash 错、路径逃逸                    | external release 被拒绝，回退 bundled/LKG     | runtime-release focused smoke                |
| consumer handler 失败 | handler throw                                  | cursor 不推进，重连后可重放                   | backend consumer focused smoke               |
| 测试清理失败          | 脚本异常退出                                   | 不残留 owner 进程和 temp state dir            | 脚本 finally + `ps` 检查                     |

## 发布前最小验收命令

按顺序执行：

```bash
git diff --check
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm runtime:build
```

若本次变更准备进入 Electron mac 发布，再执行：

```bash
pnpm dist:electron:mac
```

## 当前自动化缺口

发布前建议补齐以下自动化，否则只能作为手工验收风险接受：

1. 增加 CLI start timeout fake entry case：entry 进程存在但不写 lock 或不响应 `/healthz`，期望 CLI 非 0，Electron degraded。
2. 增加 runtime manifest focused smoke：缺 `cli.entry`、缺 `appServer.entry`、路径逃逸、hash 错、shell version 不匹配均被拒绝。
3. 增加 backend consumer focused smoke：handler throw 时 cursor 不推进，ownership 过滤拒绝不属于当前 backend 的事件。

## 完成判定

这份检查方案通过的标准不是“命令跑完一次”，而是：

- 正常路径证明 app-server 能由 CLI 启动并被 Electron/backend/hook 使用。
- 失败路径证明每个 client 都能 degraded，不破坏原主流程。
- 非法输入证明不会绕过本地鉴权、不会写入脏事件。
- runtime 路径证明发布产物不依赖源码仓库，并且坏 runtime 可回退。
- 自动化脚本能够重复运行，结束后清理进程和状态目录。
