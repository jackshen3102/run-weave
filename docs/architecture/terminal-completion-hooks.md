# 终端完成事件 Hook 链路

本文描述 Runweave 如何把 Codex、Coco/Trae 等 AI CLI 的完成事件映射到终端 tab 右侧的小绿点。核心目标是让小绿点表达“某个非当前终端里的 AI 任务明确完成了”，而不是“这个终端有任意新输出”。

## 背景

早期终端 tab 的绿色状态点基于输出活动判断。长期运行 AI CLI 时，这会把中间日志、刷新输出和普通 shell 噪声都当成提醒。当前模型只消费 AI CLI 的 hook / notify 完成事件，不解析 stdout，也不把普通命令退出推断为任务完成。

## 总体链路

```text
Codex / Coco / Trae task finishes
  -> CLI hook or notify command runs runweave-hook-bridge
    -> launcher reads Runweave terminal identity from tmux pane env
      -> launcher POSTs completion event to backend internal endpoint
        -> backend validates hook token + terminal/source gate
        -> CompletionEventService records a completion envelope in TerminalEventService
          -> /ws/terminal-events pushes the global event to online Web/App clients
            -> inactive matching terminal tab shows green dot
```

关键代码路径：

- Hook 安装入口：`electron/src/hooks/hook-installer.ts`
- Hook 配置合并与旧配置清理：`electron/src/hooks/hook-installer-config.ts`
- 自包含 launcher 生成：`electron/src/hooks/hook-launcher-script.ts`
- tmux 环境注入：`backend/src/terminal/runtime-launcher.ts`、`backend/src/terminal/tmux-service.ts`
- 内部写入接口：`backend/src/routes/terminal-completion.ts`
- source / active command 门禁：`backend/src/terminal/completion-source-gate.ts`、`backend/src/terminal/manager.ts`
- 全局事件服务与 completion 兼容层：`backend/src/terminal/terminal-event-service.ts`、`backend/src/terminal/completion-event-service.ts`、`backend/src/terminal/completion-events.ts`
- workspace 事件 WebSocket：`backend/src/ws/terminal-events-server.ts`、`backend/src/ws/terminal-events-handshake.ts`
- 前端连接与点亮：`frontend/src/features/terminal/use-terminal-events-connection.ts`、`frontend/src/components/terminal/terminal-workspace.tsx`
- 协议类型：`packages/shared/src/terminal-protocol.ts`

## Launcher 与身份注入

`~/.runweave/bin/runweave-hook-bridge` 是稳定 launcher。它是自包含 Node 脚本，不写死 Electron app、repo 或资源路径，只读取当前进程环境里的 `RUNWEAVE_*` 变量。

Runweave 创建 tmux-backed terminal 时注入：

```text
RUNWEAVE_TERMINAL_SESSION_ID=<terminal session id>
RUNWEAVE_PROJECT_ID=<project id>
RUNWEAVE_TMUX_SESSION_NAME=<tmux session name>
RUNWEAVE_HOOK_ENDPOINT=http://127.0.0.1:<backend-port>/internal/terminal/agent-hook
RUNWEAVE_COMPLETION_HOOK_ENDPOINT=http://127.0.0.1:<backend-port>/internal/terminal-completion
RUNWEAVE_HOOK_TOKEN=<random per-backend token>
```

`RUNWEAVE_HOOK_ENDPOINT` 是 Codex `TerminalState` 的写入入口；`RUNWEAVE_COMPLETION_HOOK_ENDPOINT` 是完成提醒入口。为了兼容旧 pane，launcher 在缺少 completion endpoint 时会从 agent hook endpoint 派生 `/internal/terminal-completion`。这让多个客户端或多个 dev checkout 可以共享同一个用户级 launcher。事件归属由启动该 tmux pane 时注入的 endpoint、token 和 terminal id 决定，而不是由“最后启动哪个客户端”决定。

旧 pane、PTY session、外部系统终端或缺少 `RUNWEAVE_*` 的进程不会上报完成事件。

## Hook 安装与上报行为

Electron 启动时会调用 `installHooksIfNeeded()`，在用户已有相关 CLI 配置目录时安装 Runweave hook：

- Claude：`~/.claude/settings.json`
- Codex：Toolkit 插件根目录 `hooks.json` 是主入口；`~/.codex/hooks.json` 只保留为历史全局配置的兼容/清理层
- Trae/Coco：Toolkit 插件根目录 `hooks.json` 是主入口；`~/.trae/traecli.toml` 只保留为历史全局配置的兼容/清理层

安装必须保留已有第三方 hook、去重 Runweave launcher hook，并在首次写入前创建 `.runweave-hook-backup` 备份。配置无法安全解析时跳过，避免破坏用户配置。

launcher 行为很窄：

1. 读取 hook payload。
2. 解析事件名，兼容 `hook_event_name`、`hookEventName`、`eventName`、`event`。
3. 只接受 `stop`、`subagent_stop`、`subagentstop`。
4. 读取 `RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN`、`RUNWEAVE_TERMINAL_SESSION_ID`，缺任一则静默退出。
5. Codex/Trae 的 `SessionStart`、`UserPromptSubmit`、`Stop` 会上报到 agent hook endpoint，用于维护 `TerminalState`。
6. Stop / notify 类完成事件会发出桌面/飞书完成通知，并向 backend 上报 completion event。
7. 所有错误静默失败，不影响原 AI CLI 结束流程。

Codex 的 `notify` 命令也可以在系统通知后调用同一个 launcher。这不是另一套状态协议，只是把 Codex 的“通知已发生”转成同一个 Runweave completion event。

完成提醒和 `TerminalState` 是两条链路：完成提醒点亮非当前终端的小绿点，`TerminalState` 只表达当前终端是否处在 `shell_idle`、`agent_idle` 或 `agent_running`。completion event/feed 不能写入或修正 `TerminalState`。

上报 payload 示例：

```json
{
  "terminalSessionId": "<terminal session id>",
  "source": "codex",
  "hookEvent": "Stop",
  "cwd": "/path/from/payload/or/PWD"
}
```

## 后端写入与门禁

内部接口：

```http
POST /internal/terminal-completion
X-Runweave-Hook-Token: <RUNWEAVE_HOOK_TOKEN>
Content-Type: application/json
```

接口行为：

- 未配置 token 返回 `503`。
- token 不匹配返回 `401`。
- body 不合法返回 `400`。
- terminal session 不存在返回 `404`。
- source 不在 allowlist 或与 AI active command 不匹配时不记录事件。
- 写入成功返回 `202` 和 event。

写入层不是 source-only 信任模型。除 hook token 和 terminal id 外，还要求 `source` 与当前 AI active command 匹配；如果 Stop hook 晚到，当前 `activeCommand` 已清空，则接受 30 秒 grace window 内最近一次匹配的 AI active command。若用户已经切到其他命令、最近 AI command 超时或 source 不匹配，事件会被忽略，避免旧进程或误继承环境的进程伪造完成提醒。

成功写入后，`CompletionEventService` 会把 completion payload 包装成 `kind="completion"` 的全局 `TerminalEventEnvelope`，写入 `TerminalEventService` 的内存短队列，并广播给在线 `/ws/terminal-events` 订阅者。短队列保留最近 200 条全局 terminal events，用于重连 catch-up 和兼容 HTTP 读取。

## 前端实时消费

前端不再通过定时轮询点亮小绿点。登录态页面先请求：

```http
POST /api/terminal/completion-events/ws-ticket
Authorization: Bearer <token>
```

响应包含临时 `terminal-events-ws` ticket 和 `baselineEventId`。`baselineEventId` 来自全局 `TerminalEventService.getLatestId()`，不是 completion-only cursor。前端随后连接：

```text
/ws/terminal-events?token=<ticket>&after=<baselineEventId-or-last-event-id>
```

语义：

- `/ws/terminal-events` 是全局 terminal event bus，不只推当前 terminal。
- 首连用 ticket API 返回的 `baselineEventId` 作为 `after`，避免建立连接前后的竞态。
- 重连用本地已处理的最新 event id 作为 `after`，补齐断线窗口内的短期事件。
- 服务端建连后先注册 listener，再发送 catch-up，因此边界事件可能重复投递；前端按 event id 去重。
- 服务端消息统一为 `terminal-events` catch-up 和 `terminal-event` live envelope；新消费者不再使用旧的 `completion-events` / `completion-event` message。
- completion catch-up 只恢复 marker，不播放完成音；live completion 可以触发完成音。
- 当前 active terminal 收到 completion event 不点亮，因为用户已经在看它。
- 非当前 terminal 设置 completion marker；用户切到对应 terminal 后清除 marker。
- `terminal_state_changed` 事件用于 Web/App 共享状态同步，App 不再依赖 2 秒 HTTP 轮询作为主路径。
- session 删除或列表刷新后，由 marker cleanup 清理不存在 session 的 marker。

`GET /api/terminal/completion-events?after=<last-event-id>` 仍保留给 CLI、调试和兼容读取，但 Terminal Workspace 不再定时调用它。

小绿点含义是：

```text
这个非当前 terminal 里的 AI CLI 发出了可信完成事件
```

不是：

```text
这个非当前 terminal 有任何新输出
```

## 全局 Terminal Event Envelope

`/ws/terminal-events` 对外统一投递 `TerminalEventEnvelope`：

```ts
export type TerminalEventKind =
  | "completion"
  | "terminal_state_changed"
  | "terminal_notification";

export interface TerminalEventEnvelopeBase {
  id: string;
  terminalSessionId: string;
  projectId: string | null;
  createdAt: string;
}
```

三类 payload 的边界：

- `completion`：AI CLI 完成提醒，用于非当前终端的小绿点和完成音。
- `terminal_state_changed`：Codex `TerminalState` 变化，用于 App/Web 同步 Stop、handoff 和列表状态。
- `terminal_notification`：后续系统级终端通知的预留 envelope，不改变 `/ws/terminal` 的单 terminal I/O 职责。

`TerminalEventService` 给所有 kind 使用同一个递增 cursor 空间。`listAfter(after)` 和 WebSocket catch-up 都按这个全局 cursor 返回事件，避免 completion 与 state 使用不同 baseline 导致 reconnect 漏事件。

## CLI 消费边界

`rw terminal send --confirm short --json` 不直接等待 completion event。它通过登录态 HTTPS input 接口把输入投递到指定 terminal，并短暂观察 echo 或运行态变化。Hermes/Feishu 场景默认应把这一步作为“已投递”的机器可读确认，任务完成仍由本页描述的 AI CLI hook / notify 链路主动上报。

后续如果实现长等待模式，CLI 可以通过普通登录态读取 `GET /api/terminal/completion-events?after=<id>`，并至少按 `terminalSessionId`、`source` 和 `createdAt >= sendStartedAt` 过滤，避免误消费同一 terminal 的旧事件。CLI 不能读取或复用 `RUNWEAVE_HOOK_TOKEN`。

## 安全边界

- 内部写入接口用 `RUNWEAVE_HOOK_TOKEN` 保护，避免任意本机请求伪造完成事件。
- 写入前校验 terminal session、source allowlist 和当前或近期 AI active command。
- workspace WebSocket ticket 由登录态换取，类型为 `terminal-events-ws`，不能复用于 `/ws/terminal`、viewer 或 DevTools 通道。
- 前端读取和 WebSocket 订阅都走正常用户鉴权。
- token 只通过 tmux session 环境传给该 session 下的子进程，不写入日志、文档或持久化配置。

## 运行边界

这套机制依赖：

- AI CLI 通过 Runweave tmux-backed terminal 启动。
- tmux session 是在 Runweave 注入 hook 环境变量之后创建的。
- Codex/Coco/Trae 实际执行了 stop hook 或 notify 命令。
- backend 正在运行，且 pane 内 `RUNWEAVE_HOOK_ENDPOINT` 指向当前可用端口。
- frontend 已登录，并能获取 `/api/terminal/completion-events/ws-ticket` 与连接 `/ws/terminal-events`。

不会覆盖：

- 旧 PTY session。
- 旧 tmux pane 缺少 `RUNWEAVE_*` 环境变量。
- 用户在 Runweave 外部系统终端里运行 AI CLI。
- AI CLI 没有触发 stop / notify。
- backend 重启后，旧 pane 里的 endpoint/token 指向旧进程或旧 token。
- WebSocket 断线时间过长，事件超过内存短队列保留窗口。

## 排障顺序

### 1. 确认前端实时通道

检查登录态能否换取 `/api/terminal/completion-events/ws-ticket`，并确认浏览器连接 `/ws/terminal-events`。WebSocket 未连接时，小绿点不会实时更新；断线重连只补齐内存短队列仍保留的事件。

### 2. 确认前端能显示 marker

在目标 tmux session 环境里取得 endpoint、token 和 terminal id，手动向内部接口写入一条 event。成功响应应为 `202 Accepted`。如果前端能亮，说明 UI、事件服务和 WebSocket 链路正常。

### 3. 确认 hook 是否安装

检查对应 CLI 配置是否包含 `runweave-hook-bridge --source ...`。如果用户看到系统通知但没有 Runweave marker，还需要检查 Codex `notify` 脚本是否最终调用了 launcher。

### 4. 确认 tmux pane 是否有 Runweave 环境变量

在目标 terminal 内执行：

```bash
env | grep '^RUNWEAVE_'
```

至少应看到 `RUNWEAVE_TERMINAL_SESSION_ID`、`RUNWEAVE_HOOK_ENDPOINT` 和 `RUNWEAVE_HOOK_TOKEN`。如果没有，通常说明这是旧 pane 或外部终端，需要新建 Runweave terminal 后再启动 AI CLI。

### 5. 确认 source / active command 门禁

如果内部接口返回成功但没有记录 event，检查后端滚动日志中 `terminal.completion.ignored` 一类事件。常见原因是 source 不在 allowlist、当前 active command 不匹配，或 Stop hook 晚到超过 30 秒 grace window。

## 设计取舍

收益：

- 不再把普通输出误判为完成。
- 不解析 AI CLI stdout。
- 不侵入 AI CLI 进程。
- 在线前端通过 WebSocket 实时收到完成事件。
- 重连可通过 cursor catch-up 补齐短期遗漏事件。
- source 与 active command 门禁保留误报边界。

代价：

- 链路比普通 stdout activity marker 更隐式。
- CLI 配置、notify 脚本、tmux 环境变量、backend token 和 WebSocket 都可能成为断点。
- event store 是内存态，backend 重启后历史 completion marker 不保留。

后续可以补产品化诊断入口，展示当前 tab 的 `RUNWEAVE_TERMINAL_SESSION_ID`、hook endpoint 可用性、最近 completion event、WebSocket 状态和 hook 安装状态。
