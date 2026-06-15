# Runweave Agent CLI 控制面测试案例

本文档用于验证 `rw` 作为外部 agent 控制 Runweave backend 的 CLI 控制面。覆盖 backend 可达性发现、认证状态判断、项目/终端发现、项目/终端创建、输入投递、上下文读取、显式清理，以及 CLI 创建后 Web/App 通过 terminal-events WebSocket 实时同步列表的行为。

涉及打开页面、点击、输入、截图或浏览器自动化验证时，必须使用 `$playwright-cli`，不要使用其它浏览器操作方案。

## 目标契约

- `rw health` 能区分 backend 不可达、backend 可达但未认证、backend 可达且已认证，以及 `/health` 被 tunnel auth 阻断。
- `rw app overview`、`rw project list`、`rw terminal list/show/state/snapshot/history/handoff` 输出稳定 JSON，便于 agent 解析。
- `rw project ensure` 能复用同路径项目；`rw terminal create` 能创建普通 shell、指定命令、携带多个 `--arg`、继承已有终端上下文。
- `rw terminal send` 的成功只代表 backend 已接受输入，不代表命令执行完成。
- `rw terminal send --mode line` 不重复追加回车；默认 raw + `--enter` 兼容旧行为；`codex_slash_command` 错误不被 CLI 吞掉。
- `rw terminal delete` 只删除显式传入的 terminal id，不做批量推断。
- 通过 `rw project ensure` / `rw terminal create` 创建的项目和终端，会经 `/ws/terminal-events` 推送到 Web/App，界面无需刷新即可新增 project/card/tab。
- 所有错误路径使用非 0 exit code，并保留可读错误 message。

## 相关文件

- CLI 文档：`docs/cli/terminal-cli.md`
- CLI 入口：`packages/runweave-cli/src/index.ts`
- CLI auth/baseUrl：`packages/runweave-cli/src/client/auth-context.ts`、`packages/runweave-cli/src/client/cli-base-url.ts`
- CLI terminal client：`packages/runweave-cli/src/client/terminal-http-client.ts`
- CLI 命令：`packages/runweave-cli/src/commands/health.ts`、`app.ts`、`project.ts`、`terminal.ts`
- 共享协议：`packages/shared/src/terminal-protocol.ts`
- 后端项目/终端路由：`backend/src/routes/terminal-project-routes.ts`、`backend/src/routes/terminal.ts`
- terminal-events WS：`backend/src/ws/terminal-events-server.ts`
- Web workspace：`frontend/src/components/terminal/terminal-workspace.tsx`
- App session：`app/src/hooks/use-app-session.ts`
- E2E：`frontend/tests/terminal.spec.ts`

## 测试环境

建议使用临时配置和临时 workspace，避免污染本机登录态和项目列表。

```bash
export RUNWEAVE_CONFIG_FILE="$(mktemp -d)/runweave-config.json"
export RUNWEAVE_BACKEND_PORT="${RUNWEAVE_BACKEND_PORT:-5001}"
export RUNWEAVE_BASE_URL="${RUNWEAVE_BASE_URL:-http://127.0.0.1:${RUNWEAVE_BACKEND_PORT}}"
export RW_BIN="node packages/runweave-cli/dist/index.js"
```

构建 CLI：

```bash
pnpm --filter @runweave/cli build
```

启动 backend：

```bash
pnpm start
```

登录：

```bash
$RW_BIN auth login \
  --base-url "$RUNWEAVE_BASE_URL" \
  --username admin
```

如果测试环境要求密码，按交互输入或通过 stdin 提供。测试完成后删除临时 `RUNWEAVE_CONFIG_FILE` 所在目录。

## 自动化静态验证

| ID            | 范围              | 命令                                                                                                     | 预期                              |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| RW-STATIC-001 | CLI 类型          | `pnpm --filter @runweave/cli typecheck`                                                                  | 无 TS error                       |
| RW-STATIC-002 | CLI lint          | `pnpm --filter @runweave/cli lint`                                                                       | 无 lint error                     |
| RW-STATIC-003 | CLI 构建          | `pnpm --filter @runweave/cli build`                                                                      | 生成 `packages/runweave-cli/dist` |
| RW-STATIC-004 | shared 类型       | `pnpm --filter @runweave/shared typecheck`                                                               | terminal event 协议无 TS error    |
| RW-STATIC-005 | backend lint/type | `pnpm --filter @runweave/backend lint && pnpm --filter @runweave/backend typecheck`                      | 无 lint/TS error                  |
| RW-STATIC-006 | Web lint/type     | `pnpm --filter @runweave/frontend lint && pnpm --filter @runweave/frontend typecheck`                    | 无 lint/TS error                  |
| RW-STATIC-007 | Web E2E 事件同步  | `pnpm --filter @runweave/frontend exec playwright test tests/terminal.spec.ts --grep "externally created | externally deleted"`              | 外部创建/删除后 UI 通过事件刷新列表 |
| RW-STATIC-008 | App 类型          | `pnpm --filter @runweave/app typecheck`                                                                  | 无 TS error                       |

## Health 测试

| ID            | 场景                          | 步骤                                                                                         | 预期                                                                                   |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| RW-HEALTH-001 | 默认 baseUrl 未登录           | 清空 `RUNWEAVE_CONFIG_FILE`；不设置 token；执行 `$RW_BIN health --json`                      | 请求默认 `http://127.0.0.1:5001/health`；不报 profile 未登录错误                       |
| RW-HEALTH-002 | backend 可达但无 token        | backend 在线；无 access token；执行 `$RW_BIN health --json`                                  | exit code `0`；`reachable=true`；`authenticated=false`                                 |
| RW-HEALTH-003 | backend 可达且 token 有效     | 登录后执行 `$RW_BIN health --json`                                                           | exit code `0`；`reachable=true`；`authenticated=true`；含 `health.status`              |
| RW-HEALTH-004 | token 过期或 verify 401       | 使用无效 `RUNWEAVE_ACCESS_TOKEN`；执行 `$RW_BIN health --json`                               | exit code `0`；`reachable=true`；`authenticated=false`                                 |
| RW-HEALTH-005 | `/health` 被 tunnel auth 阻断 | 使用需要 tunnel auth 但未带 tunnel auth 的 baseUrl；执行 `$RW_BIN health --json`             | exit code `3`；`reachable=false`；`blockedByTunnelAuth=true`；message 指向 tunnel auth |
| RW-HEALTH-006 | backend 网络不可达            | 停止 backend 或设置不存在端口；执行 `$RW_BIN health --json`                                  | exit code `3`；`reachable=false`；stderr 有可读网络错误                                |
| RW-HEALTH-007 | profile baseUrl 未登录        | 配置 profile 只有 `baseUrl` 无 token；执行 `$RW_BIN health --profile local --json`           | 仍请求该 profile 的 baseUrl；不抛 `Runweave profile "local" is not logged in`          |
| RW-HEALTH-008 | env baseUrl 优先级            | profile 指向 A，`RUNWEAVE_BASE_URL` 指向 B；执行 `$RW_BIN health --json`                     | 输出 `baseUrl` 为 B                                                                    |
| RW-HEALTH-009 | env backend port              | 不设置 `RUNWEAVE_BASE_URL`，设置 `RUNWEAVE_BACKEND_PORT=5111` 后执行 `$RW_BIN health --json` | 请求默认本地 host 的 `http://127.0.0.1:5111/health`                                    |
| RW-HEALTH-010 | backend-port 参数优先级       | 设置 `RUNWEAVE_BASE_URL` 指向 A，同时执行 `$RW_BIN health --backend-port 5111 --json`        | 请求默认本地 host 的 `http://127.0.0.1:5111/health`                                    |

## App Overview 与发现能力测试

| ID          | 场景                | 步骤                                                     | 预期                                                 |
| ----------- | ------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| RW-DISC-001 | app overview JSON   | `$RW_BIN app overview --json`                            | 输出包含 `projects` 和 `sessions` 的 JSON            |
| RW-DISC-002 | app overview 未认证 | 清 token 后执行 `$RW_BIN app overview --json`            | 非 0 exit code；stderr 保留 401/Unauthorized 信息    |
| RW-DISC-003 | project list JSON   | `$RW_BIN project list --json`                            | 输出后端项目数组                                     |
| RW-DISC-004 | terminal list JSON  | `$RW_BIN terminal list --json`                           | 输出后端终端数组                                     |
| RW-DISC-005 | terminal show JSON  | 创建终端后 `$RW_BIN terminal show "$TERMINAL_ID" --json` | 输出对应 terminal status，含 `cwd/status/scrollback` |
| RW-DISC-006 | 404 不伪装成功      | `$RW_BIN terminal show missing-terminal --json`          | exit code `4`；stderr 为 terminal not found          |

## Project 创建与复用测试

| ID          | 场景                    | 步骤                                                                                              | 预期                                                        |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| RW-PROJ-001 | ensure 新建项目         | `PROJECT_ID=$($RW_BIN project ensure --name rw-test --path "$PWD" --json \| jq -r '.projectId')`  | exit code `0`；返回 `projectId/name/path`                   |
| RW-PROJ-002 | ensure 同路径复用       | 对同一个 `--path "$PWD"` 再执行一次 ensure                                                        | 返回同一个 `projectId`；不重复创建项目                      |
| RW-PROJ-003 | list 能发现 ensure 结果 | `$RW_BIN project list --json \| jq -r '.[] \| select(.projectId=="'$PROJECT_ID'") \| .projectId'` | 能找到该项目                                                |
| RW-PROJ-004 | path 不存在             | `$RW_BIN project ensure --name bad --path /path/does/not/exist --json`                            | 非 0 exit code；stderr 有 realpath/path 错误                |
| RW-PROJ-005 | 缺少 name               | `$RW_BIN project ensure --path "$PWD" --json`                                                     | exit code `2`；stderr 包含 `Missing required option --name` |
| RW-PROJ-006 | 缺少 path               | `$RW_BIN project ensure --name rw-test --json`                                                    | exit code `2`；stderr 包含 `Missing required option --path` |

## Terminal 创建测试

| ID            | 场景                          | 步骤                                                                                                                                  | 预期                                                         |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| RW-CREATE-001 | 默认 shell 创建               | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json`                                                              | 返回 `terminalSessionId` 和 `terminalUrl`                    |
| RW-CREATE-002 | 指定 runtime pty              | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --runtime pty --json`                                                | 创建成功；后续 `show` 可读                                   |
| RW-CREATE-003 | 指定 command                  | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command bash --json`                                               | 创建成功；后端 session `command` 为 `bash`                   |
| RW-CREATE-004 | 多个 `--arg`                  | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command bash --arg -lc --arg "echo RW_COMMAND_OK; sleep 5" --json` | 多个 arg 不被覆盖；创建后轮询 history 能读到 `RW_COMMAND_OK` |
| RW-CREATE-005 | value 以 `--` 开头的 arg      | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command codex --arg "--model" --arg "gpt-5" --json`                | `--model` 不被通用 parser 当成 option；请求能发出            |
| RW-CREATE-006 | `--arg=value` 形式            | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command bash --arg=-l --json`                                      | arg 被序列化为 `["-l"]`                                      |
| RW-CREATE-007 | `--arg` 缺值                  | `$RW_BIN terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command bash --arg`                                                | exit code `2`；stderr 包含 `Missing value for --arg`         |
| RW-CREATE-008 | 继承已有终端上下文            | `$RW_BIN terminal create --inherit-from "$TERMINAL_ID" --json`                                                                        | 创建成功；未提供 project/cwd 时由后端 defaults 处理          |
| RW-CREATE-009 | inherit + 显式 cwd 优先       | `$RW_BIN terminal create --inherit-from "$TERMINAL_ID" --cwd "$PWD" --json`                                                           | 创建成功；使用显式 cwd                                       |
| RW-CREATE-010 | 缺少 project/cwd 且无 inherit | `$RW_BIN terminal create --json`                                                                                                      | exit code `2`；stderr 提示缺少 `--project-id` 或 `--cwd`     |
| RW-CREATE-011 | 不存在 project id             | `$RW_BIN terminal create --project-id missing --cwd "$PWD" --json`                                                                    | 非 0 exit code；stderr 保留后端错误                          |

`terminal create` 返回只代表 backend 已创建 session，并不保证 command 输出已经进入
scrollback。验证 command session 输出时应轮询 `history --json` 的 `tail` 字段，例如：

```bash
COMMAND_TERMINAL_ID="$(
  $RW_BIN terminal create \
    --project-id "$PROJECT_ID" \
    --cwd "$PWD" \
    --command bash --arg -lc --arg "echo RW_COMMAND_OK; sleep 5" \
    --json | jq -r '.terminalSessionId'
)"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if $RW_BIN terminal history "$COMMAND_TERMINAL_ID" --tail 80 --json \
    | jq -e '(.tail | contains("RW_COMMAND_OK"))' >/dev/null; then
    break
  fi
  sleep 0.5
done

$RW_BIN terminal show "$COMMAND_TERMINAL_ID" --json \
  | jq -e '.command == "bash" and .args == ["-lc", "echo RW_COMMAND_OK; sleep 5"]'
```

## Terminal 输入投递测试

| ID          | 场景                   | 步骤                                                                                                        | 预期                                                            |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| RW-SEND-001 | 默认 raw 不提交        | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --json`                                                  | `submitted=false`；请求成功仅代表输入已接受                     |
| RW-SEND-002 | raw + enter 兼容旧行为 | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --enter --json`                                          | 请求 data 等价 `pwd\r`；`submitted=true`                        |
| RW-SEND-003 | line mode              | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --mode line --json`                                      | 不要求 `--enter`；`submitted=true`；不发送 `pwd\r` 双回车       |
| RW-SEND-004 | line + enter 不双回车  | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --mode line --enter --json`                              | 后端只收到 line mode；不重复提交回车                            |
| RW-SEND-005 | stdin raw              | `printf 'echo stdin-ok\\n' \| $RW_BIN terminal send "$TERMINAL_ID" --stdin --mode raw --json`               | stdin 被发送；超过 256 KiB 时应被拒绝                           |
| RW-SEND-006 | stdin line             | `printf 'pwd' \| $RW_BIN terminal send "$TERMINAL_ID" --stdin --mode line --json`                           | line mode 提交一行；不额外追加 raw 回车                         |
| RW-SEND-007 | codex slash command    | `$RW_BIN terminal send "$CODEX_TERMINAL_ID" --text "/compact" --mode codex_slash_command --json`            | CLI 不自动追加换行；由后端 slash command 逻辑处理               |
| RW-SEND-008 | 非法 slash command     | `$RW_BIN terminal send "$TERMINAL_ID" --text "compact" --mode codex_slash_command --json`                   | 非 0 exit code；stderr 保留 `Invalid Codex slash command input` |
| RW-SEND-009 | 非法 mode              | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --mode bad --json`                                       | exit code `2`；stderr 包含合法 mode 列表                        |
| RW-SEND-010 | confirm short          | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --enter --confirm short --confirm-timeout-ms 100 --json` | 输出含 `tailBefore/tailAfter/confirmConfidence`                 |
| RW-SEND-011 | confirm 非法值         | `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --confirm long --json`                                   | exit code `2`；stderr 提示 `--confirm` 合法值                   |
| RW-SEND-012 | 已删除终端发送         | 删除终端后发送 `$RW_BIN terminal send "$TERMINAL_ID" --text "pwd" --json`                                   | exit code `4`；stderr terminal not found                        |
| RW-SEND-013 | exited 终端发送        | 对 exited session 发送输入                                                                                  | 非 0 exit code；stderr 包含 session not running                 |

## 上下文读取测试

| ID         | 场景                  | 步骤                                                         | 预期                                                               |
| ---------- | --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| RW-CTX-001 | snapshot plain        | `$RW_BIN terminal snapshot "$TERMINAL_ID" --tail 20 --plain` | 输出 tail 文本                                                     |
| RW-CTX-002 | snapshot json         | `$RW_BIN terminal snapshot "$TERMINAL_ID" --tail 20 --json`  | 输出 session payload 加 `tail` 字段                                |
| RW-CTX-003 | history plain         | `$RW_BIN terminal history "$TERMINAL_ID" --tail 20 --plain`  | 请求 `/history`；输出 history tail 文本                            |
| RW-CTX-004 | history json          | `$RW_BIN terminal history "$TERMINAL_ID" --tail 20 --json`   | 输出 history payload 加 `tail` 字段                                |
| RW-CTX-005 | tail 为 0             | `$RW_BIN terminal history "$TERMINAL_ID" --tail 0 --plain`   | 输出空文本或仅换行；不报错                                         |
| RW-CTX-006 | tail 非整数           | `$RW_BIN terminal snapshot "$TERMINAL_ID" --tail abc --json` | exit code `2`；stderr 包含 `--tail must be a non-negative integer` |
| RW-CTX-007 | state                 | `$RW_BIN terminal state "$TERMINAL_ID" --json`               | 输出 `{ terminalSessionId, terminalState }`                        |
| RW-CTX-008 | handoff               | `$RW_BIN terminal handoff "$TERMINAL_ID" --tail 120 --json`  | 输出 project/session/runtime/state/tail/suggestedCommands          |
| RW-CTX-009 | app overview 状态一致 | `$RW_BIN app overview --json` 后比对 `terminal state`        | overview 中对应 session 的 terminal state 与 state API 一致        |

## Terminal 删除测试

| ID         | 场景               | 步骤                                              | 预期                                                   |
| ---------- | ------------------ | ------------------------------------------------- | ------------------------------------------------------ |
| RW-DEL-001 | 删除明确 id        | `$RW_BIN terminal delete "$TERMINAL_ID" --json`   | 输出 `{ "terminalSessionId": "...", "deleted": true }` |
| RW-DEL-002 | 删除后 list 不存在 | `$RW_BIN terminal list --json`                    | 找不到该 terminal id                                   |
| RW-DEL-003 | 删除后 show 404    | `$RW_BIN terminal show "$TERMINAL_ID" --json`     | exit code `4`                                          |
| RW-DEL-004 | 删除 missing       | `$RW_BIN terminal delete missing-terminal --json` | exit code `4`；不伪装成功                              |
| RW-DEL-005 | 缺少 terminal id   | `$RW_BIN terminal delete --json`                  | exit code `2`；stderr `Missing terminal session id`    |

## WebSocket UI 同步测试

本组验证外部 agent 通过 CLI/HTTP 创建项目和终端时，Web/App 是否像用户手动创建一样响应。涉及浏览器操作时必须使用 `$playwright-cli`。

| ID        | 场景                          | 步骤                                                                                                                    | 预期                                                                 |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| RW-WS-001 | 后端发布 project 创建事件     | 调用 `POST /api/terminal/project` 或 `$RW_BIN project ensure ...`                                                       | backend route 测试中 `terminalEventService` 记录 `project_created`   |
| RW-WS-002 | 后端发布 terminal 创建事件    | 调用 `POST /api/terminal/session` 或 `$RW_BIN terminal create ...`                                                      | backend route 测试中记录 `terminal_session_created`                  |
| RW-WS-003 | 后端发布 terminal 删除事件    | 调用 `DELETE /api/terminal/session/:id` 或 `$RW_BIN terminal delete ...`                                                | backend route 测试中记录 `terminal_session_deleted`                  |
| RW-WS-004 | 后端发布 project 删除事件     | 调用 `DELETE /api/terminal/project/:id`                                                                                 | backend route 测试中记录 `project_deleted`，含级联 session ids       |
| RW-WS-005 | Web 实时刷新新增 project/tab  | 运行 `pnpm --filter @runweave/frontend exec playwright test tests/terminal.spec.ts --grep "adds externally created"`    | 页面无需刷新，刷新权威列表后出现外部创建的 project 和 terminal tab   |
| RW-WS-006 | Web 实时刷新删除 terminal tab | 运行 `pnpm --filter @runweave/frontend exec playwright test tests/terminal.spec.ts --grep "removes externally deleted"` | 外部删除 terminal 后 tab 从页面消失                                  |
| RW-WS-007 | Catchup 不重复                | Web 断开 terminal-events WS 后创建/删除 project/session，再重连                                                         | catchup 触发权威列表刷新，不出现重复或幽灵 project/tab               |
| RW-WS-008 | Live 不抢当前 active terminal | Web 当前正在另一个终端；外部创建新 terminal                                                                             | 新 tab 出现，但当前 URL/active terminal 不被强制切换                 |
| RW-WS-009 | 空状态自动选中新 session      | Web 初始没有 active project/session；外部创建 project/session                                                           | 刷新权威列表后 UI 有可见 project/tab，并进入可用终端                 |
| RW-WS-010 | App Home 实时刷新             | App 已登录并连接 terminal-events；外部创建或删除 project/session                                                        | 首页 overview 通过 `/api/app/home/overview` 刷新收敛；不需要下拉刷新 |
| RW-WS-011 | State 事件仍正常合并          | 创建终端后触发 `terminal_state_changed`                                                                                 | 状态 badge 更新；结构变化仍由列表刷新负责                            |

## Profile 与配置优先级测试

| ID            | 场景                   | 步骤                                                          | 预期                                                |
| ------------- | ---------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| RW-CONFIG-001 | 临时配置隔离           | 设置 `RUNWEAVE_CONFIG_FILE="$(mktemp -d)/config.json"` 后登录 | 登录信息只写入临时文件                              |
| RW-CONFIG-002 | profile 参数           | `$RW_BIN health --profile local --json`                       | 输出 `profile="local"`                              |
| RW-CONFIG-003 | env token 覆盖 profile | profile token A，`RUNWEAVE_ACCESS_TOKEN` 设置 token B         | 请求使用 token B                                    |
| RW-CONFIG-004 | auth status 已登录     | `$RW_BIN auth status --json`                                  | `authenticated=true`；输出 `baseUrl/profile/source` |
| RW-CONFIG-005 | auth status 未登录     | 清空配置后 `$RW_BIN auth status --json`                       | exit code `0`；输出 `authenticated=false`           |

## JSON 输出契约检查

建议对关键命令执行 `jq -e` 校验，避免输出变成不可解析文本。

```bash
$RW_BIN health --json | jq -e '.reachable | type == "boolean"'
$RW_BIN app overview --json | jq -e 'has("projects") and has("sessions")'
$RW_BIN project list --json | jq -e 'type == "array"'
$RW_BIN terminal list --json | jq -e 'type == "array"'
$RW_BIN terminal state "$TERMINAL_ID" --json | jq -e '.terminalSessionId and .terminalState.state'
$RW_BIN terminal history "$TERMINAL_ID" --tail 5 --json | jq -e 'has("tail")'
```

Plain 输出只用于人工读取，例如：

```bash
$RW_BIN terminal history "$TERMINAL_ID" --tail 20 --plain
$RW_BIN terminal snapshot "$TERMINAL_ID" --tail 20 --plain
```

## 推荐端到端冒烟脚本

以下脚本用于快速验证 agent 投递闭环。它不判断命令执行完成，只验证创建、投递和读取链路。

```bash
set -euo pipefail

export RUNWEAVE_CONFIG_FILE="${RUNWEAVE_CONFIG_FILE:-$(mktemp -d)/runweave-config.json}"
export RUNWEAVE_BACKEND_PORT="${RUNWEAVE_BACKEND_PORT:-5001}"
export RUNWEAVE_BASE_URL="${RUNWEAVE_BASE_URL:-http://127.0.0.1:${RUNWEAVE_BACKEND_PORT}}"
export RW_BIN="${RW_BIN:-node packages/runweave-cli/dist/index.js}"

$RW_BIN health --json | jq -e '.reachable == true'

PROJECT_ID=$(
  $RW_BIN project ensure --name rw-smoke --path "$PWD" --json \
    | jq -r '.projectId'
)

TERMINAL_ID=$(
  $RW_BIN terminal create \
    --project-id "$PROJECT_ID" \
    --cwd "$PWD" \
    --runtime pty \
    --json \
    | jq -r '.terminalSessionId'
)

$RW_BIN terminal send "$TERMINAL_ID" \
  --text "printf 'rw-smoke-ok\n'" \
  --mode line \
  --json \
  | jq -e '.inputAccepted == true and .inputEnqueued == true'

sleep 1

$RW_BIN terminal history "$TERMINAL_ID" --tail 50 --plain | tee /tmp/rw-smoke-history.txt
grep -q "rw-smoke-ok" /tmp/rw-smoke-history.txt

$RW_BIN terminal state "$TERMINAL_ID" --json | jq -e '.terminalSessionId == "'$TERMINAL_ID'"'
$RW_BIN terminal delete "$TERMINAL_ID" --json | jq -e '.deleted == true'
```

## 验收失败判定

任意一项出现都视为失败：

- `rw health` 在未登录时抛 profile 未登录错误，而不是检查 `/health`。
- `/health` 401/403 被误报为用户 access token 失效，而不是 `blockedByTunnelAuth=true`。
- `rw terminal create --arg "--model"` 被 parser 当成 option，导致参数丢失或 usage error。
- `rw terminal send --mode line --enter` 导致双回车或重复提交。
- `send` 成功文案或 JSON 暗示命令已经执行完成。
- `codex_slash_command` 的后端错误被 CLI 吞掉或改成成功。
- `terminal history` 没有请求 `/api/terminal/session/:id/history`。
- `terminal state` 缺少 `terminalSessionId` 或 `terminalState`。
- `terminal delete` 对 missing terminal 返回成功。
- CLI 输出 JSON 不可被 `jq` 解析。
- 外部 CLI/HTTP 创建 project/session 后，Web/App 已连接 terminal-events 但界面不新增 project/card/tab。
- 外部 CLI/HTTP 删除 terminal/project 后，Web/App 已连接 terminal-events 但界面仍保留幽灵 tab/card。
- terminal-events catchup/live 重放导致重复 project/tab，或删除后重新出现已不存在的 project/tab。
- 外部创建新 terminal 时强行抢走用户当前正在操作的 active terminal。

## 清理

```bash
if [ -n "${TERMINAL_ID:-}" ]; then
  $RW_BIN terminal delete "$TERMINAL_ID" --json || true
fi

rm -f /tmp/rw-smoke-history.txt

if [ -n "${RUNWEAVE_CONFIG_FILE:-}" ]; then
  rm -rf "$(dirname "$RUNWEAVE_CONFIG_FILE")"
fi
```
