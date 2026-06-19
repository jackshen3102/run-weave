# Codex Agent Run 状态追踪实现计划

## 背景

当前 Runweave 终端详情页需要更准确地判断“终端里运行的 Codex 是否仍在执行”，以决定：

- 是否展示停止按钮
- 停止按钮应该发送什么控制信号
- `rw terminal handoff`、终端列表、终端详情页应该如何展示 agent 状态
- 后端如何判断一次 AI 命令已经结束，而不是继续依赖终端输出尾部或 `activeCommand=codex` 这类弱信号

这件事不能简单理解成“拿 Codex 生成的一个 ID 去查询状态”。截至当前可用的 Codex CLI 能力，官方公开接口更适合作为事件源或会话恢复入口，而不是稳定的状态查询 API。

已确认的 Codex 能力：

- `codex exec --json` 会输出 JSONL 事件，包括 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*`、`error`
- `codex exec resume <SESSION_ID>` 和 `codex resume [SESSION_ID]` 可以恢复会话
- Codex hooks 支持 `SessionStart`、`UserPromptSubmit`、`Stop` 等事件
- 本地 `~/.codex/sessions`、`~/.codex/session_index.jsonl` 中确实能看到 session/thread 数据，但这些属于本地实现细节，不应作为 Runweave 产品逻辑的主要状态源

结论：Runweave 应该把 Codex ID 作为关联元数据保存，但状态本身要由 Runweave 通过“命令启动、Codex JSONL 事件、Codex hooks、进程退出、终端信号”统一维护。

## 基于当前代码的可落地 MVP

当前 Runweave 的真实终端链路不是“后端启动一个 Codex 子进程并拿 stdout”，而是：

1. 后端创建 tmux session 或 PTY runtime。
2. 用户在终端里手动输入 `codex`。
3. `backend/src/terminal/runtime-launcher.ts` 已经给 tmux session 注入 `RUNWEAVE_TERMINAL_SESSION_ID`、`RUNWEAVE_PROJECT_ID`、`RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN`。
4. Codex 结束事件已经可以通过 `backend/src/routes/terminal-completion.ts` 打到 `/internal/terminal-completion`。
5. 后端已经维护 `activeCommand` 和 `lastAiActiveCommand`。
6. App 侧已经可以通过 WebSocket 发送 `SIGINT`，后端会转成 runtime signal。

所以第一版真正可落地的方案是：

- 不要求用户改成 `codex exec --json`
- 不要求 Runweave 接管所有 Codex 启动方式
- 不读取 `~/.codex/sessions`
- 在现有 hook endpoint 基础上，把“completion event”升级成“agent lifecycle event”
- 用现有 `activeCommand=codex` 判断开始，用 hook/completion 判断结束，用 SIGINT 判断取消

MVP 的状态精度：

- Codex 正在前台运行：来自 `activeCommand=codex`，置信度 medium
- Codex 停止：来自 `/internal/terminal-completion`，置信度 medium
- 用户点击停止：来自 WebSocket `signal=SIGINT`，置信度 medium
- 找不到 hook 时：退回现有 terminal tail/activeCommand heuristic，置信度 weak

这条路径能直接复用当前代码，不需要先设计 Codex wrapper。

## 目标

1. 在后端建立统一的 `TerminalAgentRun` 状态模型，表示一次 AI agent 运行。
2. 支持 Codex 的强状态链路：通过 `codex exec --json` 解析事件，获得高置信度的 running/completed/failed 状态。
3. 支持 Codex 交互式 TUI 的中等置信度链路：通过 Codex hooks 上报 lifecycle 事件。
4. 保留现有 `activeCommand`、终端输出尾部、completion hook 的弱推断能力，但只作为 fallback。
5. 让前端终端详情页和 CLI 使用同一份后端 agent run 状态，而不是各自做输出解析。

## 非目标

- 不在产品逻辑中直接读取或解析 `~/.codex/sessions/*.jsonl`。
- 不把 Codex 本地 session index 当作稳定 API。
- 不实现完整的 Codex 协议反向工程。
- 不让前端新增 Vitest 单测；前端只做类型检查、构建和必要的 E2E/手工回归。
- 不改变用户直接在终端里输入普通 shell 命令的行为。
- 不强制所有 `codex` 命令都走 wrapper；手动输入 `codex` 时仍允许走 hooks/heuristic fallback。

## 当前链路问题

### 已有能力

- `packages/shared/src/terminal-protocol.ts`
  - 已有 `TerminalCompletionEvent`
  - 已有 `TerminalClientMessage` 的 `signal` 类型，支持 `SIGINT`、`SIGTERM`、`SIGKILL`

- `backend/src/routes/terminal-completion.ts`
  - 已能接收 completion event
  - 通过 `terminalSessionId`、`source`、`completionReason`、`commandName` 记录结束事件
  - 支持 hook token 鉴权

- `backend/src/terminal/completion-events.ts`
  - 当前 completion event store 是内存队列
  - 只记录“结束事件”，没有完整 running state

- `backend/src/terminal/manager.ts`
  - 已维护 `activeCommand`
  - 已维护 `lastAiActiveCommands`
  - 可通过 `getLastAiActiveCommand` 支持 completion grace window

- `backend/src/terminal/runtime-launcher.ts`
  - 已向 tmux runtime 注入：
    - `RUNWEAVE_TERMINAL_SESSION_ID`
    - `RUNWEAVE_PROJECT_ID`
    - `RUNWEAVE_TMUX_SESSION_NAME`
    - `RUNWEAVE_HOOK_ENDPOINT`
    - `RUNWEAVE_HOOK_TOKEN`

- `packages/runweave-cli/src/commands/terminal.ts`
  - `rw terminal handoff` 当前会基于终端输出做弱推断
  - 已有 `inferredAgent`、`inferredState`、`stateConfidence` 这类概念

### 核心缺口

1. completion event 只告诉我们“可能结束了”，不能告诉我们“什么时候开始、现在是否仍在运行”。
2. `activeCommand=codex` 只能说明 shell 里当前前台命令像 Codex，不能说明 Codex turn 是否还在执行。
3. Codex session/thread ID 没有被 Runweave 结构化保存。
4. 前端停止按钮现在主要依赖终端 runtime 状态和 active command，精度不够。
5. CLI `handoff` 和 App 终端详情页没有共享同一份 agent 状态。

## 推荐架构

新增一个后端中心化状态层：`TerminalAgentRunService`。

状态来源按置信度分层：

1. 当前 MVP：`activeCommand` + 现有 completion hook + WebSocket signal。
2. 中期增强：Codex hooks 上报 `SessionStart`、`UserPromptSubmit`、`Stop`。
3. 后续强链路：Runweave 主动启动 `codex exec --json`，解析 JSONL 事件。
4. 最后 fallback：terminal tail 规则。

Codex 生成的 thread/session ID 只作为 `TerminalAgentRun` 的字段保存，用于关联和恢复，不作为唯一状态来源。

## 数据结构

在 `packages/shared/src/terminal-protocol.ts` 新增共享类型：

```ts
export type TerminalAgentSource = "codex" | "claude" | "trae" | "unknown";

export type TerminalAgentRunMode =
  | "exec-json"
  | "interactive-hook"
  | "terminal-heuristic";

export type TerminalAgentRunState =
  | "starting"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "unknown";

export type TerminalAgentRunConfidence = "strong" | "medium" | "weak";

export interface TerminalAgentRun {
  agentRunId: string;
  terminalSessionId: string;
  projectId: string;
  source: TerminalAgentSource;
  mode: TerminalAgentRunMode;
  state: TerminalAgentRunState;
  confidence: TerminalAgentRunConfidence;
  operationId?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  pid?: number;
  command?: string;
  cwd?: string;
  exitCode?: number;
  error?: string;
  lastEventType?: string;
  startedAt: string;
  lastEventAt: string;
  completedAt?: string;
}
```

新增内部事件类型：

```ts
export interface TerminalAgentRunEvent {
  terminalSessionId: string;
  projectId?: string;
  source: TerminalAgentSource;
  mode: TerminalAgentRunMode;
  eventType:
    | "process.started"
    | "codex.thread.started"
    | "codex.turn.started"
    | "codex.turn.completed"
    | "codex.turn.failed"
    | "codex.error"
    | "hook.session_start"
    | "hook.user_prompt_submit"
    | "hook.stop"
    | "process.exited"
    | "signal.sent"
    | "heuristic.active";
  operationId?: string;
  agentRunId?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  pid?: number;
  command?: string;
  cwd?: string;
  exitCode?: number;
  error?: string;
  rawEvent?: unknown;
  occurredAt?: string;
}
```

## API 设计

### 查询当前 agent run

`GET /api/terminal/session/:terminalSessionId/agent-run/current`

返回：

```ts
{
  "agentRun": TerminalAgentRun | null
}
```

语义：

- 优先返回当前 `starting`、`running`、`waiting_input` 状态的 run
- 如果没有活跃 run，可返回最近一次未过期的 `completed` / `failed` run，前端可用于展示最后状态
- 如果没有可信状态，返回 `null`

### 查询历史 agent runs

`GET /api/terminal/session/:terminalSessionId/agent-runs`

返回：

```ts
{
  "agentRuns": TerminalAgentRun[]
}
```

默认返回最近 50 条。

### 查询单个 run

`GET /api/terminal/agent-run/:agentRunId`

返回：

```ts
{
  "agentRun": TerminalAgentRun
}
```

### 内部事件上报

`POST /api/terminal/agent-run-events`

鉴权：

- 使用现有 `RUNWEAVE_HOOK_TOKEN`
- 请求头沿用 completion hook 的鉴权方式

请求体：

```ts
TerminalAgentRunEvent;
```

用途：

- Codex hook script 上报 lifecycle
- wrapper 上报 process start/exit
- 后端运行器上报 signal/cancel

## 实施步骤

### 1. 新增共享协议类型

修改：

- `packages/shared/src/terminal-protocol.ts`

工作：

- 新增 `TerminalAgentRun`、`TerminalAgentRunEvent` 等类型
- 确保类型能被 backend、app、CLI 共用
- 不修改现有 `TerminalCompletionEvent` 的字段语义

验证：

- `pnpm typecheck`

### 2. 新增后端 agent run store

新增：

- `backend/src/terminal/agent-run-store.ts`
- `backend/src/terminal/agent-run-service.ts`

职责：

- 根据 `TerminalAgentRunEvent` 创建或更新 `TerminalAgentRun`
- 按 `terminalSessionId` 查询当前 run
- 按 `agentRunId` 查询单个 run
- 支持 stale 判定
- 保留最近 N 条记录，初期可使用内存 store，结构上为后续持久化留接口

状态转换规则：

- `process.started` -> `starting`
- `codex.thread.started` -> `running`，保存 `codexThreadId`
- `codex.turn.started` -> `running`，保存 `codexTurnId`
- `codex.turn.completed` -> `completed`
- `codex.turn.failed` / `codex.error` -> `failed`
- `hook.session_start` -> `starting`
- `hook.user_prompt_submit` -> `running`
- `hook.stop` -> `completed`
- `heuristic.active` with `activeCommand=codex` -> `running`
- `completion.recorded` from current `/internal/terminal-completion` -> `completed`
- `signal.sent` with `SIGINT` / `SIGTERM` / `SIGKILL` -> `cancelled`，如果稍后收到 Codex completion/failed 再做最终归并
- 超过 stale timeout 仍无事件 -> `stale`
- 仅来自 heuristic 的状态 -> `unknown` 或 `running`，`confidence=weak`

验证：

- 为后端 service 添加 focused 测试
- 覆盖创建、更新、完成、失败、取消、stale、同 terminal 多 run 排序

### 3. 新增后端 API route

新增：

- `backend/src/routes/terminal-agent-runs.ts`

修改：

- 后端 route 注册入口

工作：

- 实现 `GET /api/terminal/session/:id/agent-run/current`
- 实现 `GET /api/terminal/session/:id/agent-runs`
- 实现 `GET /api/terminal/agent-run/:agentRunId`
- 实现 `POST /api/terminal/agent-run-events`
- 复用 completion hook 的 token 校验逻辑，避免新增一套鉴权

验证：

- route 测试覆盖鉴权、参数校验、当前状态查询、历史查询

### 4. 接入 `codex exec --json` 强状态链路

新增或修改：

- `backend/src/terminal/codex-json-events.ts`
- `backend/src/terminal/codex-agent-runner.ts`
- 具体入口根据当前终端命令发送/运行方式接入

工作：

- 对 Runweave 主动启动的 Codex 命令，使用：

```bash
codex exec --json ...
```

- 逐行解析 JSONL
- 将事件映射为 `TerminalAgentRunEvent`
- 保存：
  - `thread.started` -> `codexThreadId`
  - `turn.started` -> `codexTurnId`
  - `turn.completed` -> completed
  - `turn.failed` -> failed
  - `error` -> failed
- 保留 Codex 原始输出对终端用户可见，不让状态解析吞掉输出

注意：

- 这一阶段不是当前终端 MVP 的前置条件
- 这条链路只覆盖 Runweave 可控启动的 Codex 命令
- 用户手动在 shell 中输入 `codex` 时，无法强制拿到 JSONL，只能依赖 hook 或 heuristic

验证：

- 用 mock JSONL 测试 parser
- 用本地 `codex exec --json "..."` 做手工验证
- 验证 run 从 `starting` -> `running` -> `completed`

### 5. 接入 Codex hooks 中等置信度链路

可能修改：

- `electron/resources/hooks/`
- `electron/src/hooks/`
- `backend/src/terminal/runtime-launcher.ts`

工作：

- 添加 Runweave Toolkit lifecycle hook script
- hook 从环境变量读取：
  - `RUNWEAVE_TERMINAL_SESSION_ID`
  - `RUNWEAVE_PROJECT_ID`
  - `RUNWEAVE_HOOK_ENDPOINT`
  - `RUNWEAVE_HOOK_TOKEN`
- hook 接收 Codex 的 hook payload
- 对 `SessionStart`、`UserPromptSubmit`、`Stop` 上报 `TerminalAgentRunEvent`
- 如果 payload 中能拿到 session/thread 相关字段，则保存到 `codexThreadId` 或 `rawEvent`

约束：

- hook 的 `Stop` 是 Codex turn 级别，不等于整个终端进程一定退出
- hooks 只提供中等置信度，不能覆盖 `exec --json` 的强状态

验证：

- 本地安装 hook 后运行交互式 `codex`
- 提交 prompt 后后端状态变成 `running`
- Codex 停止输出后状态变成 `completed`

### 6. 改造 completion event 为补充信号

修改：

- `backend/src/routes/terminal-completion.ts`
- `backend/src/terminal/completion-events.ts`

工作：

- 保留现有 completion event 行为
- 当收到 `source=codex` 且匹配当前 active/grace command 时，同时写入一条 `TerminalAgentRunEvent`
- 如果已有同 terminal 的 active Codex run，则更新为 `completed`
- 如果没有 active run，则创建一个 `mode=terminal-heuristic`、`confidence=weak` 的 completed run

验证：

- 现有 completion tests 不回归
- 新增测试覆盖 completion event 对 agent run 的补充更新

### 7. 前端终端详情页消费 agent run 状态

修改：

- `app/src/pages/AppTerminalPage.tsx`
- `app/src/services/terminal.ts`
- `app/src/components/TerminalCommandComposer.tsx`

工作：

- 新增 `getCurrentTerminalAgentRun`
- 终端详情页定期或随 websocket metadata 更新拉取 current agent run
- 停止按钮判断从：

```ts
connected && runtimeStatus === "running" && Boolean(metadata?.activeCommand);
```

改为优先：

```ts
currentAgentRun?.source === "codex" &&
  ["starting", "running", "waiting_input"].includes(currentAgentRun.state);
```

- 如果没有 current agent run，再 fallback 到现有 active command 判断
- 停止按钮仍发送 `SIGINT`
- UI 可以根据 `confidence` 决定是否展示更保守的状态文案

验证：

- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter @runweave/app build`
- 本地手工打开终端详情页，验证 Codex 运行时显示停止按钮，完成后恢复发送按钮

### 8. CLI `rw terminal handoff` 使用同一状态源

修改：

- `packages/runweave-cli/src/commands/terminal.ts`

工作：

- `handoff` 先查询 `/agent-run/current`
- 如果有强/中置信度 agent run，直接使用该状态
- 只有 API 无状态时，才继续用现有 terminal tail 推断
- 输出中明确区分：
  - `confidence=strong` 来自 `codex exec --json`
  - `confidence=medium` 来自 Codex hooks
  - `confidence=weak` 来自 terminal heuristic

验证：

- CLI 测试覆盖有 agent run、无 agent run fallback 两种情况
- 手工运行 `rw terminal handoff <id>` 查看输出

### 9. 停止能力和状态归并

修改：

- `backend/src/terminal/manager.ts`
- `app/src/hooks/use-app-terminal-connection.ts`
- 必要时修改 WebSocket 消息处理处

工作：

- 前端发送 `SIGINT` 时，后端记录 `signal.sent`
- 当前 active agent run 先进入 `cancelled`
- 如果之后收到 `turn.completed`，最终可保持 `cancelled` 或更新为 `completed`，推荐保持 `cancelled` 并记录 `lastEventType=codex.turn.completed`
- 如果之后收到 `turn.failed`，更新为 `failed`

验证：

- 运行 Codex 长任务
- 点击停止按钮
- 确认终端收到中断
- 确认 current agent run 不再显示为 running

## 分阶段交付

### 第一阶段：当前终端 MVP

交付：

- shared 类型
- agent run store/service
- API route
- 现有 `/internal/terminal-completion` 写入 agent run completed 状态
- `activeCommand=codex` 写入 agent run running 状态
- WebSocket `SIGINT` 写入 agent run cancelled 状态

验收：

- 后端测试通过
- 可以用 HTTP 手工上报事件并查询 current run
- App 不依赖 `codex exec --json`，在用户手动运行 `codex` 时也能得到状态

### 第二阶段：App 和 CLI 消费

交付：

- 终端详情页停止按钮使用 agent run 状态
- `rw terminal handoff` 使用 agent run 状态

验收：

- Codex 运行中显示停止
- Codex 完成后恢复发送
- CLI 输出不再只依赖 tail heuristic

### 第三阶段：Codex hooks 增强

交付：

- Runweave Toolkit lifecycle hook
- hook installer/runtime env 对齐

验收：

- 用户手动运行交互式 `codex` 时，至少能通过 hooks 获得 medium confidence 状态

### 第四阶段：Codex 强状态链路

交付：

- `codex exec --json` parser
- Runweave 可控启动 Codex 时写入 strong confidence 状态

验收：

- 能保存 `codexThreadId`
- 能准确从 running 转 completed/failed

## 验证命令

后端和共享协议：

```bash
pnpm typecheck
pnpm test
```

App 前端：

```bash
pnpm --filter @runweave/app typecheck
pnpm --filter @runweave/app build
```

CLI：

```bash
pnpm --filter @runweave/cli test
pnpm --filter @runweave/cli typecheck
```

本地手工验证：

```bash
pnpm app:dev
```

然后在终端详情页验证：

1. 运行 Codex 命令
2. 后端 current agent run 进入 `running`
3. App composer 显示停止按钮
4. Codex 完成后 current agent run 进入 `completed`
5. App composer 恢复发送按钮
6. 长任务点击停止后，状态进入 `cancelled` 或 `failed`

## 风险和处理

### Codex 没有稳定状态查询 API

处理：

- 不设计 `codex status <id>` 依赖
- 使用 `codex exec --json` 和 hooks 作为事件源
- Codex ID 只保存为关联字段

### 用户手动输入 `codex` 无法强制 JSONL

处理：

- hooks 提供 medium confidence
- activeCommand 和 completion event 提供 weak fallback
- UI 用 `confidence` 做保守判断

### hook Stop 不是进程退出

处理：

- `hook.stop` 只标记当前 Codex turn 完成
- 不直接假设 shell 命令已经退出
- 进程退出和 terminal activeCommand 仍作为补充信号

### 内存 store 重启丢状态

处理：

- 第一阶段接受内存 store，保持实现简单
- 如果后续需要跨进程/重启恢复，再把 `AgentRunStore` 接口接入现有持久化层

## 最终判断

这个方案的关键不是“通过 Codex ID 查状态”，而是“Runweave 从 Codex 运行开始就接管状态流”。
Codex ID 很有价值，但它应该服务于关联、恢复和排查；真正决定按钮、handoff、终端状态的，应是 Runweave 自己维护的 `TerminalAgentRun`。
