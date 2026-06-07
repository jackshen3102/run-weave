# Runweave Terminal CLI

`rw` 是 Runweave backend 的命令行客户端，用于外部 agent 通过稳定命令管理 terminal project/session、发送输入、读取快照和生成 handoff 上下文。首期不直接操作 tmux，也不接管持续交互式终端。

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
PROJECT_ID=$(
  rw project ensure --name browser-viewer --path "$PWD" --json \
    | jq -r '.projectId'
)

TERMINAL_ID=$(
  rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json \
    | jq -r '.terminalSessionId'
)

rw terminal send "$TERMINAL_ID" \
  --text "修复 typecheck 报错，完成后总结改动" \
  --enter \
  --confirm short \
  --json
```

`send --confirm short` 只做短确认，不等待 AI CLI 长任务完成。JSON 会返回 `transport`、`inputAccepted`、`inputEnqueued`、`runtimeKind`、`echoObserved`、`observedState`、`confirmConfidence`、`tailBefore` 和 `tailAfter`，供调用方决定是否重试、读取 snapshot 或向用户说明已投递。

`inputAccepted=true` / `inputEnqueued=true` 只在 backend 的 HTTPS input 接口已鉴权、找到目标 terminal，并且 `runtime.write(...)` 调用未抛错后出现。若 backend 返回 4xx/5xx，CLI 会以非 0 exit code 失败，不把传输层成功误报成投递成功。

## 读取上下文

```bash
rw terminal list --json
rw terminal show "$TERMINAL_ID" --json
rw terminal snapshot "$TERMINAL_ID" --tail 120 --plain
rw terminal handoff "$TERMINAL_ID" --tail 120 --json
```

`handoff` 会聚合 `cwd`、`sessionStatus`、`foregroundCommand`、`inferredAgent`、`inferredWorkloadState`、`stateConfidence`、`stateReasons`、tail 和建议命令。`inferredAgent` / `inferredWorkloadState` 是弱推断，只能用于展示或辅助判断，不能作为权限或调度依据。仅有 `activeCommand=codex` 这类前台进程信号时，CLI 会返回低置信度 `unknown`，不会直接断言 agent 正在执行。

## Completion Event 边界

Hermes/Feishu 默认应使用 `send --confirm short`，任务完成通知由已有 AI CLI hooks 主动发出，不要默认长时间阻塞等待。

completion event 依赖 Runweave tmux-backed terminal 内启动的 AI CLI 继承 `RUNWEAVE_TERMINAL_SESSION_ID`、`RUNWEAVE_PROJECT_ID`、`RUNWEAVE_HOOK_ENDPOINT` 和 `RUNWEAVE_HOOK_TOKEN`。旧 pane、外部系统终端、hook 未安装或非 tmux fallback terminal 不能依赖 completion 模式完成闭环。
