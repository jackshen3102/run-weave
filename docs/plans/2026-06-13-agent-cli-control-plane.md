# Agent CLI 控制面补齐计划

## 目标

把 `runweave-cli` 从“首期 terminal 投递工具”补齐为面向 agent 的稳定控制面。这里的 agent 指外部自动化执行者，它通过 CLI 调用 Runweave backend，完成应用状态发现、终端创建、输入投递、投递确认、上下文读取和会话回收。

CLI 不做 Web/App 的平行客户端，不把端上所有能力机械同步过来。功能取舍标准：

- agent 是否需要它来可靠完成一次“把命令送进 Runweave terminal”的控制闭环。
- 是否能降低 agent 对 Web UI、浏览器状态和手写 HTTP 的依赖。
- 是否能保持 JSON 输出稳定，便于其它 agent 解析。
- 是否不会引入高风险破坏性操作或 UI 偏好的同步负担。

用户可见结果：

- 外部 agent 能用 `rw` 判断 Runweave backend 是否可用、认证是否有效、当前有哪些项目和终端。
- 外部 agent 能创建或复用项目/终端，投递普通行输入或 Codex slash command。
- 外部 agent 能从 `send` 输出中确认 backend 已鉴权、找到目标 terminal，并已接受输入；命令是否执行完成不属于本计划范围。
- 外部 agent 能读取 live snapshot、history snapshot、handoff 上下文和 terminal state，供后续其它机制判断执行结果。
- 外部 agent 能安全清理自己明确指定的 terminal session。

## 当前代码依据

- CLI 入口只分发 `auth`、`project`、`terminal` 三组命令：`packages/runweave-cli/src/index.ts`。
- `auth` 当前只有 `login/status`：`packages/runweave-cli/src/commands/auth.ts`。
- `project` 当前只有 `ensure`：`packages/runweave-cli/src/commands/project.ts`。
- `terminal` 当前只有 `create/list/show/snapshot/handoff/send/interrupt`：`packages/runweave-cli/src/commands/terminal.ts`。
- CLI HTTP client 当前只封装 project list/create、session list/create/get/state/input/interrupt：`packages/runweave-cli/src/client/terminal-http-client.ts`。
- 后端已经提供但 CLI 未暴露的 agent 相关接口：
  - `GET /health`：`backend/src/index.ts`。
  - `GET /api/app/home/overview`：`backend/src/routes/app-home-overview.ts`。
  - `GET /api/terminal/session/:id/history`：`backend/src/routes/terminal.ts`。
  - `DELETE /api/terminal/session/:id`：`backend/src/routes/terminal.ts`。
- 共享协议已经定义：
  - `CreateTerminalSessionRequest.command/args/inheritFromTerminalSessionId/runtimePreference`。
  - `TerminalInputMode = "raw" | "line" | "codex_slash_command"`。
  - `AppHomeOverviewResponse`。

## 非目标

- 不把 Preview 文件浏览、文件保存、删除、重命名、git diff 全量同步到本期 CLI。agent 在本地仓库执行时应直接使用文件系统和 git；远程只经 Runweave 控制应用时，第一优先级是 terminal 输入投递和投递确认。
- 不同步 Web/App 的排序偏好能力，例如 project/session reorder。排序是 UI 呈现偏好，不是 agent 控制闭环的必要条件。
- 不同步语音转写、图片上传、App 支持日志导出。它们是端上交互或排障能力，不是通用 agent 控制面。
- 不让 CLI 直接操作 tmux，不暴露 tmux orphan 清理为默认 agent 能力。tmux orphan 属于本机维护工具，后续可单独设计 `rw maintenance`。
- 不实现长期交互式 terminal TUI。CLI 保持一次命令一次输出，支持 JSON、plain 和可控超时。
- 不实现“等待命令执行完成”的能力。普通 shell 命令不会稳定产生 completion event；本期只要求 CLI 能确认输入已被 backend 接受，执行结果由后续其它手段读取或判断。
- 不新增前端测试，不涉及 Web/App UI。
- 不改变现有 `rw terminal send --confirm short` 的输出字段语义，避免破坏已有调用方。

## 设计原则

- 默认输出对 agent 友好：所有新增命令支持 `--json`，错误走非 0 exit code，并保留后端返回的错误 message。
- 默认不做破坏性动作：删除 terminal 需要显式 terminal id；项目删除、文件删除不纳入本计划。
- `send` 的成功语义是投递成功，不代表命令完成、成功退出或输出符合预期。
- terminal state 是当前业务状态，只用于状态读取和 handoff，不作为本期的完成等待机制。
- CLI 的命令名表达 agent 意图，而不是照搬 HTTP path。

## 命令面规划

### 1. `rw health`

用途：agent 在执行任务前确认 backend 可达，并拿到认证状态。

命令：

```bash
rw health --json
rw health --profile local --json
```

行为：

- 先解析 `baseUrl`，但不能调用 `resolveAuthContext()`：
  - 优先使用 `RUNWEAVE_BASE_URL`。
  - 否则读取 `ProfileStore.load()` 中指定 profile 或 active profile 的 `baseUrl`。
  - 如果没有配置文件、没有目标 profile 或 profile 没有 `baseUrl`，使用 `normalizeBaseUrl(undefined)` 的默认值。
  - 未登录不能阻止 health 检查，因为 `rw health` 必须能表达“backend 可达但用户未认证”。
- 裸请求 `GET /health`，不携带用户 `Authorization` header。
- `/health` 不是完全公开接口：后端注册为 `app.get("/health", requireTunnelAuth, ...)`，所以它只表示 backend/tunnel 可达性，不表示用户认证有效。
- 若当前 profile 或环境变量中存在 access token，再请求 `GET /api/auth/verify` 判断用户认证状态。
- backend 可达但没有 access token，或 `/api/auth/verify` 返回 401 时，exit code 为 `0`，JSON 中 `authenticated=false`。
- `/health` 返回 401/403 时，exit code 为 `3`，JSON 中 `reachable=false`、`blockedByTunnelAuth=true`，表示 backend 有响应但健康检查被 tunnel auth 阻断；不要把它误判为用户未登录。
- backend 网络不可达、DNS/连接失败或超时时，exit code 为 `3`，JSON 中 `reachable=false`。

JSON 输出：

```json
{
  "reachable": true,
  "baseUrl": "http://127.0.0.1:5001",
  "authenticated": true,
  "profile": "local",
  "blockedByTunnelAuth": false,
  "health": {
    "status": "ok"
  }
}
```

实现范围：

- 新增 `packages/runweave-cli/src/commands/health.ts`。
- 在 `packages/runweave-cli/src/index.ts` 注册 `health`。
- 新增一个轻量 baseUrl 解析 helper，例如 `resolveCliBaseUrl({ profileName, env, store })`：
  - 可以复用 `ProfileStore.load()` 和 `normalizeBaseUrl()`。
  - 不能复用 `ProfileStore.resolve()` 或 `resolveAuthContext()`，因为它们会在无登录 token 时失败。
- 复用现有 `requestJson(baseUrl, "/health")` 发起裸请求；不需要新建后端接口。
- 用户认证检查只能通过可选的 `GET /api/auth/verify` 完成；如果没有 access token，直接返回 `authenticated=false`。

验证：

```bash
pnpm --filter @runweave/cli test -- health
pnpm --filter @runweave/cli typecheck
```

验收标准：

- mock `/health` 200 时输出 `reachable=true`。
- mock `/api/auth/verify` 401 时输出 `authenticated=false`，不把 backend 判为不可达。
- 无配置文件、无 access token 时，仍会请求默认 baseUrl 的 `/health`，不会抛出 `Runweave profile "local" is not logged in`。
- 已配置 profile baseUrl 但未登录时，仍会请求该 baseUrl 的 `/health`，并输出 `authenticated=false`。
- mock `/health` 401/403 时输出 `reachable=false`、`blockedByTunnelAuth=true`，stderr 或 JSON message 明确是 tunnel auth/health 被阻断，不是用户 access token 失效。
- fetch 网络失败时 exit code 非 0，stderr 包含可读错误。

### 2. `rw app overview`

用途：agent 一次性发现当前 Runweave 应用中的 project/session 概览，避免分别调用 project list 和 terminal list 后自行拼装。

命令：

```bash
rw app overview --json
```

行为：

- 请求 `GET /api/app/home/overview`。
- 只做读取，不修改任何状态。
- 输出沿用 `AppHomeOverviewResponse`，不在 CLI 中重新推断 display status。

实现范围：

- 新增 `packages/runweave-cli/src/commands/app.ts`。
- 新增 `AppHttpClient` 或把通用 authenticated request 方法抽到清晰的 client 中。命名由执行者按现有风格决定，但不要让 terminal client 承担 app 领域职责。
- 在 `packages/runweave-cli/src/index.ts` 注册 `app`。

验证：

```bash
pnpm --filter @runweave/cli test -- app
pnpm --filter @runweave/cli typecheck
```

验收标准：

- mock overview 返回 projects/sessions 时，CLI 原样输出可解析 JSON。
- 未认证时保持现有 401 错误处理和自动 refresh 行为。

### 3. `rw project list`

用途：agent 需要按路径、名称或 id 决定是否创建 terminal。当前 `project ensure` 可以创建或复用，但缺少只读发现能力。

命令：

```bash
rw project list --json
rw project ensure --name browser-viewer --path "$PWD" --json
```

行为：

- `project list` 请求 `GET /api/terminal/project`。
- 保留现有 `project ensure` 行为。
- 本计划不新增 `project update/delete/reorder`。

实现范围：

- 扩展 `packages/runweave-cli/src/commands/project.ts`。
- 复用现有 `TerminalHttpClient.listProjects()`。

验证：

```bash
pnpm --filter @runweave/cli test -- project
pnpm --filter @runweave/cli typecheck
```

验收标准：

- `project list --json` 输出后端项目数组。
- `project ensure` 现有测试或行为不变。

### 4. 增强 `rw terminal create`

用途：agent 需要创建普通 shell、继承上下文或启动指定命令，而不是只能创建默认 shell。

命令：

```bash
rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json
rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command codex --arg "--model" --arg "gpt-5" --json
rw terminal create --inherit-from "$TERMINAL_ID" --json
```

行为：

- 支持现有 `--project-id`、`--cwd`、`--runtime`。
- 新增 `--command <command>`。
- 新增可重复 `--arg <value>`，映射到 `args: string[]`。
- 新增 `--inherit-from <terminalSessionId>`，映射到 `inheritFromTerminalSessionId`。
- 当使用 `--inherit-from` 且未提供 `--project-id` 或 `--cwd` 时，由后端按现有 create defaults 处理。

实现范围：

- 不扩展 `packages/runweave-cli/src/args.ts` 的全局返回类型。当前 parser 是 `Record<string, string | boolean>`，全局支持重复 option 会影响所有命令调用方，超出本计划范围。
- 在 `packages/runweave-cli/src/commands/terminal.ts` 的 create 分支对原始 `args: string[]` 做局部扫描，提取所有 `--arg <value>` 和 `--arg=<value>`。
- 局部扫描必须保留其它 option 继续走现有 `parseArgs()`，避免重写通用 parser。
- 扩展 `packages/runweave-cli/src/commands/terminal.ts` 的 create 分支。
- 不修改 shared 协议类型。

验证：

```bash
pnpm --filter @runweave/cli test -- terminal
pnpm --filter @runweave/cli typecheck
```

验收标准：

- `--command` 和多个 `--arg` 被正确序列化到 `CreateTerminalSessionRequest`。
- 重复 `--arg` 不会被 `parseArgs()` 覆盖丢失。
- `--arg` 缺少 value 时返回 usage 错误。
- `--inherit-from` 被正确序列化。
- 未传新增参数时，现有 create 请求 body 不发生不兼容变化。

### 5. 增强 `rw terminal send`

用途：agent 需要明确选择输入语义，尤其是 shell 行输入和 Codex slash command。

命令：

```bash
rw terminal send "$TERMINAL_ID" --text "pwd" --mode line --json
rw terminal send "$TERMINAL_ID" --text "/compact" --mode codex_slash_command --json
rw terminal send "$TERMINAL_ID" --stdin --mode raw --json
```

行为：

- 新增 `--mode raw|line|codex_slash_command`，默认保持现有 raw 行为。
- `--enter` 继续兼容旧调用方；当 `--mode line` 时不要求再传 `--enter`。
- `--mode codex_slash_command` 不自动追加换行，交给后端已有 slash command 逻辑处理。
- 如果同时传 `--mode line` 和 `--enter`，不重复提交回车；CLI 只发送 `{ data, mode: "line" }`。

实现范围：

- 扩展 `packages/runweave-cli/src/commands/terminal.ts`。
- 复用 `SendTerminalInputRequest.mode`。
- 更新 `docs/cli/terminal-cli.md` 中 send 示例。

验证：

```bash
pnpm --filter @runweave/cli test -- terminal
pnpm --filter @runweave/cli typecheck
```

验收标准：

- `--mode line` 请求 body 为 `{ "data": "pwd", "mode": "line", "operationId": ... }` 或不含 operationId 时仍符合现有协议，不发送 `pwd\r`。
- 默认 raw + `--enter` 保持现有 `pwd\r` 兼容输出。
- `codex_slash_command` 非法输入由后端返回错误，CLI 不吞掉错误 message。

### 6. `rw terminal state`

用途：agent 需要单独读取权威 terminal state，而不是只能通过 `handoff` 间接获取。

命令：

```bash
rw terminal state "$TERMINAL_ID" --json
```

行为：

- 请求 `GET /api/terminal/session/:id/state`。
- 输出 `{ terminalSessionId, terminalState }`，terminalState 原样来自后端。

实现范围：

- 扩展 `packages/runweave-cli/src/commands/terminal.ts`。
- 复用 `TerminalHttpClient.getCurrentTerminalState()`。

验证：

```bash
pnpm --filter @runweave/cli test -- terminal
```

验收标准：

- 输出包含 `terminalSessionId`、`terminalState.state`、`terminalState.agent`。

### 7. `rw terminal history`

用途：agent 需要读取后端 capture 的历史 scrollback，用于比 live snapshot 更稳定的上下文读取。

命令：

```bash
rw terminal history "$TERMINAL_ID" --tail 200 --plain
rw terminal history "$TERMINAL_ID" --tail 200 --json
```

行为：

- 请求 `GET /api/terminal/session/:id/history`。
- `--plain` 输出 tail 文本。
- `--json` 输出后端 payload 加上 `tail` 字段，保持 `snapshot` 的输出习惯。

实现范围：

- `TerminalHttpClient` 新增 `getSessionHistory()`。
- `runTerminalCommand()` 新增 `history` 分支。

验证：

```bash
pnpm --filter @runweave/cli test -- terminal
```

验收标准：

- 请求 path 是 `/api/terminal/session/:id/history`。
- `--tail` 校验规则与 `snapshot` 一致。

### 8. `rw terminal delete`

用途：agent 清理自己明确指定的 terminal，避免自动化任务制造长期无用 session。

命令：

```bash
rw terminal delete "$TERMINAL_ID" --json
```

行为：

- 请求 `DELETE /api/terminal/session/:id`。
- 只支持按 terminal id 删除，不支持批量删除。
- 成功输出 `{ "terminalSessionId": "...", "deleted": true }`。
- 404 仍按错误处理，不伪装成功。

实现范围：

- `TerminalHttpClient` 新增 `deleteSession()`。
- `runTerminalCommand()` 新增 `delete` 分支。

验证：

```bash
pnpm --filter @runweave/cli test -- terminal
```

验收标准：

- 请求 method 为 `DELETE`。
- 成功 204 时 CLI 输出可解析 JSON。

## 暂不实现但保留后续入口

### Preview 文件能力

本期不做 `rw preview`。原因：

- 对本地 agent，文件读写和 git diff 应直接通过 workspace 文件系统和 git 命令完成。
- 对远程 agent，Preview 文件能力会引入编辑冲突、mtime、二进制 asset、路径安全和删除风险，计划粒度应单独展开。

后续如果要做，只建议从只读开始：

- `rw preview changes --project-id ...`
- `rw preview diff --project-id ... --path ... --kind working|staged`
- `rw preview cat --project-id ... --path ...`

不要在同一批次加入 save/delete/rename。

### WebSocket ticket

本期不暴露 `ws-ticket` 命令。原因：

- agent CLI 的默认模式是短进程命令和 HTTP 轮询。
- 直接暴露 ticket 会把 WebSocket 生命周期复杂度转移给调用 agent。

如果未来需要高频事件订阅，可单独设计：

- `rw terminal watch-events --terminal-id ...`

### Terminal events 和 wait

本期不实现 `rw terminal events` 和 `rw terminal wait`。原因：

- 用户要求本期范围是“把命令发送出去，发送成功即可”，不覆盖命令是否执行完成。
- 普通 shell 命令不会稳定产生 completion event，把 completion wait 放进默认 agent 路径会误导执行者。
- `TerminalEventEnvelope` 仍是有价值的后续能力，但它属于“任务完成观察/订阅”设计，不属于本期投递控制面。

后续如果要做，应单独设计并明确适用场景：

- `rw terminal events --after ... --terminal-id ...`：只读查询事件。
- `rw terminal wait --for completion ...`：仅适用于确认继承 Runweave hooks 的 AI CLI 场景。
- `rw terminal wait --for state ...`：仅作为状态变化等待，不声明普通命令已执行完成。
- 如果未来实现 wait timeout，不能复用 exit code `4`；现有 `HttpError` 已把 404 映射为 `4`，timeout 必须使用独立 exit code，或明确规定 JSON 字段是唯一判别标准。

### Tmux orphan 维护

本期不暴露。它是本机维护操作，不是 agent 控制当前应用的常规能力。后续如果需要，应放在 `rw maintenance tmux-orphans`，并要求 `--confirm`。

## 文档更新

修改文件：

- `docs/cli/terminal-cli.md`

要求：

- 把定位从“首期 terminal CLI”更新为“Agent CLI 控制面”。
- 增加推荐 agent 闭环：

```bash
rw health --json
rw app overview --json
PROJECT_ID=$(rw project ensure --name browser-viewer --path "$PWD" --json | jq -r '.projectId')
TERMINAL_ID=$(rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json | jq -r '.terminalSessionId')
rw terminal send "$TERMINAL_ID" --text "pnpm typecheck" --mode line --json
rw terminal history "$TERMINAL_ID" --tail 200 --plain
```

- 明确 `send` 成功只代表输入已被 backend 接受，不代表命令执行完成。
- 明确普通 shell 命令的完成判断不属于本计划范围；后续可以通过 history/snapshot 或其它机制读取结果。

## 实施顺序

1. 增加只读发现能力：`health`、`app overview`、`project list`。
2. 增强 terminal 输入和创建：`create --command/--arg/--inherit-from`、`send --mode`。
3. 增加状态和上下文读取：`terminal state`、`terminal history`。
4. 增加安全清理：`terminal delete`。
5. 更新 `docs/cli/terminal-cli.md`。

这个顺序允许每一步独立合入和验证；前 3 步完成后，agent 已经能完成更可靠的投递确认和上下文读取；第 4 步只补齐显式清理能力。

## 测试计划

新增或扩展测试文件：

- `packages/runweave-cli/src/commands/terminal.test.ts`
- `packages/runweave-cli/src/commands/project.test.ts`，如执行者认为现有 terminal test 继续承载 project 不清晰。
- `packages/runweave-cli/src/commands/health.test.ts`
- `packages/runweave-cli/src/commands/app.test.ts`

测试重点：

- 命令参数到 HTTP method/path/body 的映射。
- JSON/plain 输出是否稳定。
- 401 自动 refresh 路径继续沿用现有 auth context。
- 多个 `--arg` 的局部扫描不会被现有 `parseArgs()` 覆盖。
- `send --mode line` 不重复追加回车。
- `send` 默认行为向后兼容。

验证命令：

```bash
pnpm --filter @runweave/cli test
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli build
```

如果改动触及 shared 类型导出，再运行：

```bash
pnpm --filter @runweave/shared typecheck
pnpm typecheck
```

本计划不要求浏览器验证；如果后续执行过程中需要打开页面确认端上状态，必须使用 `$playwright-cli`。

## 验收清单

- `rw health --json` 能区分 backend 不可达、backend 可达但未认证、backend 可达且已认证。
- `rw app overview --json` 能返回当前 projects/sessions 概览。
- `rw project list --json` 能只读列出项目。
- `rw terminal create` 支持 `--command`、多个 `--arg` 和 `--inherit-from`。
- `rw terminal send` 支持 `--mode raw|line|codex_slash_command`，旧参数行为不破坏。
- `rw terminal state` 能输出权威 `TerminalState`。
- `rw terminal history` 能读取 history capture 并支持 `--tail`。
- `rw terminal delete` 只删除显式指定 terminal id。
- `docs/cli/terminal-cli.md` 更新了 agent 推荐使用方式，并明确 `send` 成功不代表命令执行完成。

## 风险与约束

- `send --mode line` 和旧 `--enter` 容易双回车，必须用测试固定请求 body。
- `--arg` 必须局部扫描，不能把 `parseArgs()` 全局类型扩展成数组并连带影响其它命令。
- 删除 terminal 是破坏性操作，必须只按用户传入 id 执行，不做批量推断。
- 不要为了 CLI 引入 `packages/common` 依赖；CLI 可以依赖 `@runweave/shared`，不能依赖 Web/App 前端服务层。
