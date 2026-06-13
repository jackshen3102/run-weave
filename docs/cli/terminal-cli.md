# Runweave Agent CLI 控制面

`rw` 是 Runweave backend 面向外部 agent 的命令行控制面，用于发现应用状态、管理 terminal project/session、发送输入、读取 terminal 上下文并回收明确指定的 session。CLI 不直接操作 tmux，也不接管持续交互式终端。

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
RUNWEAVE_BASE_URL=http://127.0.0.1:5001
RUNWEAVE_ACCESS_TOKEN=<access-token>
```

## Agent 投递闭环

OpenCloud、OpenClaw、Hermes 等外部 agent 的首期推荐流程：

```bash
rw health --json
rw app overview --json

PROJECT_ID=$(
  rw project ensure --name browser-viewer --path "$PWD" --json \
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
```

CLI 不提供批量删除，也不会按 project 或 cwd 推断删除目标。
