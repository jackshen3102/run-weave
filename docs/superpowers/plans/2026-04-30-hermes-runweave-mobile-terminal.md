# Hermes × Runweave：手机操控终端与任务排放方案

> 面向目标：用户在手机飞书里和 Hermes 对话，即可创建/选择 Runweave 终端、发送指令、排放后台任务、订阅结果，并在需要时打开 Runweave Web/Electron 终端界面继续人工接管。

## 1. 结论先行

推荐采用 **“Hermes 做自然语言编排层 + Runweave 做长驻终端/浏览器执行平面”** 的两层架构：

- **Hermes**：接收飞书/手机消息，理解自然语言，做任务规划、定时任务、结果摘要、通知投递、安全确认。
- **Runweave(browser-viewer)**：提供 24/7 的 tmux/PTY 终端、项目/会话管理、终端滚屏历史、WebSocket 输入输出、浏览器 Viewer、AI bridge/CDP 浏览器自动化通道。
- **最小可跑版本**：先不大改 Runweave，只在 Hermes 新增一个 `runweave` toolset，通过现有 HTTP + WS API 操作终端。
- **产品化版本**：给 Runweave 增加 AI/Agent 专用的 HTTP Action API、事件 Webhook、一次性 task API、细粒度令牌和审计；Hermes 侧新增工具与飞书快捷命令。

## 2. 当前项目能力梳理

### 2.1 项目形态

Runweave 当前是一个 pnpm workspace，核心模块：

- `frontend/`：React + Vite 前端，含终端工作区、Viewer、连接管理、移动端适配。
- `backend/`：Express + WebSocket + Playwright 控制平面。
- `electron/`：桌面客户端，支持多后端连接管理和内置后端。
- `packages/shared/`：前后端共享协议类型。
- `docs/superpowers/plans/`：已有设计/实现计划沉淀。

常用命令：

```bash
pnpm dev
pnpm dev:electron
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm dist:electron:mac
```

### 2.2 已有终端能力

后端已挂载：`/api/terminal/*` 与 `/ws/terminal`。

现有 HTTP API 能力：

- `GET /api/terminal/project`：列出终端项目。
- `POST /api/terminal/project`：创建项目，body: `{ name, path }`。
- `PATCH /api/terminal/project/:id`：更新项目名/路径。
- `DELETE /api/terminal/project/:id`：删除项目及其终端。
- `GET /api/terminal/session`：列出终端会话。
- `POST /api/terminal/session`：创建终端会话，body 支持：
  - `projectId`
  - `command`
  - `args`
  - `cwd`
  - `inheritFromTerminalSessionId`
  - `runtimePreference: "auto" | "tmux" | "pty"`
- `GET /api/terminal/session/:id`：查看状态与当前 scrollback。
- `GET /api/terminal/session/:id/history`：读取更多历史 scrollback。
- `POST /api/terminal/session/:id/input`：通过 HTTP 给终端发送输入，支持 `submit` 自动回车和 bracketed paste。
- `POST /api/terminal/task`：创建一次性终端任务，返回 taskId / terminalSessionId / statusUrl。
- `GET /api/terminal/task/:taskId`：查询任务运行状态、exitCode 和 tail 输出。
- `POST /api/terminal/session/:id/ws-ticket`：换取 60 秒终端 WebSocket ticket。
- `DELETE /api/terminal/session/:id`：删除终端会话。
- `GET /api/terminal/completion-events?after=...`：拉取 CLI agent 完成事件。

WebSocket 协议：`/ws/terminal?terminalSessionId=...&token=...`

客户端可发送：

```ts
{ type: "input", data: string }
{ type: "resize", cols: number, rows: number }
{ type: "signal", signal: "SIGINT" | "SIGTERM" | "SIGKILL" }
{ type: "request-status" }
```

服务端可返回：

```ts
{ type: "connected", terminalSessionId, runtimeKind }
{ type: "snapshot", data }
{ type: "metadata", cwd, activeCommand }
{ type: "output", data }
{ type: "status", status, exitCode? }
{ type: "exit", exitCode }
{ type: "error", message }
```

### 2.3 tmux 持久化能力

终端运行优先使用 tmux：

- terminal session 会映射到 `runweave-<terminalSessionId>` tmux session。
- socket 默认在浏览器 profile 下的 `tmux/runweave.tmux.sock`。
- session metadata 包含：`runtimeKind`, `tmuxSessionName`, `tmuxSocketPath`, `recoverable`。
- 即使 Web 前端断开，tmux 仍能继续跑，适合手机端排放长任务。

这正好补足 Hermes 普通 terminal tool 的短会话问题：Hermes 可以把长任务交给 Runweave tmux，自己只负责投递、轮询、总结和通知。

### 2.4 已有完成事件能力

后端已有内部 hook：

- `POST /internal/terminal-completion`
- Header: `x-runweave-hook-token`
- body: `{ terminalSessionId, source, hookEvent, cwd }`

并有公开拉取入口：

- `GET /api/terminal/completion-events?after=...`

这能用于 Claude/Codex/Trae 等 CLI Agent 完成后，让 Hermes 从飞书通知用户“任务完成”，并附上 scrollback 摘要与下一步按钮/命令。

### 2.5 浏览器/AI bridge 能力

已有 Browser Viewer 与 AI bridge：

- `GET /api/session/ai-default`
- `POST /api/session/ai-default/ensure`
- `POST /api/session/:id/ai-bridge`
- `/ws/ai-bridge?sessionId=...`

这意味着 Hermes 未来不仅能操作终端，还能通过 Runweave 复用一个持久浏览器：登录态、页面调试、DevTools/CDP、自动化操作都可以沉到 Runweave。

## 3. 目标体验

### 3.1 手机飞书自然语言操作

示例：

- “在 browser-viewer 项目里开个终端，跑 pnpm test，结束告诉我。”
- “把上一个 Codex 终端继续，让它根据报错修复。”
- “每天下午 6 点检查这个项目 git diff 和测试结果，发我摘要。”
- “打开一个浏览器 Viewer，登录后台，然后让 AI 接着操作页面。”
- “列出现在所有 Runweave 终端，哪个还在跑？”
- “把 runweave-xxx 的最后 200 行总结一下。”

### 3.2 人机协同

- Hermes 能发命令、读结果、做摘要。
- 用户可以点 Runweave 链接打开移动端 Web Terminal 接管。
- 对危险命令，Hermes 先发确认，确认后才投递。
- 长任务完成后自动回飞书，不要求用户保持手机页面打开。

## 4. 推荐架构

```text
[手机飞书]
   ↓ message / slash command
[Hermes Gateway]
   ↓ natural language planning + safety + cron
[Hermes runweave toolset]
   ↓ HTTP REST + WebSocket
[Runweave backend]
   ↓ tmux / PTY / Playwright / CDP
[本机终端、项目代码、浏览器 Viewer]
```

## 5. 分阶段实施方案

## Phase 0：无需改 Runweave 的最小可用集成（1 天）

### 目标

在 Hermes 里新增 `runweave` toolset，直接调用现有 Runweave API，实现：

1. 登录 Runweave。
2. 列项目/建项目。
3. 列终端/建终端。
4. 发送终端输入。
5. 读取终端状态和历史。
6. 轮询 completion events。
7. 支持 Hermes cronjob 定时执行和回飞书。

### Hermes 新增工具建议

新增文件：`tools/runweave_tool.py`

工具列表：

1. `runweave_login`
   - 输入：`base_url`, `username`, `password`
   - 输出：`access_token`, `expires_in`
   - 可从 `~/.hermes/config.yaml` 或 env 读默认配置。

2. `runweave_list_projects`
   - `GET /api/terminal/project`

3. `runweave_create_project`
   - `POST /api/terminal/project`
   - 输入：`name`, `path`

4. `runweave_list_terminals`
   - `GET /api/terminal/session`

5. `runweave_create_terminal`
   - `POST /api/terminal/session`
   - 输入：`cwd`, `project_id`, `command`, `args`, `runtime_preference`
   - 默认 `runtimePreference=tmux`

6. `runweave_terminal_send_input`
   - 先 `POST /api/terminal/session/:id/ws-ticket`
   - 再连接 `/ws/terminal?...`
   - 发送 `{ type: "input", data }`
   - 常用 helper：`submit=true` 时自动追加 `\r`

7. `runweave_terminal_read`
   - `GET /api/terminal/session/:id` 或 `/history`
   - 支持 `tail_lines`，由工具端裁剪，避免把海量 scrollback 塞进模型。

8. `runweave_terminal_signal`
   - WebSocket 发送 `{ type: "signal", signal }`

9. `runweave_list_completion_events`
   - `GET /api/terminal/completion-events?after=...`

### Hermes 配置建议

在 `~/.hermes/config.yaml`：

```yaml
runweave:
  default_base_url: "http://127.0.0.1:5000"
  username: "admin"
  # password 建议放 ~/.hermes/.env：RUNWEAVE_PASSWORD=...
  prefer_runtime: "tmux"
  default_project_paths:
    browser-viewer: "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer"
```

在 `~/.hermes/.env`：

```bash
RUNWEAVE_BASE_URL=http://127.0.0.1:5000
RUNWEAVE_USERNAME=admin
RUNWEAVE_PASSWORD=***
```

### 最小 Demo 流程

用户飞书说：

> 在 browser-viewer 跑 pnpm typecheck，结束告诉我

Hermes 执行：

1. `runweave_login`
2. `runweave_create_project(name="browser-viewer", path="/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer")`，已存在则复用。
3. `runweave_create_terminal(cwd=项目路径, command="zsh", runtimePreference="tmux")`
4. `runweave_terminal_send_input(data="pnpm typecheck", submit=true)`
5. 创建 Hermes cronjob：每 1 分钟读 `completion-events` 和 `history`。
6. 任务完成后总结输出，飞书回发。

### 优点

- 不用动 Runweave 后端。
- 能立刻验证“手机 → Hermes → Runweave 终端 → 飞书结果”的主链路。
- Hermes 侧工具实现后，也可以复用给 Telegram/Discord/Slack。

### 缺点

- 通过 WebSocket 发输入，工具实现稍复杂。
- 没有服务端 push，需要 Hermes 轮询。
- 缺少专门的一次性 task API，复杂任务需要 Hermes 组合多个调用。

## Phase 1：给 Runweave 增加 AI Action API（2～3 天）

### 当前状态

已实现第一版最小闭环（MVP）：

- ✅ `POST /api/terminal/session/:id/input`：通过 HTTP 给已有终端发送输入，支持 `submit` 自动回车与 bracketed paste。
- ✅ `POST /api/terminal/task`：创建新 terminal session，启动 tmux/PTY runtime，投递一次性命令。
- ✅ `GET /api/terminal/task/:taskId`：读取任务状态、exit code、尾部输出。
- ✅ 共享协议类型已补齐到 `packages/shared/src/terminal-protocol.ts`。
- ✅ 后端路由测试覆盖了 HTTP input 与 task 完成检测。
- ✅ 已通过 `backend`、`shared` 与全 workspace typecheck。

本版先采用 **进程内 task metadata + scrollback sentinel** 的轻量实现，适合快速把 Hermes/飞书手机操控链路跑通。后续产品化再升级为持久化 task store、Webhook 推送、权限 scope 与审计日志。

### 目标

把“Agent 常用终端操作”做成 HTTP API，降低 Hermes 接入复杂度，也方便未来其他 AI/自动化系统使用。

### Runweave 新增 API

#### 1. 发送输入

`POST /api/terminal/session/:id/input`

Body：

```json
{
  "data": "pnpm test",
  "submit": true,
  "pasteMode": "bracketed"
}
```

行为：

- 服务端复用 `ensureTerminalRuntime` 找到 tmux/pty runtime。
- `submit=true` 时追加回车。
- 对 tmux 使用现有 input pacing，避免 Codex/Coco 类 TUI 漏回车。

#### 2. 一次性执行任务

`POST /api/terminal/task`

Body：

```json
{
  "projectId": "...",
  "cwd": "/path/to/repo",
  "command": "pnpm test",
  "runtimePreference": "tmux",
  "notifyOnCompletion": true
}
```

Response：

```json
{
  "taskId": "...",
  "terminalSessionId": "...",
  "terminalUrl": "/terminal/...",
  "statusUrl": "/api/terminal/task/..."
}
```

实现可以先薄封装：创建 terminal session + 发送 command + 记录 task metadata。

#### 3. 获取任务状态

`GET /api/terminal/task/:taskId`

Response：

```json
{
  "taskId": "...",
  "terminalSessionId": "...",
  "status": "running|completed|failed|cancelled",
  "exitCode": 0,
  "tail": "...",
  "startedAt": "...",
  "completedAt": "..."
}
```

#### 4. 订阅/推送事件

保留轮询，同时增加 Webhook：

`POST /api/integrations/webhooks`

Body：

```json
{
  "url": "https://hermes-gateway/.../webhook/runweave",
  "secret": "...",
  "events": ["terminal.completed", "terminal.exited", "terminal.bell"]
}
```

事件 payload：

```json
{
  "event": "terminal.completed",
  "terminalSessionId": "...",
  "projectId": "...",
  "source": "codex",
  "cwd": "/path",
  "createdAt": "..."
}
```

#### 5. 分享/深链

`GET /api/terminal/session/:id/deeplink`

返回可给手机打开的 URL：

```json
{
  "webUrl": "https://runweave.example.com/terminal/<id>",
  "electronUrl": "browser-viewer://terminal/<id>"
}
```

实现已落到：

- `packages/shared/src/terminal-protocol.ts`
  - 增加 `TerminalInputRequest`, `TerminalInputResponse`, `CreateTerminalTaskRequest`, `CreateTerminalTaskResponse`, `TerminalTaskStatusResponse` 类型。
- `backend/src/routes/terminal.ts`
  - 增加 `/session/:id/input`、`/task`、`/task/:taskId`。
  - 当前 task metadata 存在路由闭包内的 `Map`，服务重启后会丢失；这是 Phase 1 MVP 的已知限制。
  - task 完成通过 scrollback 中的 sentinel 检测：`__RUNWEAVE_TASK_DONE__:<taskId>:<exitCode>`。
- `backend/src/routes/terminal.test.ts`
  - 已补后端单测：HTTP input API、task 创建、sentinel 完成检测。

暂未纳入本阶段的增强项：

- `backend/src/terminal/manager.ts`
  - 目前未新增持久化 TaskManager/TaskStore；后续产品化时再做。
- `backend/src/ws/terminal-server.ts`
  - 当前 HTTP input 直接复用 runtime `write()`；后续可继续抽取 WS/HTTP 共用 input pacing helper。
- Webhook / deeplink / API token scope
  - 保持在后续 Phase 2/3。

### Phase 1 使用示例

#### 给已有终端发命令

```bash
curl -X POST "$RUNWEAVE_BASE_URL/api/terminal/session/$TERMINAL_ID/input" \
  -H "Authorization: Bearer TOKEN_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{"data":"pnpm typecheck","submit":true}'
```

返回：

```json
{
  "terminalSessionId": "...",
  "sent": true,
  "submitted": true,
  "bytes": 15
}
```

#### 创建一次性任务

```bash
curl -X POST "$RUNWEAVE_BASE_URL/api/terminal/task" \
  -H "Authorization: Bearer TOKEN_PLACEHOLDER" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "...",
    "cwd": "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer",
    "command": "pnpm typecheck",
    "runtimePreference": "tmux"
  }'
```

返回：

```json
{
  "taskId": "...",
  "terminalSessionId": "...",
  "terminalUrl": "/terminal/...",
  "statusUrl": "/api/terminal/task/..."
}
```

#### 查询任务状态

```bash
curl "$RUNWEAVE_BASE_URL/api/terminal/task/$TASK_ID" \
  -H "Authorization: Bearer TOKEN_PLACEHOLDER"
```

返回：

```json
{
  "taskId": "...",
  "terminalSessionId": "...",
  "status": "completed",
  "exitCode": 0,
  "tail": "...最后若干行输出...",
  "startedAt": "...",
  "completedAt": "..."
}
```

### Phase 1 验证命令

```bash
cd /Users/bytedance/Desktop/vscode/browser-hub/browser-viewer/backend
pnpm exec vitest run src/routes/terminal.test.ts

cd /Users/bytedance/Desktop/vscode/browser-hub/browser-viewer
pnpm --filter ./backend typecheck
pnpm --filter @browser-viewer/shared typecheck
pnpm typecheck
```

本次验证结果：

- `src/routes/terminal.test.ts`：37 passed。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter @browser-viewer/shared typecheck`：通过。
- `pnpm typecheck`：workspace 4 个项目全部通过。

## Phase 2：Hermes 产品化工具与飞书命令（2～4 天）

### Hermes 新增 toolset

文件：

- `tools/runweave_tool.py`
- `toolsets.py`
- `model_tools.py`
- 测试：`tests/tools/test_runweave_tool.py`, `tests/test_model_tools.py`

工具命名建议：

```text
runweave_health
runweave_auth_login
runweave_project_list
runweave_project_ensure
runweave_terminal_list
runweave_terminal_create
runweave_terminal_send
runweave_terminal_read
runweave_terminal_signal
runweave_task_run
runweave_task_status
runweave_completion_events
runweave_ai_browser_ensure
runweave_ai_bridge_create
```

### 飞书交互建议

先通过自然语言即可；后续可加 slash/快捷命令：

```text
/rw sessions
/rw open browser-viewer
/rw run browser-viewer -- pnpm test
/rw tail <terminalSessionId> 200
/rw kill <terminalSessionId>
/rw schedule "每天18点跑 pnpm test 并总结"
```

### Hermes cronjob 用法

当用户说“结束告诉我 / 每天跑 / 过半小时看结果”：

- Hermes 创建 cronjob。
- cron prompt 自包含：Runweave base_url、terminalSessionId/taskId、检查逻辑、回传目标。
- cron job 使用 `deliver: origin` 回当前飞书会话。

### 结果摘要模板

```text
Runweave 任务完成：pnpm test
项目：browser-viewer
终端：<terminalSessionId>
状态：成功/失败/仍在运行
耗时：xx
关键输出：
- ...
- ...
下一步建议：
1. ...
2. ...
打开终端：<url>
```

## Phase 3：安全与权限（并行，必须做）

### 风险点

手机飞书一句话最终能执行本机终端命令，权限很大。必须加保护：

- Runweave 后端登录态泄露风险。
- Hermes tool 被 prompt injection 诱导执行危险命令。
- 多用户飞书群里误触发。
- 终端输出可能包含 token/secret。
- 长任务可能消耗资源或删除数据。

### 建议机制

1. **Runweave API token 独立于网页登录密码**
   - 新增 `RUNWEAVE_AGENT_TOKEN` 或 API Key 管理。
   - 支持 scope：`terminal:read`, `terminal:write`, `task:create`, `browser:ai`。

2. **危险命令确认**
   - Hermes 侧对 `rm -rf`, `sudo`, `curl | sh`, `git push --force`, `kill -9`, `chmod -R`, `dd`, `mkfs` 等先确认。
   - Runweave 侧也可做二次 allow/deny。

3. **项目 allowlist**
   - 只允许 Hermes 操作配置中的项目路径。
   - 默认：`/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer`。

4. **审计日志**
   - 每次由 Hermes 投递的命令记录：user_id, chat_id, command, cwd, terminalSessionId, timestamp。

5. **输出脱敏**
   - Hermes 汇总前对常见 token/password/key 做正则脱敏。

6. **群聊限制**
   - 默认只允许 DM 操作终端。
   - 群聊里只允许读状态，写操作必须 @用户确认或白名单。

## Phase 4：更强的 AI Browser/COI 能力（3～7 天）

这里的 “COI/CLI” 可落到两类能力：

### 4.1 Browser Control Interface

Hermes 通过 Runweave AI bridge 复用持久浏览器，增加工具：

- `runweave_browser_ensure_default`
- `runweave_browser_open_url`
- `runweave_browser_screenshot`
- `runweave_browser_click/type/evaluate`
- `runweave_browser_devtools_log`

底层可以走：

- 现有 `/api/session/ai-default/ensure`
- `/api/session/:id/ai-bridge`
- `/ws/ai-bridge`
- 或 Playwright MCP/CDP。

用途：

- 手机让 Hermes 打开页面、登录、点按钮。
- 终端任务失败时自动打开本地 dev server 页面做 QA。
- 把浏览器截图回飞书。

### 4.2 Command/Computer Operation Interface

抽象出更高层动作：

```text
open_project_terminal(project)
run_command(project, command)
spawn_agent(project, agent="codex", prompt)
continue_agent(terminalSessionId, prompt)
summarize_terminal(terminalSessionId)
open_browser_for_terminal(terminalSessionId, url)
schedule_task(project, cron, command/prompt)
```

这层由 Hermes 编排，Runweave 提供稳定执行平面。

## 6. 可执行开发计划

### Task 1：Hermes 侧最小 Runweave client

**目标**：能登录、列项目、列终端、创建终端、读状态。

**文件**：

- Create: `tools/runweave_tool.py`
- Modify: `model_tools.py`
- Modify: `toolsets.py`
- Test: `tests/tools/test_runweave_tool.py`

**实现要点**：

- 使用 Python 标准库/requests（项目若已有依赖优先复用）。
- token 缓存只放内存，不写日志。
- 所有 handler 返回 JSON 字符串。
- schema 里不要硬编码其他 tool 名称。

**验收**：

```bash
source venv/bin/activate
python -m pytest tests/tools/test_runweave_tool.py -q
python -m pytest tests/test_model_tools.py -q
```

### Task 2：Hermes WebSocket 输入工具

**目标**：`runweave_terminal_send` 能向已有终端发送文本/回车。

**实现要点**：

- 先调用 `/api/terminal/session/:id/ws-ticket`。
- 连接 `/ws/terminal`。
- 等 `connected` 或首个 `snapshot` 后发送 input。
- `submit=true` 时追加 `\r`。
- 发送后读取短时间 output，返回 `sent=true` 和 tail。

**验收**：

- 创建 zsh 终端后发送 `pwd`，返回输出包含 cwd。
- 发送中文文本不乱码。
- Codex/Coco 类 TUI 能真正提交，不只是停在输入框。

### Task 3：Runweave HTTP input API

**目标**：降低 Hermes 侧复杂度，新增 `POST /api/terminal/session/:id/input`。

**文件**：

- Modify: `packages/shared/src/terminal-protocol.ts`
- Modify: `backend/src/routes/terminal.ts`
- Modify: `backend/src/ws/terminal-server.ts` 或抽出 shared terminal input helper
- Test: `backend/src/routes/terminal.test.ts`

**验收**：

```bash
pnpm --filter ./backend test -- terminal
pnpm typecheck
```

### Task 4：Runweave task API

**目标**：一条 API 创建可追踪任务。

**文件**：

- Create: `backend/src/terminal/task-manager.ts`
- Create: `backend/src/terminal/task-store.ts`（如需持久化）
- Modify: `backend/src/routes/terminal.ts`
- Modify: `packages/shared/src/terminal-protocol.ts`

**验收**：

- `POST /api/terminal/task` 返回 taskId/terminalSessionId。
- `GET /api/terminal/task/:id` 能看到 running/completed/failed。
- 终端退出后 task 状态更新。

### Task 5：Hermes cron/通知联动

**目标**：手机发“结束告诉我”时，自动创建巡检 cron。

**实现要点**：

- cron prompt 必须自包含：base_url, task_id/terminal_id, expected command, summary format。
- 若无新内容可用 `NO_DELIVERY` 类 sentinel 避免刷屏。
- 完成时发飞书：状态 + 摘要 + Runweave URL。

**验收**：

- 运行 1 个 30 秒任务，完成后飞书收到结果。
- 失败任务能摘要失败原因。

### Task 6：安全加固

**目标**：把“手机执行终端”做成可控能力。

**实现要点**：

- Hermes 配置项目路径 allowlist。
- 危险命令二次确认。
- Runweave agent token + scope。
- 审计日志。
- 输出脱敏。

**验收**：

- 非 allowlist 路径拒绝。
- `rm -rf` 类命令不经确认无法执行。
- 日志不泄露 access token/password。

## 7. 首个 MVP 的具体使用方式

### 启动 Runweave

```bash
cd /Users/bytedance/Desktop/vscode/browser-hub/browser-viewer
pnpm dev:electron
# 或 pnpm dev / pnpm start，确保手机或 Hermes 所在进程能访问 backend base_url
```

### 手机飞书指令

```text
在 browser-viewer 项目开一个 Runweave 终端，跑 pnpm typecheck，结束告诉我
```

Hermes 应做：

1. 确认项目路径在 allowlist。
2. 创建/复用项目。
3. 创建 tmux 终端。
4. 投递 `pnpm typecheck`。
5. 创建监控 cron。
6. 完成后飞书推送摘要和终端链接。

## 8. 推荐优先级

1. **先做 Hermes runweave toolset（不改 Runweave）**：最快闭环。
2. **再补 Runweave HTTP input/task API**：让工具稳定、低复杂度。
3. **再做事件 webhook**：少轮询、结果更实时。
4. **最后做 browser AI bridge 工具化**：把浏览器操作也纳入手机 AI 编排。

## 9. 关键注意事项

- Runweave 现有终端协议已经足够支撑 MVP；不要一开始就重构终端架构。
- 手机端并不适合显示全部终端输出，Hermes 应默认返回摘要和 tail。
- 长任务必须交给 Runweave tmux，不要让 Hermes terminal tool 直接跑很久。
- 所有“写终端”的操作都要有身份、路径、危险命令保护。
- 飞书里最好优先做 DM，群聊只读或强确认。

## 10. 最终形态

用户手机只需要说自然语言：

> 帮我在 browser-viewer 起一个 Codex，修一下刚才 typecheck 的问题，修完跑测试，把结果发我。

系统实际执行：

1. Hermes 解析意图。
2. Runweave 创建/复用 browser-viewer tmux 终端。
3. Hermes 投递 Codex prompt。
4. Runweave 终端持续运行，手机可随时打开接管。
5. CLI agent 完成后 Runweave 发 completion event。
6. Hermes 读取 scrollback、检查 git diff/test 输出、总结。
7. 飞书回发任务结果和下一步建议。

这就是“手机上的 AI 终端工作站”：Hermes 是入口和智能编排，Runweave 是可视、可恢复、可接管的执行底座。
