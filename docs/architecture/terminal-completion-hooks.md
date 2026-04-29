# 终端完成事件 Hook 链路

本文描述 Runweave 如何把 Codex、Coco/Trae 等 AI CLI 的完成事件映射到终端 tab 右侧的小绿点。核心目标是让小绿点从“非活跃终端有输出”改为“某个 AI 任务明确发出了完成事件”，降低噪声。

## 背景

早期终端 tab 的绿色状态点基于输出活动判断：非当前 tab 只要有新输出，就点亮。这在普通 shell 里有一定价值，但在长期运行的 AI CLI 场景中噪声很高：

- Codex、Coco/Trae 经常持续输出中间状态。
- 很多 tab 都会因为日志、刷新或后台命令变成绿色。
- 用户真正关心的是“哪个 AI 任务完成了，可以回去接管”。

因此新模型不再把普通输出当成完成信号，而是只消费 AI CLI 的 hook / notify 完成事件。

## 总体链路

```text
Codex / Coco / Trae task finishes
  -> CLI hook or notify command runs browser-viewer-hook-bridge
    -> self-contained launcher reads Runweave terminal identity from tmux pane env
      -> launcher POSTs completion event to backend internal endpoint
        -> backend records event in TerminalCompletionEventStore
          -> frontend polls authenticated completion-events API
            -> inactive matching terminal tab shows green dot
```

对应的关键代码路径：

- Hook 安装与自包含 launcher 生成：`electron/src/hooks/hook-installer.ts`
- tmux 环境注入：`backend/src/terminal/runtime-launcher.ts`、`backend/src/terminal/tmux-service.ts`
- 内部写入接口：`backend/src/routes/terminal-completion.ts`
- 事件存储：`backend/src/terminal/completion-events.ts`
- 前端拉取与点亮：`frontend/src/services/terminal.ts`、`frontend/src/components/terminal/terminal-workspace.tsx`
- 协议类型：`packages/shared/src/terminal-protocol.ts`

## 为什么是自包含 Launcher

Codex、Coco/Trae 这类 CLI 对外最稳定的扩展点通常不是 SDK 回调，而是“事件发生时执行一条命令”。例如：

```bash
~/.browser-viewer/bin/browser-viewer-hook-bridge --source codex
```

这条命令不是用户操作入口，而是一个适配层：

- CLI 只需要知道“完成时执行这个命令”。
- Launcher 负责把不同 CLI 的 hook payload 归一化成 Runweave completion event。
- Runweave 不需要侵入 Codex、Coco/Trae 进程，也不需要监听它们的 stdout。
- Launcher 失败时吞掉错误，不影响原 AI CLI 的任务结束流程。

`~/.browser-viewer/bin/browser-viewer-hook-bridge` 是稳定 launcher。它本身包含最小 Node 上报逻辑，直接读取当前进程环境里的 Runweave endpoint、token 和 terminal id 后上报事件，不再指向某个 Electron 客户端资源目录。这样多个客户端或多个 dev checkout 并行启动时，不会出现“最后启动的客户端重写全局 launcher，导致其他客户端的 hook 依赖错误资源路径”的问题。

## Hook 安装

Electron 启动时会调用 `installHooksIfNeeded()`。它会在用户已有相关 CLI 配置目录时安装 Runweave hook：

- Claude：`~/.claude/settings.json`
- Codex：`~/.codex/hooks.json`
- Trae/Coco：`~/.trae/traecli.yaml`

安装行为需要满足几个原则：

- 保留已有第三方 hook，不覆盖用户配置。
- 同一个事件只保留一个 Runweave launcher hook，避免重复上报。
- 首次写入前创建 `.browser-viewer-hook-backup` 备份。
- 配置文件无法安全解析时跳过，避免破坏现有配置。

Codex 的标准 hook entry 形态类似：

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "/Users/<user>/.browser-viewer/bin/browser-viewer-hook-bridge --source codex",
      "timeout": 5
    }
  ]
}
```

Trae/Coco 的 hook entry 形态类似：

```yaml
hooks:
  - type: command
    command: "/Users/<user>/.browser-viewer/bin/browser-viewer-hook-bridge --source trae"
    matchers:
      - event: user_prompt_submit
      - event: post_tool_use
      - event: stop
      - event: subagent_stop
```

Launcher 当前只会上报完成类事件，其他事件会被忽略。

## 自包含 Launcher 与多客户端并存

早期实现里，`~/.browser-viewer/bin/browser-viewer-hook-bridge` 是一个 bash launcher，内部写死类似下面的资源路径：

```bash
HOOK_BRIDGE_PATH="/Applications/Browser Viewer.app/Contents/Resources/hook-bridge.mjs"
```

这个模型在单客户端下可用，但在多客户端或多 dev checkout 并行时有隐患：用户级 launcher 是全局文件，后启动的客户端会重写 `HOOK_BRIDGE_PATH`，导致已经运行在客户端 A 的 Codex 完成时，可能执行客户端 B 的 bridge 资源。

当前实现把 launcher 改成自包含 Node 脚本：

- launcher 路径仍固定为 `~/.browser-viewer/bin/browser-viewer-hook-bridge`。
- launcher 内不再写死任何 Electron app 路径、repo 路径或 `hook-bridge.mjs` 路径。
- launcher 只依赖当前进程环境里的 `RUNWEAVE_*` 变量。
- completion event 会回到启动该 tmux pane 时注入的 `RUNWEAVE_HOOK_ENDPOINT`。

因此，多客户端并存时真正决定事件归属的是 tmux pane 里的环境变量，而不是“最后启动哪个客户端”。客户端 A 创建的 terminal pane 会带 A backend 的 endpoint/token；客户端 B 创建的 terminal pane 会带 B backend 的 endpoint/token。两个客户端可以共享同一个全局 launcher，但事件仍各自回到对应 backend。

## Codex Notify 兼容路径

Codex 在某些环境里除了 `hooks.json`，还会通过 `config.toml` 的 `notify` 命令发送系统通知。用户实际看到的“Codex 完成了”通知可能来自这个 notify 脚本，而不是 `hooks.json` 的 `Stop` hook。

为了兼容这种路径，可以让 notify 脚本在完成系统通知后额外调用同一个 launcher：

```text
Codex turn-ended notify
  -> ~/.codex/notify.sh
    -> macOS notification / sound
    -> browser-viewer-hook-bridge --source codex
```

这不是另一套协议，只是把 Codex 的“系统通知已发生”也转成同一个 Runweave completion event。

## tmux 身份注入

Launcher 必须知道“这个完成事件属于哪个 Runweave terminal tab”。这不能靠 cwd 或进程名推断，因为多个 tab 可能在同一目录运行 Codex。

Runweave 在创建 tmux session 时注入以下环境变量：

```text
RUNWEAVE_TERMINAL_SESSION_ID=<terminal session id>
RUNWEAVE_PROJECT_ID=<project id>
RUNWEAVE_TMUX_SESSION_NAME=<tmux session name>
RUNWEAVE_HOOK_ENDPOINT=http://127.0.0.1:<backend-port>/internal/terminal-completion
RUNWEAVE_HOOK_TOKEN=<random per-backend token>
```

其中：

- `RUNWEAVE_TERMINAL_SESSION_ID` 是前端 tab 和后端 session 的主身份。
- `RUNWEAVE_HOOK_ENDPOINT` 是本机 backend 内部写入接口。
- `RUNWEAVE_HOOK_TOKEN` 是内部写入鉴权 token。

tmux 的价值在这里很直接：Codex/Coco 是从某个 tmux pane 里启动的，子进程会继承 pane 的环境变量。任务完成时 hook 命令也在同一环境下执行，因此 launcher 可以可靠拿到 terminal id。

旧 tmux pane 如果创建于这套环境注入之前，就没有这些变量。此时即使 Codex 发出了通知，launcher 也无法知道应该点亮哪个 tab。

## Launcher 行为

`browser-viewer-hook-bridge` 做的事刻意保持很小：

1. 从 stdin 读取 hook payload。
2. 解析事件名，兼容 `hook_event_name`、`hookEventName`、`eventName`、`event`。
3. 只接受 `stop`、`subagent_stop`、`subagentstop`。
4. 读取 `RUNWEAVE_HOOK_ENDPOINT`、`RUNWEAVE_HOOK_TOKEN`、`RUNWEAVE_TERMINAL_SESSION_ID`。
5. 向 backend POST completion event。
6. 所有错误静默失败，不影响原 CLI。

上报 payload 形态：

```json
{
  "terminalSessionId": "<terminal session id>",
  "source": "codex",
  "hookEvent": "Stop",
  "cwd": "/path/from/payload/or/PWD"
}
```

`source` 用来区分事件来源，目前支持 `claude`、`codex`、`trae`、`unknown`。

## 后端写入接口

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
- 写入成功返回 `202` 和 event。

这里的 `401` 是预期行为。这个接口不是给浏览器页面直接调用的普通 API，而是本机内部写入入口。没有 hook token 的请求必须被拒绝，否则任意本机网页或脚本都可以伪造“某个终端完成了”的事件。

写入成功后，后端把事件放进内存 `TerminalCompletionEventStore`。当前 store 保留最近 200 条事件，并用递增字符串 id 支持增量拉取。

## 前端消费

前端通过已登录用户的普通 API 拉取事件：

```http
GET /api/terminal/completion-events?after=<last-event-id>
Authorization: Bearer <token>
```

前端行为：

- 轮询 completion events。
- 只对非当前 active terminal 设置 completion marker。
- 当前 active terminal 收到完成事件时不点亮，因为用户已经在看它。
- 用户切到对应 terminal 后清除 marker。
- session 不存在后清理 marker。
- 黄色 bell marker 仍然保留，完成事件使用绿色 marker。

也就是说，小绿点现在表达的是：

```text
这个非当前 terminal 里的 AI CLI 发出了完成事件
```

而不是：

```text
这个非当前 terminal 有任何新输出
```

## 安全边界

这条链路的安全边界分两层：

- 内部写入接口用 `RUNWEAVE_HOOK_TOKEN` 保护，避免任意本机请求伪造完成事件。
- 前端读取接口仍走正常用户鉴权，避免未登录页面读取 terminal event。

token 是 backend 启动时生成或从环境读取的随机值，只通过 tmux session 环境传给该 session 下的子进程。它不应该写入日志、文档或持久化配置。

## 运行边界

这套机制依赖几个前提：

- AI CLI 必须通过 Runweave 的 tmux-backed terminal 启动。
- tmux session 必须是在 Runweave 注入 hook 环境变量之后创建的。
- Codex/Coco/Trae 必须实际执行了对应 hook 或 notify 命令。
- backend 必须正在运行，并且 `RUNWEAVE_HOOK_ENDPOINT` 指向当前可用端口。
- frontend 必须能通过登录态调用 `/api/terminal/completion-events`。

不会覆盖的情况：

- 旧 PTY session。
- 旧 tmux pane 缺少 `RUNWEAVE_*` 环境变量。
- 用户在 Runweave 外部系统终端里运行 Codex。
- Codex/Coco 任务没有触发 stop / notify。
- backend 重启后，旧 pane 里的 endpoint/token 指向旧进程或旧 token。

不再依赖的内容：

- launcher 内部不再写死 `HOOK_BRIDGE_PATH`。
- launcher 不再依赖 `electron/resources/hook-bridge.mjs`。
- 多个 Electron 客户端并行时，launcher 不再依赖“最后一次启动的客户端资源目录”。

## 排障顺序

如果用户反馈“Codex 完成了但 tab 没亮”，按下面顺序排查。

### 1. 确认前端能显示 marker

手动向内部接口写入一条 event，观察非当前 tab 是否出现绿色点。需要从目标 tmux session 环境里取得 endpoint、token 和 terminal id。

成功响应应为：

```text
HTTP/1.1 202 Accepted
```

如果前端能亮，说明 UI 和前端轮询链路正常。

### 2. 确认 Codex hook 是否安装

检查 `~/.codex/hooks.json` 是否包含 `browser-viewer-hook-bridge --source codex`。

如果用户看到系统通知但 `hooks.json` 没有触发，还需要检查 `~/.codex/config.toml` 的 `notify` 命令是否最终调用了 `~/.codex/notify.sh`，以及 notify 脚本是否串到了 launcher。

### 3. 确认 tmux pane 是否有 Runweave 环境变量

在目标 terminal 内执行：

```bash
env | rg '^RUNWEAVE_'
```

至少应看到：

```text
RUNWEAVE_TERMINAL_SESSION_ID=...
RUNWEAVE_HOOK_ENDPOINT=...
RUNWEAVE_HOOK_TOKEN=...
```

如果没有，通常说明这是旧 pane 或外部终端。需要新建 Runweave terminal tab 后再启动 AI CLI。

### 4. 确认内部接口鉴权结果

直接不带 token 请求内部接口返回 `401` 是正常的。只有 launcher 带上 `X-Runweave-Hook-Token` 后才应该写入成功。

### 5. 确认事件是否属于当前 active terminal

如果 completion event 属于当前正在查看的 tab，前端不会点亮小绿点。需要切到其他 tab 后再观察，或检查前端 state 中是否已经收到事件。

## 设计取舍

这个方案的好处：

- 不再把普通输出误判为完成。
- 不需要解析 Codex/Coco 的终端输出文本。
- 不侵入 AI CLI 进程。
- 通过 tmux pane 环境变量建立稳定的 terminal 身份绑定。
- hook 失败不影响 AI CLI 的主流程。

代价：

- 链路比普通 stdout activity marker 更隐式。
- 本机 CLI 配置、notify 脚本、tmux 环境变量都可能成为断点。
- backend token 和 endpoint 跟进程生命周期相关，旧 pane 可能失效。
- 当前 event store 是内存态，backend 重启后历史 completion marker 不保留。

后续可以补一个产品化诊断入口，在 terminal tab 或调试面板里显示：

- 当前 tab 是否有 `RUNWEAVE_TERMINAL_SESSION_ID`。
- hook endpoint 是否可用。
- 最近一次 completion event 的 source / time / terminal id。
- Codex/Coco hook 是否已安装。
