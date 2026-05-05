# Runweave Terminal CLI 控制面方案

**日期：** 2026-05-04
**状态：** 讨论稿，不进入实现
**目标：** 提供一个可被 OpenCloud、OpenClaw、Hermes 等外部 agent 调用的 CLI，把 Runweave 现有终端管理能力固化成稳定命令，重点支持向指定终端可靠发送输入、读取快照/上下文，并可选等待 AI CLI hook completion event。在 Hermes/Feishu 场景中默认不长时间等待，由现有 Codex hooks 负责完成通知。

## 背景判断

当前仓库已经具备首期 CLI 所需的主要底座：

- 终端 project/session 管理由 `backend/src/routes/terminal.ts` 暴露，包含 project 创建、session 创建、列表、状态、history、mobile overview、ws ticket、删除等接口。
- 前端实时输入输出走 `/ws/terminal`，协议类型在 `packages/shared/src/terminal-protocol.ts`，前端 `useTerminalConnection` 已经验证了 ticket 获取、WebSocket 连接、输入、resize、signal、snapshot、output、status 的完整链路；CLI 投递不复用这条实时链路。
- tmux-backed terminal 已经把 `RUNWEAVE_TERMINAL_SESSION_ID`、`RUNWEAVE_PROJECT_ID`、`RUNWEAVE_TMUX_SESSION_NAME`、`RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN` 注入 pane 环境，完成事件通过 `/internal/terminal-completion` 写入，并由 `/api/terminal/completion-events` 读取。
- 移动端 `/mobile/terminals` 目前通过 `/api/terminal/mobile/overview` 拉取 project/session/tail，并提供 Hermes handoff 文案。CLI 可以复用同一 overview 语义，但不再要求人工复制 tmux 信息。

因此首期 CLI 不直接操作 tmux，也不接管前端实时 WebSocket。CLI 作为 Runweave backend 的正式命令行客户端，复用现有 HTTP API、补充很薄的 HTTPS input 接口，并复用 completion hook 事件。

## 首期目标

1. 外部 agent 能登录并保存 Runweave backend 连接信息。
2. 外部 agent 能幂等确认 project、创建 terminal、列出 terminal、读取 terminal show/snapshot/handoff 上下文。
3. 外部 agent 能向指定 terminal 发送输入，包括普通文本和回车。
4. 外部 agent 能执行一次“读取目标 terminal 状态 -> 发送输入 -> 短暂确认输入被接收 -> 返回 terminal 快照/上下文”的自动化流程。
5. completion event 等待作为可选模式；Hermes/Feishu 场景默认不等待长期任务完成，因为 Codex hooks 会在任务完成后主动发送飞书通知。
6. CLI 输出默认适合机器消费，首期 MVP 验收 `--json` 和 `--plain`；`--stream` 放到后续实验性 `exec` 能力。

## 非目标

- 不在首期重做后端鉴权模型；CLI 使用现有 `/api/auth/login`、`/api/auth/refresh`、`Authorization: Bearer`。
- 不暴露 `RUNWEAVE_HOOK_TOKEN` 给 CLI 用户；hook token 仍只用于本机内部 completion 写入。
- 不把 CLI 做成 terminal daemon；首期 CLI 是短生命周期命令，按需通过 HTTPS 调用 backend。
- 不解析 Codex、Hermes、OpenClaw 的业务输出格式；首期只负责可靠输入、短确认、快照/上下文返回，以及可选 completion event 等待。
- 不为前端新增单测；若涉及前端移动页参考或轻微调整，只用 E2E 或手工验证。
- 不直接调用 `tmux send-keys` 作为常规路径。只有后续明确需要“backend 不可达但 tmux 仍在”的灾备模式时再单独设计。
- 不在首期实现 `rw terminal attach` 这种持续交互式终端接管；先保证 agent 自动化所需的 `send`、`snapshot`、`handoff` 和 terminal 基础查询。

## 推荐架构

```text
OpenCloud / OpenClaw / Hermes
  -> rw CLI
    -> Auth/profile store
    -> Terminal HTTP client
    -> Optional completion-event waiter
      -> Runweave backend
        -> TerminalSessionManager
        -> TerminalRuntimeRegistry / tmux-backed runtime
        -> /api/terminal/session/:id/input
        -> /api/terminal/completion-events
```

### 新增包

新增 workspace 包：

```text
packages/runweave-cli/
```

建议包名和 binary：

```json
{
  "name": "@runweave/cli",
  "bin": {
    "rw": "./dist/index.js"
  }
}
```

原因：

- `packages/*` 已经在 `pnpm-workspace.yaml` 中。
- 仓库内部技术命名仍是 `browser-viewer`，但用户可见命令用 `rw`。
- CLI 与前端、Electron 解耦，后续可以单独打包发布或被其他 agent runtime 依赖。

### CLI 内部模块

```text
packages/runweave-cli/src/index.ts
packages/runweave-cli/src/commands/auth.ts
packages/runweave-cli/src/commands/project.ts
packages/runweave-cli/src/commands/terminal.ts
packages/runweave-cli/src/config/profile-store.ts
packages/runweave-cli/src/client/auth-client.ts
packages/runweave-cli/src/client/terminal-http-client.ts
packages/runweave-cli/src/client/completion-event-client.ts
packages/runweave-cli/src/output/format.ts
```

`terminal-http-client.ts` 复用 `@browser-viewer/shared` 类型，不从前端 `services/terminal.ts` 反向依赖，避免 CLI 包依赖浏览器侧代码。

### 配置存储

首期使用用户级配置：

```text
~/.runweave/config.json
```

记录内容：

```json
{
  "activeProfile": "local",
  "profiles": {
    "local": {
      "baseUrl": "http://127.0.0.1:5001",
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": "2026-05-04T12:00:00.000Z"
    }
  }
}
```

约束：

- 文件权限创建为 `0600`。
- 不保存密码。
- `accessToken` 过期前直接用，过期后通过 `/api/auth/refresh` 刷新。
- `--profile` 覆盖 active profile。
- `RUNWEAVE_BASE_URL`、`RUNWEAVE_ACCESS_TOKEN` 可覆盖配置，用于 CI 或 agent 宿主注入。

## 命令设计

首期 MVP 只验收这些命令：

```bash
rw auth login --base-url http://127.0.0.1:5001 --username admin
rw auth status --json
rw project ensure --name my-app --path /path/to/my-app --json
rw terminal create --project-id <projectId> --cwd /repo --runtime auto --json
rw terminal list --json
rw terminal show <terminalSessionId> --json
rw terminal handoff <terminalSessionId> --tail 120 --json
rw terminal snapshot <terminalSessionId> --tail 120 --json
rw terminal send <terminalSessionId> --text "继续修复刚才的问题" --enter --confirm short --json
```

其他管理命令、`terminal signal` 和 `exec --wait/idle/stream` 可以保留在设计里，但不进入首期 MVP 验收。

### Auth

```bash
rw auth login --base-url http://127.0.0.1:5001 --username admin
rw auth status --json
```

`auth login` 行为：

- 未传 `--password` 时从 stdin 安全读取。
- 请求 `POST /api/auth/login`，header 带 `x-auth-client: electron`，以便拿到 refresh token JSON。
- 登录成功后写入 profile store。

### Project

```bash
rw project ensure --name my-app --path /path/to/my-app --json
```

对应现有接口：

- `GET /api/terminal/project`
- `POST /api/terminal/project`

`project ensure` 是 CLI 本地幂等能力：先按规范化后的 `path` 查找已有 project，命中则返回已有 project；未命中再调用 `POST /api/terminal/project` 创建。这个命令适合 Hermes/OpenClaw 自动化，避免重复创建同一路径的 project。

`rw project list/create/update/delete` 可以作为后续普通管理命令补充，不进入首期 MVP 验收。

### Terminal 基础管理

```bash
rw terminal list --json
rw terminal create --project-id <projectId> --cwd /repo --runtime auto --json
rw terminal show <terminalSessionId> --json
rw terminal snapshot <terminalSessionId> --tail 120 --json
rw terminal snapshot <terminalSessionId> --tail 120 --plain
rw terminal handoff <terminalSessionId> --tail 120 --json
```

对应现有接口：

- `GET /api/terminal/session`
- `POST /api/terminal/session`
- `GET /api/terminal/session/:id`

`snapshot --tail` 在 CLI 本地截取行数即可，首期不需要新增后端 query 参数。

`terminal handoff` 聚合 Hermes 需要的一次性上下文，首期从 `list`、`show` 和 `snapshot` 的返回中组合，不新增后端接口。JSON 输出包含：

```json
{
  "terminalSessionId": "abc12345",
  "projectId": "project-id",
  "projectName": "browser-viewer",
  "cwd": "/Users/bytedance/Code/browser-hub/browser-viewer",
  "runtimeKind": "tmux",
  "tmuxSessionName": "runweave-abc12345",
  "activeCommand": "codex",
  "inferredAgent": "codex",
  "inferredState": "working",
  "tail": "last 120 lines",
  "suggestedCommands": [
    "rw terminal send abc12345 --text \"继续\" --enter --confirm short --json",
    "rw terminal snapshot abc12345 --tail 120 --plain"
  ]
}
```

`inferredAgent` / `inferredState` 是 CLI 本地弱推断，来源于 `activeCommand`、tail 文本和 terminal list/show 信息；推断不确定时返回 `"unknown"`，不能作为权限或调度依据。

`runtimeKind`、`tmuxSessionName` 等 tmux 字段只用于诊断和排障。外部 agent 常规操作必须通过 `rw terminal send`、`rw terminal snapshot`、`rw terminal handoff` 等 CLI 命令完成，不依赖 tmux session name，也不直接执行 `tmux send-keys`。

`rw terminal overview/history/delete` 可以作为后续普通管理命令补充，不进入首期 MVP 验收。

### Terminal Send

```bash
rw terminal send <terminalSessionId> --text "继续修复刚才的问题" --enter --confirm short --json
rw terminal send <terminalSessionId> --stdin --enter --confirm none --json
```

实现方式：

- 直接请求 `POST /api/terminal/session/:id/input`。
- 请求体为 `{ "operationId": "...", "data": "..." }`。

`--enter` 追加 `\r`，与浏览器终端现有行为一致。

`--confirm` 支持：

- `none`：HTTPS input 接口返回成功后立即返回。
- `short`：发送后按固定算法观察输出和最新 snapshot，默认 `confirmTimeoutMs=3000`，目标是确认输入被 terminal 接收或进入工作态，不等待任务完成。

`short` 确认算法必须可测试，按下面顺序实现：

1. 发送前读取 `GET /api/terminal/session/:id`，得到 `tailBefore` 和 `sendStartedAt`。
2. 调用 HTTPS input 接口，并传入本次 `operationId` 和输入数据。
3. input 接口成功返回后设置 `transport="http"`、`inputAccepted=true`、`inputEnqueued=true`。
4. 只有 input 接口返回 4xx/5xx 或 backend runtime write 抛错才视为发送失败；后续观察字段只影响置信度。
5. 如果发送文本以 `\r`/`\n` 结束，或显式传了 `--enter`，设置 `submitted=true`。
6. 发送后最多观察 `confirmTimeoutMs`，默认 `3000` ms。
7. 观察窗口结束后再次读取 snapshot，得到 `tailAfter`。
8. 如果 `tailAfter` 包含发送文本或发送文本的可配置前缀，设置 `echoObserved=true`。
9. 如果 shell prompt、active command 或 tail 模式发生可识别变化，设置 `promptChanged=true`。
10. 如果 `activeCommand` 或 `tailAfter` 模式显示 agent working，设置 `observedState="agent_running"`；如果显示 shell prompt 且无活跃命令，设置 `observedState="idle_shell"`；否则设置 `observedState="unknown"`。
11. `confirmConfidence` 计算规则：

- `high`：`echoObserved=true`，或 `observedState="agent_running"`。
- `medium`：`promptChanged=true`，但没有 echo 或 agent running 证据。
- `low`：input 接口成功，但没有观察到 echo 或状态变化。

14. `confirmConfidence="low"` 不直接失败；外部 agent 可选择 retry、snapshot 或询问用户。

`send --confirm short --json` 返回：

```json
{
  "operationId": "op_20260505_abcdef12",
  "terminalSessionId": "abc12345",
  "transport": "http",
  "inputAccepted": true,
  "inputEnqueued": true,
  "runtimeKind": "tmux",
  "acceptedAt": "2026-05-05T00:00:01.000Z",
  "submitted": true,
  "confirmMode": "short",
  "confirmTimeoutMs": 3000,
  "echoObserved": true,
  "promptChanged": false,
  "observedState": "agent_running",
  "confirmConfidence": "medium",
  "tailBefore": "tail before send",
  "tailAfter": "› 继续修复刚才的问题\n• Working ...",
  "hook": {
    "completionExpected": true,
    "expectedSource": "codex",
    "notificationOwner": "existing-ai-cli-hooks"
  },
  "note": "Completion will be delivered by configured AI CLI hook if available."
}
```

`operationId` 是 CLI 本地生成的本次投递关联 ID，用于 Hermes/OpenClaw 日志和飞书回复。首期不要求后端 hook event 回传 `operationId`；hook 关联通过 `terminalSessionId`、`sendStartedAt`、`expectedSource` 和后续 completion event 时间过滤建立。

字段语义分成强保证和弱推断：

| 字段                       | 语义                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `transport`                | CLI 使用的投递通道，首期为 `http`。                                                                  |
| `inputAccepted`            | 后端 HTTPS input 接口已鉴权、找到目标 terminal，并接受该投递操作。                                   |
| `inputEnqueued`            | 后端已调用 terminal runtime 写入或入队；tmux paced runtime 下不代表所有字节已经从 timer flush 完成。 |
| `runtimeKind`              | 目标 terminal 当前 runtime 类型，`tmux` 或 `pty`。                                                   |
| `submitted`                | 输入包含换行或显式 `--enter`，表示 CLI 尝试提交，而不代表 TUI 已开始执行。                           |
| `echoObserved`             | 从 terminal snapshot 观察到输入文本或输入前缀，是启发式。                                            |
| `promptChanged`            | 从 prompt / activeCommand / tail 模式观察到变化，是启发式。                                          |
| `observedState`            | 基于 tail / activeCommand 的弱推断，不能作为权限、调度或最终完成依据。                               |
| `confirmConfidence`        | `high` / `medium` / `low`，表示短确认置信度，不是强保证。                                            |
| `tailBefore` / `tailAfter` | 发送前后 tail，供外部 agent 自行判断是否 retry、snapshot 或询问用户。                                |

`rw terminal signal <terminalSessionId> SIGINT` 可以作为后续停止任务能力补充，不进入首期 MVP 验收。

### 后续实验能力：Terminal exec

```bash
rw terminal exec <terminalSessionId> --text "codex status" --wait completion --source codex --json
rw terminal exec <terminalSessionId> --stdin --wait idle --idle-ms 1500 --timeout-ms 120000 --plain
rw terminal exec <terminalSessionId> --text "npm test" --wait idle --stream
```

`exec --wait completion/idle/stream` 不进入首期 MVP 验收。它适合后续自动化脚本、CI 或 OpenCloud 后台任务，不适合作为 Hermes/Feishu 默认交互路径。

`completion` 模式下，如果超时：

- exit code 为 `124`。
- JSON 输出包含 `timedOut: true`、`waitMode: "completion"`、`terminalSessionId`、`capturedOutput`、`finalSnapshotTail`。

## 输出协议

默认 `--plain`：

```text
<收集到的终端输出>
```

后续实验性 `--stream`：

```text
逐块输出 completion/snapshot 观察结果，不包 JSON；若需要真正的实时输出流，应另行设计 attach/stream 模式，而不是让 `send` 复用前端 WebSocket。
```

`--json`：

`send --confirm short` 输出：

```json
{
  "operationId": "op_20260505_abcdef12",
  "terminalSessionId": "abc12345",
  "transport": "http",
  "inputAccepted": true,
  "inputEnqueued": true,
  "runtimeKind": "tmux",
  "submitted": true,
  "confirmMode": "short",
  "confirmTimeoutMs": 3000,
  "echoObserved": false,
  "promptChanged": false,
  "observedState": "unknown",
  "confirmConfidence": "low",
  "tailBefore": "tail before send",
  "tailAfter": "last visible terminal tail",
  "hook": {
    "completionExpected": true,
    "expectedSource": "codex",
    "notificationOwner": "existing-ai-cli-hooks"
  }
}
```

后续 `exec --wait completion` 实验输出：

```json
{
  "terminalSessionId": "abc12345",
  "projectId": "project-id",
  "waitMode": "completion",
  "completed": true,
  "timedOut": false,
  "completionEvent": {
    "id": "12",
    "source": "codex",
    "hookEvent": "Stop",
    "createdAt": "2026-05-04T12:00:00.000Z"
  },
  "capturedOutput": "new output since command was sent",
  "finalSnapshotTail": "last visible terminal tail"
}
```

机器消费约束：

- 所有错误走 stderr。
- JSON 模式下 stdout 只输出一段合法 JSON。
- exit code 约定：
  - `0`：命令完成。
  - `1`：普通执行失败。
  - `2`：参数错误。
  - `3`：认证失败。
  - `4`：terminal/session 不存在。
  - `124`：等待超时。

## 后端改造范围

首期尽量不改后端接口。只有在实现中发现现有接口不足时，才补以下小接口：

1. `GET /api/terminal/completion-events?after=<id>` 已存在，先复用。
2. `POST /api/terminal/session/:id/input` 是 CLI 投递入口。
3. 首期 `send --confirm short` 不要求新增服务端 correlation id；`operationId` 由 CLI 本地生成并写入 JSON 输出。
4. 如果后续 `exec completion` 需要准确 baseline event id，可让 CLI 首次请求 `completion-events` 并取最大 id，不新增接口。
5. `POST /api/terminal/session/:id/input` 作为 CLI 的投递入口，避免 CLI 依赖 WebSocket ticket 和前端实时连接语义。

## 安全边界

- CLI 用户权限等同登录用户权限，不使用 internal hook token。
- profile store 必须 `0600`，避免 refresh token 被其他本机用户读取。
- `terminal send/exec` 默认需要明确 terminal id；不根据项目名模糊发送，避免误操作其他终端。
- `terminal send/exec` 对 stdin 最大输入长度设置默认上限，例如 256 KiB，超限时报错；大文件传输另走后续文件能力设计。

## 实施分期

### Phase 1：CLI 包和认证

文件范围：

- `packages/runweave-cli/package.json`
- `packages/runweave-cli/tsconfig.json`
- `packages/runweave-cli/src/index.ts`
- `packages/runweave-cli/src/config/profile-store.ts`
- `packages/runweave-cli/src/client/auth-client.ts`
- 根 `package.json` 增加 `cli:*` 辅助脚本，或只通过 `pnpm --filter ./packages/runweave-cli` 调用。

验收：

```bash
pnpm --filter ./packages/runweave-cli build
pnpm --filter ./packages/runweave-cli test
node packages/runweave-cli/dist/index.js auth status --json
```

### Phase 2：Project ensure、Terminal list / show / snapshot / handoff

文件范围：

- `packages/runweave-cli/src/commands/project.ts`
- `packages/runweave-cli/src/commands/terminal.ts`
- `packages/runweave-cli/src/client/terminal-http-client.ts`
- `packages/runweave-cli/src/output/format.ts`

验收：

```bash
pnpm dev
node packages/runweave-cli/dist/index.js auth login --base-url http://127.0.0.1:5000 --username admin
node packages/runweave-cli/dist/index.js project ensure --name browser-viewer --path "$PWD" --json
node packages/runweave-cli/dist/index.js terminal create --project-id <projectId> --cwd "$PWD" --json
node packages/runweave-cli/dist/index.js terminal list --json
node packages/runweave-cli/dist/index.js terminal show <terminalSessionId> --json
node packages/runweave-cli/dist/index.js terminal snapshot <terminalSessionId> --tail 120 --json
node packages/runweave-cli/dist/index.js terminal handoff <terminalSessionId> --tail 120 --json
```

### Phase 3：HTTPS send 和短确认

文件范围：

- `packages/runweave-cli/src/client/terminal-http-client.ts`
- `packages/runweave-cli/src/commands/terminal.ts`

验收：

```bash
node packages/runweave-cli/dist/index.js terminal send <terminalSessionId> --text "echo runweave-cli-ok" --enter --confirm short --json
node packages/runweave-cli/dist/index.js terminal snapshot <terminalSessionId> --tail 120 --plain
```

预期：

- `send --confirm short` 返回 `operationId`、`transport`、`inputAccepted`、`inputEnqueued`、`runtimeKind`、`submitted`、`echoObserved`、`promptChanged`、`observedState`、`confirmConfidence`。
- JSON 包含发送前后的 `tailBefore` / `tailAfter`，便于 Hermes 回复“已投递并进入工作态”。
- JSON 包含 `hook.completionExpected` 和 `hook.expectedSource`，说明后续完成通知由现有 AI CLI hooks 承担。
- `confirmConfidence="low"` 不导致 exit code 非 0；只有 HTTPS input 请求失败或 backend runtime write 抛错才视为发送失败。
- 对不存在的 terminal id 返回 exit code `4`。
- token 过期时自动 refresh；refresh 失败返回 exit code `3`。

### Phase 4：MVP 验收闭环

文件范围：

- `packages/runweave-cli/src/client/terminal-http-client.ts`
- `packages/runweave-cli/src/commands/terminal.ts`

验收：

```bash
node packages/runweave-cli/dist/index.js terminal handoff <terminalSessionId> --tail 120 --json
node packages/runweave-cli/dist/index.js terminal send <terminalSessionId> --text "总结当前仓库状态" --enter --confirm short --json
node packages/runweave-cli/dist/index.js terminal snapshot <terminalSessionId> --tail 120 --json
```

预期：

- `handoff` 能返回目标 terminal 的 `cwd`、`activeCommand`、`inferredAgent`、`inferredState`、`tail` 和建议命令。
- `send --confirm short` 不长时间等待任务完成，返回 `operationId`、投递强保证字段、短确认弱推断字段、`tailBefore`、`tailAfter`、`hook`。
- 对 Codex TUI，短确认能看到输入已进入 TUI，或看到 `Working` / 等价运行态；无法确定时 `observedState` 返回 `"unknown"`，但 `inputAccepted` / `inputEnqueued` 仍反映 backend input 接口已接收并写入或入队。
- `snapshot --json` 能在投递后读取最新 tail，供 Hermes 总结或回传飞书。

### Phase 5：实验性 wait / idle / stream，不进入首期 MVP 验收

文件范围：

- `packages/runweave-cli/src/client/completion-event-client.ts`
- `packages/runweave-cli/src/commands/terminal.ts`
- 必要时补 `packages/shared/src/terminal-protocol.ts` 类型导出。

验收：

```bash
node packages/runweave-cli/dist/index.js terminal exec <terminalSessionId> --text "pwd" --wait idle --plain
node packages/runweave-cli/dist/index.js terminal exec <terminalSessionId> --text "codex ..." --wait completion --source codex --timeout-ms 600000 --json
```

预期：

- idle 模式能返回普通 shell 短命令的输出，例如 `pwd`。
- completion 模式在 Codex hook 发出 Stop 后退出，JSON 中包含匹配到的 completion event。
- completion 超时时 exit code 为 `124`，stdout JSON 仍可被外部 agent 解析。
- completion event 过滤至少使用 `terminalSessionId`、`source`、`createdAt >= sendStartedAt`，避免误消费同一 terminal 的旧任务事件。

### Phase 6：文档和 agent 接入样例

文件范围：

- `docs/cli/terminal-cli.md`
- `docs/architecture/terminal-completion-hooks.md` 增补 CLI 消费 completion event 的说明。

样例：

```bash
rw terminal send "$TERMINAL_ID" \
  --text "修复 typecheck 报错，完成后总结改动" \
  --enter \
  --confirm short \
  --json
```

验收：

- 文档包含 OpenCloud/Hermes 调用 CLI 的最小命令序列。
- 文档明确 Hermes/Feishu 默认使用 `send --confirm short`，不阻塞等待 Codex 长任务完成。
- 文档明确 completion event 依赖 Runweave tmux-backed terminal 内启动的 AI CLI。
- 文档明确旧 pane、外部系统终端、hook 未安装时不能靠 completion 模式完成。

## 测试策略

- CLI 纯逻辑使用 Vitest，范围限定在 `packages/runweave-cli`，不触碰前端测试约束。
- HTTP client 用 mock fetch 覆盖认证刷新、错误码、JSON/plain 输出。
- HTTP client / command 用 mock fetch 覆盖 send、错误码和短确认输出。
- 端到端信心通过真实 backend 验证：

```bash
pnpm --filter ./packages/runweave-cli test
pnpm --filter ./packages/runweave-cli build
pnpm --filter ./backend test -- src/routes/terminal.test.ts src/ws/terminal-server.test.ts
pnpm run test:e2e -- tests/terminal.spec.ts
```

若只改 CLI 包且未改 backend/shared，可不跑前端 E2E；若改 shared protocol 或 backend terminal 行为，必须跑对应 backend 测试和终端 E2E。

## 需要讨论的决策

1. CLI 配置路径固定使用 `~/.runweave/config.json`，不沿用历史 `browser-viewer` 命名。
2. binary 名称使用 `rw` 还是兼容一个 `browser-viewer` alias。首期建议只暴露 `rw`，package 名使用 `@runweave/cli`。
3. 是否需要首期提供 `terminal find`，通过 project 名、cwd 或最近活跃 session 自动选 terminal。出于误操作风险，首期建议不做。
4. `terminal handoff` 的 `inferredState` 是否需要从第一期就做 Codex/Coco/Trae 特化规则。首期建议只做弱推断，不把它作为调度依据。
5. `terminal signal` 是否进入第一期。它对停止错误任务有价值，但不是投递闭环必需；如果要进一步收敛，可以放到 Phase 5 之后。
6. 是否要在 Electron 启动时自动安装 `rw` binary 到 `~/.browser-viewer/bin`。首期可以只支持源码/包管理器调用，打包安装单独设计。

## 最小可用命令序列

```bash
rw auth login --base-url http://127.0.0.1:5001 --username admin

PROJECT_ID=$(
  rw project ensure --name browser-viewer --path "$PWD" --json \
    | jq -r '.projectId'
)

TERMINAL_ID=$(
  rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json \
    | jq -r '.terminalSessionId'
)

rw terminal send "$TERMINAL_ID" \
  --text "总结当前仓库状态，完成后通过现有 Codex hook 通知" \
  --enter \
  --confirm short \
  --json
```

这个序列就是 OpenCloud/Hermes 首期可以固化的接管路径：登录、幂等确认项目、建终端、向指定终端可靠投递、短确认、拿到机器可读上下文。任务完成后的通知由现有 Codex hooks 承担。
