# Runweave Agent CLI 控制面

`rw` 是 Runweave backend 面向外部 agent 的命令行控制面，用于发现应用状态、管理 terminal project/session、发送输入、读取 terminal 上下文并回收明确指定的 project/session。CLI 不直接操作 tmux，也不接管持续交互式终端。

## 最小接入

源码仓库内使用：

```bash
pnpm cli:build

node packages/runweave-cli/dist/index.js auth login \
  --base-url http://127.0.0.1:5001 \
  --username admin
```

包安装后可直接使用 `rw`：

```bash
rw auth login --base-url http://127.0.0.1:5001 --username admin
```

登录信息保存在 `~/.runweave/config.json`，文件权限为 `0600`。也可以用环境变量覆盖：

```bash
RUNWEAVE_BACKEND_PORT=5001
RUNWEAVE_BASE_URL=http://127.0.0.1:5001
RUNWEAVE_ACCESS_TOKEN=<access-token>
```

本地后端端口默认是 `5001`。仅需要切换端口时使用
`RUNWEAVE_BACKEND_PORT=5111`，单次调用可以使用 `--backend-port 5111`；
需要自定义 scheme、host 或路径时使用 `RUNWEAVE_BASE_URL`。优先级是：
命令行 `--base-url`（仅 `auth login`）> 命令行 `--backend-port` >
`RUNWEAVE_BASE_URL` > `RUNWEAVE_BACKEND_PORT` > profile baseUrl > 默认端口。

## Agent 投递闭环

OpenCloud、OpenClaw、Hermes 等外部 agent 的首期推荐流程：

```bash
rw health --json
rw app overview --json

PROJECT_ID=$(
  rw project ensure --name runweave --path "$PWD" --json \
    | jq -r '.projectId'
)

TERMINAL_ID=$(
  rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json \
    | jq -r '.terminalSessionId'
)

rw terminal send "$TERMINAL_ID" \
  --text "pnpm typecheck" \
  --mode line \
  --json

rw terminal history "$TERMINAL_ID" --tail 200 --plain
```

`send` 成功只代表 backend 已鉴权、已找到目标 terminal，并已接受输入；不代表普通 shell 命令执行完成、成功退出或输出符合预期。普通 shell 命令的完成判断不属于 CLI 投递控制面的职责，调用方后续应通过 `history`、`snapshot` 或其它机制读取结果。

`send --confirm short` 只做短确认，不等待 AI CLI 长任务完成。JSON 会返回 `transport`、`inputAccepted`、`inputEnqueued`、`runtimeKind`、`echoObserved`、`observedState`、`confirmConfidence`、`tailBefore` 和 `tailAfter`，供调用方决定是否重试、读取 snapshot 或向用户说明已投递。

`inputAccepted=true` / `inputEnqueued=true` 只在 backend 的 HTTPS input 接口已鉴权、找到目标 terminal，并且 `runtime.write(...)` 调用未抛错后出现。若 backend 返回 4xx/5xx，CLI 会以非 0 exit code 失败，不把传输层成功误报成投递成功。

常用输入模式：

```bash
rw terminal send "$TERMINAL_ID" --text "pwd" --mode line --json
rw terminal send "$TERMINAL_ID" --text "/compact" --mode codex_slash_command --json
rw terminal send "$TERMINAL_ID" --text "raw bytes" --mode raw --json
```

旧调用仍可使用 `--enter`。当使用 `--mode line` 时，CLI 不会再额外追加回车。

需要把输入投递给某个 AI CLI 时，可以指定 agent：

```bash
rw terminal send "$TERMINAL_ID" --agent codex --text "继续" --json
rw terminal send "$TERMINAL_ID" --panel reviewer --agent codex --text "继续" --json
rw terminal send "$TERMINAL_ID" --agent traex --agent-overwrite --text "继续" --json
```

`--agent` 使用调用方传入的原始名字，不做归一化；例如 `trae`、`traecli`
和 `traex` 是三个不同 agent。带 `--agent` 但未显式传 `--mode` 时，CLI
默认使用 `line` 模式。

投递前，CLI 会先检查目标 terminal 是否已经处于该 agent 的
`agent_idle` 或 `agent_running` 状态。若目标 terminal 当前没有 agent，
CLI 会发送 agent 名本身作为启动命令，也可以通过 `--agent-start-command`
覆盖启动命令，并在 `--agent-start-timeout-ms`（默认 15000）内等待 agent
状态就绪。若同时传入 `--panel` 或 `--role`，agent 启动、clear、exit 与最终
输入都会定向到同一个 panel；`--panel` 优先于 `--role`。

若目标 terminal 已经是同一个 agent，默认直接复用；传 `--agent-overwrite`
时会先发送 `--agent-clear-command`（默认 `/clear`）新开一个 CLI 上下文，再
投递输入。若目标 terminal 是另一个 agent，默认失败；传
`--agent-overwrite` 时会先发送 `--agent-exit-command` 退出旧 agent，再启动
指定 agent 并投递输入。未显式设置 `--agent-exit-command` 时，`codex`、
`traex`、`traecli` 默认使用 `/quit`，其它 agent 默认使用 `/exit`。

## 读取上下文

```bash
rw project list --json
rw terminal list --json
rw terminal show "$TERMINAL_ID" --json
rw terminal state "$TERMINAL_ID" --json
rw terminal history "$TERMINAL_ID" --tail 200 --json
rw terminal snapshot "$TERMINAL_ID" --tail 120 --plain
rw terminal handoff "$TERMINAL_ID" --tail 120 --json
```

`handoff` 会聚合 `cwd`、`sessionStatus`、`foregroundCommand`、后端 `TerminalState`、tail 和建议命令。`terminalState` 是 App/CLI 共享的权威产品状态；`inferredAgent` / `inferredWorkloadState` 只保留为短确认和诊断辅助，不能作为权限或调度依据。仅有 `activeCommand=codex` 这类前台进程信号时，CLI 不直接断言 agent 正在执行，是否 running 以 `/api/terminal/session/:id/state` 返回的 `TerminalState` 为准。

## Completion Event 边界

Hermes/Feishu 默认应使用 `send --confirm short`，任务完成通知由已有 AI CLI hooks 主动发出，不要默认长时间阻塞等待。

completion event 依赖 Runweave tmux-backed terminal 内启动的 AI CLI 继承 `RUNWEAVE_TERMINAL_SESSION_ID`、`RUNWEAVE_PROJECT_ID`、`RUNWEAVE_HOOK_ENDPOINT` 和 `RUNWEAVE_HOOK_TOKEN`。旧 pane、外部系统终端、hook 未安装或非 tmux fallback terminal 不能依赖 completion 模式完成闭环。

## 显式清理

自动化任务只应清理自己明确持有的 terminal id：

```bash
rw terminal delete "$TERMINAL_ID" --json
rw project delete "$PROJECT_ID" --json
```

CLI 不提供批量删除，也不会按 name、path、project 或 cwd 推断删除目标。删除 project 会级联删除该 project 下的 terminal session。
