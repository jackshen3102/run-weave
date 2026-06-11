# Terminal 状态模型

Runweave 用后端维护的 `TerminalState` 表达终端里的 AI CLI 当前产品状态。它是 App、CLI 和后端 API 判断 Stop、handoff 和状态展示的权威来源；终端输出、tail 文本和前端本地推断只能作为辅助信息，不能替代它。

## 状态

`TerminalState` 只包含 UI 和外部 agent 需要的最小事实：

```ts
export type TerminalStateValue = "shell_idle" | "agent_idle" | "agent_running";

export interface TerminalState {
  state: TerminalStateValue;
  agent: "codex" | null;
}
```

语义：

- `shell_idle`：当前终端没有处在受支持 AI CLI 中，`agent=null`。
- `agent_idle`：受支持 AI CLI 在前台，但没有正在执行的一轮任务。当前第一阶段只支持 `codex`。
- `agent_running`：受支持 AI CLI 正在处理一轮任务，包括模型生成、工具调用、请求权限或等待工具返回。

`terminalSessionId`、`projectId`、`cwd`、`activeCommand` 仍属于终端 session / metadata 协议，不重复放进 `TerminalState`。

## 状态来源

后端 `TerminalStateService` 只接受两类状态来源：

1. Shell active command，用来判断终端是否在 Codex CLI 内。
   - `activeCommand=codex` 推进到 `agent_idle`。
   - `activeCommand` 为空或不是 Codex 时推进到 `shell_idle`。
2. Codex agent hook，用来判断 Codex 当前 turn 是否运行中。
   - `SessionStart` -> `agent_idle`
   - `UserPromptSubmit` -> `agent_running`
   - `Stop` -> `agent_idle`

终端 session 生命周期是最高优先级 guard。只要 session 已退出，读取当前状态时必须返回 `shell_idle`，即使内存里残留了 Codex 状态或 active command。

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

Runweave 创建 tmux-backed terminal 时把 `RUNWEAVE_HOOK_ENDPOINT` 指向这个 agent hook endpoint，并通过 `RUNWEAVE_TERMINAL_SESSION_ID` 让 launcher 上报到正确 session。

## 与完成通知的边界

`TerminalState` 不消费旧的 completion event/feed，也不把完成通知 websocket 作为状态来源。`/internal/terminal-completion`、completion feed 和 `/ws/terminal-events` 只负责“非当前终端里的 AI 任务完成提醒”，例如终端 tab 小绿点。

Stop、ESC、SIGINT 或 HTTP interrupt 也不直接写 `TerminalState`。控制输入发出后，状态只能由后续 `Stop` hook 或 active command 变化自然校正。这样可以避免前端/App 在用户点击 Stop 后提前隐藏 Stop 按钮，造成状态假成功。

## 消费方

- App 终端详情页轮询 `/api/terminal/session/:id/state`，仅当 `terminalState.state === "agent_running"` 时展示 Stop。
- `rw terminal handoff` 读取当前 `TerminalState`，并把它作为 handoff 的权威状态字段；tail/echo 推断只用于短确认和诊断。
- App 首页 overview 返回基于同一状态服务折叠出的展示状态，避免 App 列表和详情页使用不同状态机。

## 运行限制

当前状态模型只支持 Codex。Claude、Trae/Coco 或普通 shell 命令需要后续扩展 `TerminalAgentKind` 或新增 `shell_running`，不要通过 tail 文本猜测提前混入当前模型。

如果 hook 丢失或 backend 重启，状态可能短期停留在旧值或回到 `shell_idle`。下一次 active command 或 agent hook 到达后会覆盖当前状态；系统不根据运行时长做 stale timeout 猜测。
