# Terminal 状态模型

Runweave 用后端维护的 `TerminalState` 表达终端里的 AI CLI 当前产品状态。它是 App、CLI 和后端 API 判断 Stop、handoff 和状态展示的权威来源；终端输出、tail 文本和前端本地推断只能作为辅助信息，不能替代它。

## 状态

`TerminalState` 只包含 UI 和外部 agent 需要的最小事实：

```ts
export type TerminalAgentKind = "codex" | "trae" | "traex" | "traecli";

export type TerminalStateValue =
  | "shell_idle"
  | "agent_starting"
  | "agent_idle"
  | "agent_running";

export interface TerminalState {
  state: TerminalStateValue;
  agent: TerminalAgentKind | null;
}
```

语义：

- `shell_idle`：当前终端没有处在受支持 AI CLI 中，`agent=null`。
- `agent_starting`：受支持 AI CLI 已在前台，但 Codex 等 TUI 尚未被 ready detector 确认为可输入。
- `agent_idle`：受支持 AI CLI 在前台，但没有正在执行的一轮任务。当前支持 `codex` 与 Trae 系列 CLI（`trae` / `traex` / `traecli`）。
- `agent_running`：受支持 AI CLI 正在处理一轮任务，包括模型生成、工具调用、请求权限或等待工具返回。

`terminalSessionId`、`projectId`、`cwd`、`activeCommand` 仍属于终端 session / metadata 协议，不重复放进 `TerminalState`。

Codex 终端 session 还可以记录 `threadId` 和短 preview。它们用于 App 首页和终端列表展示；在 tmux session 丢失且当前 `activeCommand` 仍是 Codex 时，`threadId` 也可作为 `codex resume <threadId>` 的恢复参数。它们不属于 `TerminalState` 本体，也不能代替 hook / active command 判定。

Terminal session 与 panel metadata 中的 current/last thread 必须同时携带 provider 和 thread ID。Codex、Trae、TraeX、TraeCLI 的 thread ID 不能只作为裸字符串保存或展示；同一 pane 从 Codex 切到 TraeX 时，旧 Codex last thread 与新 TraeX current thread 依靠 provider 字段区分。App Home、Terminal list、panel workspace 和 App Server ThreadRef 查询都只能消费这种 provider-aware identity，不能用 cwd、时间接近度或最近 hook 猜测归属。

## 状态来源

后端 `TerminalStateService` 的主状态来源只有两类：

1. Shell active command，用来判断终端是否在受支持 AI CLI 内。
   - `activeCommand=codex` 推进到 `agent_starting` 且 `agent=codex`，除非同 agent 已有更具体的 stored/persisted 状态。
   - `activeCommand=trae`、`traex` 或 `traecli` 推进到 `agent_starting` 且 `agent` 保留对应 Trae family kind，除非同 agent 已有更具体的 stored/persisted 状态。
   - `activeCommand` 为空或不是受支持 AI CLI 时推进到 `shell_idle`。
2. AI agent hook，用来判断受支持 AI CLI 当前 turn 是否运行中。
   - `SessionStart` -> `agent_idle`
   - `UserPromptSubmit` -> `agent_running`
   - `Stop` -> `agent_idle`

Trae family 的 ready 判定必须来自当前启动轮次的真实输出。Agent Team 在 tmux-backed pane 中启动 TraeX worker 时，会先建立 pane-local startup output boundary，再发送启动命令；ready detector 必须同时看到 active command owner 仍属于 Trae family，并在该 boundary 之后看到新的 ready prompt。旧 ready 画面、其他 pane 输出、启动失败后的残留 prompt 或仅有 owner 切换都不能把状态推进为可派发任务。

另外，app-server event center 上的 `agent.completion` 只允许作为受限兜底：当 backend 消费到同一 terminal session 的 `completionReason="hook_stop"` 且原始 hook event 为 `Stop` / `SubagentStop` 时，可以把它规范化为一次 `Stop` hook，并复用 agent hook processor 的 active command、grace window、session 生命周期和 source gate 规则校正为 `agent_idle`。App Server 自身也可以在 Codex `thread/read` 轮询发现 projected 状态与真实 thread 状态不一致时，写入一条 `payload.compensation=true` 的 `agent.hook` 补偿事件；backend 仍把它当作普通 hook 事件处理。这不是新的 completion 状态机，也不能让 notify、manual completion、AI process exit 或普通 completion feed 写入 `TerminalState`。

终端 session 生命周期是最高优先级 guard。只要 session 已退出，读取当前状态时必须返回 `shell_idle`，即使内存里残留了 agent 状态或 active command。

## API

登录态读取当前状态：

```http
GET /api/terminal/session/:terminalSessionId/state
```

返回：

```json
{
  "terminalState": {
    "state": "agent_running",
    "agent": "codex"
  }
}
```

内部 hook 写入接口：

```http
POST /internal/terminal/agent-hook
X-Runweave-Hook-Token: <RUNWEAVE_HOOK_TOKEN>
Content-Type: application/json
```

请求体：

```json
{
  "terminalSessionId": "<terminal session id>",
  "projectId": "<project id>",
  "agent": "codex",
  "hookEvent": "UserPromptSubmit"
}
```

Runweave 创建 tmux-backed terminal 时把 `RUNWEAVE_HOOK_ENDPOINT` 指向这个 agent hook endpoint，并通过 `RUNWEAVE_TERMINAL_SESSION_ID` 让 launcher 上报到正确 session。hook payload 的 `agent` 字段必须是当前支持的 agent kind。

当 Codex hook payload 带 `threadId` 时，后端会把它保存到 terminal session metadata，并在后台尝试通过 Codex app-server 读取线程 preview。读取失败只记录日志，不影响 `TerminalState` 写入。

Web Terminal 的“状态查询”入口不读取 `TerminalState`，而是通过 backend 代理查询 App Server 的轻量 ThreadRef projection：

```http
GET /api/app-server/threads
GET /api/app-server/threads/:threadId
```

这个入口用于排查某个 `threadId` 或 `terminalSessionId` 当前在 App Server projection 中的状态和归属。它不能替代 `/api/terminal/session/:terminalSessionId/state`，也不能作为 Stop 按钮、handoff 或 App 展示的权威状态源。

## 与完成通知的边界

`TerminalState` 不消费 `/internal/terminal-completion` 或普通 completion feed，也不把完成提醒本身作为状态来源。`/internal/terminal-completion` 只负责“非当前终端里的 AI 任务完成提醒”，例如终端 tab 小绿点。唯一例外是 app-server `agent.completion` 中由 hook bridge 双写出来的 `hook_stop + Stop` 事件：它可以作为丢失直连 agent hook 时的 Stop hook fallback，进入同一个 agent hook processor，而不是绕过状态门禁直接写状态。App Server 的 Codex thread 状态补偿同样生成 `agent.hook` 事件，而不是新增 backend 私有状态写入路径。状态服务在状态变化后会向全局 `TerminalEventService` 记录 `terminal_state_changed` envelope，由 `/ws/terminal-events` 推送给 Web/App；这个推送是状态结果的分发通道，不是状态判定来源。

Stop、ESC、SIGINT 或 HTTP interrupt 也不直接写 `TerminalState`。控制输入发出后，状态只能由后续 `Stop` hook 或 active command 变化自然校正。这样可以避免前端/App 在用户点击 Stop 后提前隐藏 Stop 按钮，造成状态假成功。

## 消费方

- App 通过 App overview 取得列表和详情初始 `TerminalState`，再通过全局 `/ws/terminal-events` 接收 `terminal_state_changed` 事件刷新列表和终端详情状态；`/api/terminal/session/:id/state` 仍作为 CLI、调试和断线诊断入口。仅当 `terminalState.state === "agent_running"` 时展示 Stop。
- Web Terminal 工作区用同一状态驱动正在执行的 terminal tab 文字 shimmer，并在项目 tab 上聚合同项目下任一 `agent_running` session 的运行态；项目 shimmer 不新增后端字段、不看 tail 文本。右上角“状态查询”只显示 App Server ThreadRef projection，用于人工排障和复制给 Agent，不驱动工作区运行态。
- `rw terminal handoff` 读取当前 `TerminalState`，并把它作为 handoff 的权威状态字段；tail/echo 推断只用于短确认和诊断。
- App 首页 overview 返回基于同一状态服务折叠出的展示状态，避免 App 列表和详情页使用不同状态机。Codex session 如果有可读 `threadId`，overview 会读取线程 preview 和 Codex 线程状态，用于列表标题、副标题和展示状态；这只是 App overview 的展示增强，不改变终端状态服务的状态来源。

## Web Floating Composer

Web desktop terminal 的 floating composer 是 `TerminalState` 的消费方之一，但不是新的状态来源。它只在受支持 agent 命中、session 仍 running、搜索栏未打开、且终端处于 TUI/agent 场景时启用；Codex 与 Trae family 可以来自 `terminalState.agent`，Claude 首期只通过 `activeCommand` basename 命中。

当前交互是离底或 tmux scrollback active 时先显示一个紧凑的打开按钮。用户点开后，底部出现浮动 composer；composer 上方的回到底部按钮与 composer 同步显示。回到底部或关闭 composer 后，焦点回到原始 xterm/TUI 输入。普通 shell、mobile client mode、已退出 session、搜索栏打开或 unsupported TUI 都继续使用原有右下角 `Scroll terminal to bottom` 行为。

浮动 composer 维护 Web 侧 draft mirror：普通字符、换行、Backspace、Ctrl+U、bracketed paste 等可识别输入会同步为 draft；焦点报告和鼠标控制序列会忽略；未知 escape sequence 会让本 session 暂停 floating composer，直到用户回到底部或 agent/session metadata 变化后重新评估。composer 发送或回到底部同步草稿时，会保守使用 Ctrl+U + draft 替换真实 TUI 输入行；这个 replay 只允许在 supported agent/TUI gate 内发生。

## 运行限制

当前状态模型支持 Codex 与 Trae 系列 CLI。Claude、Coco 或普通 shell 命令需要后续扩展 `TerminalAgentKind` 或新增 `shell_running`，不要通过 tail 文本猜测提前混入当前模型。

如果 hook 丢失或 backend 重启，状态可能短期停留在旧值或回到 `shell_idle`。下一次 active command 或 agent hook 到达后会覆盖当前状态；系统不根据运行时长做 stale timeout 猜测。
