# TerminalState 测试案例

本文档用于审阅和补齐当前终端状态测试。目标不是描述已经完全正确的实现，而是把当前代码事实、目标契约和应补测试先编译成一份真实场景验收清单，后续再按这些案例修正代码。

系统验收用例必须来自真实用户或真实进程路径：页面操作、真实 terminal session、真实 shell hook、真实 tmux metadata、真实 agent hook 和真实 API 流量。不要把手动改 lowdb、手动改内存 store、手动改 tmux pane option 后得到的构造态作为系统用例的通过/失败依据；这类构造态只能用于代码审查、故障定位或服务层防御性不变量说明。

本文档不要求新增单测、Vitest、Node test 或 Playwright E2E spec。涉及浏览器页面、真实终端和 lifecycle 状态的验证，必须通过 Dev Session + `$toolkit:playwright-cli` 操作真实页面和真实 API 流量完成。

## 适用范围

- Codex CLI 终端状态四态：`shell_idle`、`agent_starting`、`agent_idle`、`agent_running`。
- 后端状态服务：`backend/src/terminal/terminal-state-service.ts`。
- 后端状态 API：`GET /api/terminal/session/:terminalSessionId/state`。
- Agent launch operation：`backend/src/terminal/application/agent-preparation.ts`。
- 内部 hook API：`POST /internal/terminal/agent-hook`。
- metadata 接入：`backend/src/ws/terminal-server.ts` 在 `activeCommand` 变化后调用状态服务。
- App home overview：`GET /api/app/home/overview` 返回 `displayStatus/displayStatusLabel/terminalState`。
- App terminal detail：`app/src/pages/AppTerminalPage.tsx` 以 `terminalState.state === "agent_running"` 决定 Stop。
- CLI handoff/interrupt：`packages/runweave-cli/src/commands/terminal.ts` 以 `/state` 返回值输出 handoff 状态，`interrupt` 只发送 ESC，不直接改状态。
- CLI agent start：`packages/runweave-cli/src/commands/terminal-agent.ts` 以 backend 返回的 launch operation/status 为准，不解析 TUI 文案。

## 当前代码事实

- `TerminalState` 协议允许：
  - `shell_idle` + `agent=null`
  - `agent_starting` + `agent="codex" | "trae" | "traecli" | "traex"`
  - `agent_idle` + `agent="codex" | "trae" | "traecli" | "traex"`
  - `agent_running` + `agent="codex" | "trae" | "traecli" | "traex"`
- `TerminalStateService.handleAgentHook()` 当前映射：
  - `SessionStart` -> `agent_idle`
  - `UserPromptSubmit` -> `agent_running`
  - `Stop` -> `agent_idle`
- `session.status === "exited"` 在 `getCurrent()` 和 `setShellActiveCommand()` 中优先返回 `shell_idle`。
- `setShellActiveCommand()` 看到 agent 前台命令时先进入 `agent_starting`，除非已有同 agent 的 `agent_idle/agent_running/agent_starting` 存储态。
- `/state` 不读取 live scrollback；它只聚合 panel/session 中已经持久化的权威状态。
- `/state` 不应读取 live tail 推断 `agent_running`。如果当前代码存在 `Working (... esc to interrupt ...)` 这类输出 heuristic，应视为需要删除的实现缺陷，而不是测试契约。
- `agent_starting` 表示带 `operationId` 的 launch command 已提交但尚未收到可信 lifecycle；`SessionStart`、`UserPromptSubmit`、`Stop` 等匹配身份的 hook/App Server 事件推进 idle/running。任何 TUI 文本都不是状态来源。
- `AppHomeOverviewSession` 当前已经携带完整 `terminalState`。
- CLI `handoff` 当前仍保留旧的 `inferHandoffWorkloadState()`，但输出的 `terminalState/agent/inferredState/inferredWorkloadState/stateConfidence` 已以后端 `/state` 为强状态来源。

## 已知需要用测试固定的问题

### K1 原始启动命令不应永久代表当前仍在 Codex

目标契约来自 `docs/architecture/terminal-state.md`：`activeCommand=codex` 表示进入 Codex CLI；`activeCommand=null` 或非 Codex 要把状态推进到 `shell_idle`。

系统验收不要求强行制造 `command="codex" + activeCommand=node/null`。真实场景应验证：用户曾进入 Codex 并产生 Codex 状态后，真实 shell hook/tmux metadata 报告 `activeCommand=null` 或普通命令时，状态回到 `shell_idle/null`。代码审查层面再确认状态判断只依赖当前 `activeCommand`，不依赖 session 原始 `command`。

### K2 hook 接收条件不应被 stale `command="codex"` 放宽

非 `SessionStart` hook 只有在当前 Codex 前台、grace window、或服务端已有 Codex 状态时才应被接收。真实验收应使用 Codex 前台、Codex 刚退出的 grace window、普通 shell/node 三类路径验证；不要通过手改 session 原始 `command` 制造 hook gate 前置条件。

### K3 Stop/Interrupt 不是状态来源

HTTP interrupt 返回 `interruptSequence="escape"`，只表示向终端输入 ESC。Stop 是否消失只能依赖后续 `hookEvent="Stop"` 或 `activeCommand` 变化，不能由点击 Stop 或 interrupt API 本地乐观改状态。

当前 P0 临时兼容：由于 Codex CLI 用户中断暂时不会稳定触发 `Stop` hook，HTTP interrupt 对当前 Codex running session 会手动写入 `agent_idle/codex`。这不是长期目标契约，后续 Codex Stop hook 修复后应回收该兼容逻辑，并恢复 interrupt 不写状态的回归测试。

### K4 live tail 不是 running 状态来源

Codex TUI 输出里的 `Working (... esc to interrupt ...)` 只能作为用户可见文本，不能作为 running 状态源。`agent_running` 只能由 Codex hook 的 `UserPromptSubmit` 写入；如果 hook 丢失，状态应保守停留在 `agent_idle` 或由 `activeCommand` 变化回到 `shell_idle`，不从 scrollback/tail 猜测 running。

scrollback 只用于终端显示、诊断或用户取证，不能推进 `agent_starting`、`agent_idle` 或 `agent_running`。

## 测试分层

| 层级                        | 文件/入口                                                                                       | 目标                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| backend static              | `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint`                             | 状态服务、routes、WebSocket 相关代码无 TS 或 lint 错误                                                            |
| CLI static/manual           | `pnpm --filter ./packages/runweave-cli typecheck && pnpm --filter ./packages/runweave-cli lint` | 验证 handoff 输出以后端 TerminalState 为准，interrupt 不写状态                                                    |
| Electron static/manual      | `pnpm --filter ./electron typecheck && pnpm --filter ./electron lint`                           | 验证 Codex hooks 上报到 `/internal/terminal/agent-hook`，body 携带 terminal id 和 token                           |
| Browser real-traffic        | 普通 `pnpm dev` 或指定普通 dev 端口 + `$toolkit:playwright-cli`                                 | 真实登录、真实页面、真实 terminal session、真实 `/api/terminal/session/:id/state`；不跑 E2E spec                  |
| App manual / App Playwright | App dev/simulator + `$toolkit:playwright-cli` 或手工验收                                        | 覆盖 `app/src/pages/AppTerminalPage.tsx` 的 Stop、composer、terminal-events 状态刷新；不要误归到 `frontend/tests` |

## 后端状态服务测试

本节用于代码审查和服务层不变量确认，不作为真实浏览器/API 系统验收入口。系统验收入口以 `TS-API-*`、`TS-WS-*`、`TS-HOME-*`、`TS-CLI-*` 和 `TS-UI-*` 的真实路径为准。

| ID         | 初始条件                                                                                              | 操作                                                                   | 预期                                                   | 当前实现     |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| TS-SVC-001 | 无 store；session running，`command="zsh"`，`activeCommand=null`                                      | `getCurrent()`                                                         | `shell_idle/null`                                      | 应通过       |
| TS-SVC-002 | 无 store；session running，`command="zsh"`，`activeCommand="codex"`                                | `getCurrent()`                                                         | `agent_starting/codex`                                 | 应通过       |
| TS-SVC-003 | 无 store；session running，`activeCommand="/usr/local/bin/codex"`                                   | `getCurrent()`                                                         | `agent_starting/codex`                                 | 应通过       |
| TS-SVC-004 | 无 store；session running，`activeCommand="node"`                                                     | `getCurrent()`                                                         | `shell_idle/null`                                      | 应通过       |
| TS-SVC-005 | store 为 `agent_running`；session exited，`activeCommand="codex"`                                     | `getCurrent()`                                                         | `shell_idle/null`                                      | 应通过       |
| TS-SVC-006 | session running，`activeCommand="codex"`，无同 agent store                                            | `setShellActiveCommand()`                                              | `agent_starting/codex`                                 | 应通过       |
| TS-SVC-007 | store 为 `agent_running`；session running，`command="zsh"`，`activeCommand=null`                      | `setShellActiveCommand()`                                              | `shell_idle/null`                                      | 应通过       |
| TS-SVC-008 | store 为 `agent_running`；session running，`command="zsh"`，`activeCommand="node"`                    | `setShellActiveCommand()`                                              | `shell_idle/null`                                      | 应通过       |
| TS-SVC-009 | 代码审查：`getTerminalSessionAgent()` / `isCodexSession()`                                            | 搜索并审查状态判断是否只读取当前 `activeCommand`，不读取原始 `command` | stale launch command 不会复活 Codex 状态               | 静态不变量   |
| TS-SVC-012 | 无 store；session running，`activeCommand="Codex"`                                                    | `getCurrent()`                                                         | 明确预期：若只支持精确 `codex`，应为 `shell_idle/null` | 需确认并固定 |
| TS-SVC-013 | 任意 store；`agent="codex"`，`hookEvent="SessionStart"`                                               | `handleAgentHook()`                                                    | `agent_idle/codex`                                     | 应通过       |
| TS-SVC-014 | 任意 store；`agent="codex"`，`hookEvent="UserPromptSubmit"`                                           | `handleAgentHook()`                                                    | `agent_running/codex`                                  | 应通过       |
| TS-SVC-015 | store 为 `agent_running`；`agent="codex"`，`hookEvent="Stop"`                                         | `handleAgentHook()`                                                    | `agent_idle/codex`                                     | 应通过       |
| TS-SVC-016 | 任意 store/session                                                                                    | 代码搜索 `reconcileCurrentFromOutput` / Codex Working 输出正则         | 不应存在运行时代码命中；tail heuristic 不属于状态服务  | 已按目标清理 |
| TS-SVC-017 | 当前为 `agent_starting`；scrollback 含任意 Codex/TraeX ready 文案                                     | `getCurrent()`                                                         | 保持 `agent_starting`，不写 store、不发布状态事件       | 目标契约     |
| TS-SVC-018 | 当前为 `agent_starting`；live scrollback 仅含 Codex Working 文案                                      | `getCurrent()`                                                         | 保持 `agent_starting/codex`，不因输出文本进入 running  | 目标契约     |
| TS-SVC-019 | 当前为 `agent_idle`；scrollback/tail 含 Codex Working 文案                                            | `getCurrent()`                                                         | 保持 `agent_idle/codex`，不因输出文本进入 running      | 目标契约     |
| TS-SVC-020 | 当前为 `shell_idle`；scrollback/tail 含 Codex Working 文案                                            | `getCurrent()`                                                         | 保持 `shell_idle/null`                                 | 目标契约     |

## 后端状态 API 测试

| ID         | 初始条件                                                                                           | 请求                                        | 预期                                                                |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| TS-API-001 | session 不存在                                                                                     | `GET /api/terminal/session/not-found/state` | 404                                                                 |
| TS-API-002 | session running，`activeCommand="codex"`，无 store                                               | `GET /state`                                | 200，`agent_starting/codex`                                         |
| TS-API-003 | 真实 Codex session 曾进入 `agent_running`，随后进程退出或 terminal status 变为 exited              | `GET /state`                                | 200，`shell_idle/null`；不得因旧 store 保留 Agent Running           |
| TS-API-004 | session running，store 为 `agent_starting`，live scrollback 命中任意 ready prompt                  | `GET /state`                                | 200，保持 `agent_starting/codex`；不得读取或匹配 TUI 文案            |
| TS-API-005 | session running，store 为 `agent_idle`，live tail 命中 Codex Working                               | `GET /state`                                | 200，保持 `agent_idle/codex`；不得推进到 running                    |
| TS-API-006 | session running，store 为 `agent_idle`，live tail 不命中                                           | `GET /state`                                | 200，保持 `agent_idle/codex`                                        |
| TS-API-010 | session running，store 为 `shell_idle`，live tail 命中 Working                                     | `GET /state`                                | 200，保持 `shell_idle/null`                                         |
| TS-API-007 | 真实 shell session 中进入 Codex 后退出到 shell，shell hook/tmux metadata 报告 `activeCommand=null` | `GET /state`                                | 200，`shell_idle/null`；不继续展示 Agent Idle/Running               |
| TS-API-008 | 真实 shell session 中进入 Codex 后回到 shell，再执行普通 `node -e "setTimeout(()=>{}, 5000)"`      | `GET /state`                                | 200，`shell_idle/null`；普通 node 不应被旧 Codex 状态污染           |

已下线旧构造态：`command="codex" + activeCommand=null/node` 不再作为 `TS-API-*` 系统验收 case；它只能通过手工改数据稳定制造，由 TS-SVC-009 静态不变量和 TS-API-007/008 真实路径覆盖。

## 内部 agent hook API 测试

| ID          | 初始条件                                                                                | 请求                                 | 预期                                                      |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| TS-HOOK-001 | hook token 缺失                                                                         | `POST /internal/terminal/agent-hook` | 401，不写状态                                             |
| TS-HOOK-002 | hook token 错误                                                                         | `POST /internal/terminal/agent-hook` | 401，不写状态                                             |
| TS-HOOK-003 | body 缺 `terminalSessionId`                                                             | `POST`                               | 400，不写状态                                             |
| TS-HOOK-004 | `agent!="codex"`                                                                        | `POST`                               | 400；第一阶段 schema 只接受 Codex                         |
| TS-HOOK-005 | `hookEvent` 非枚举                                                                      | `POST`                               | 400                                                       |
| TS-HOOK-006 | session 不存在                                                                          | 合法 token + body                    | 404                                                       |
| TS-HOOK-007 | session exited                                                                          | 合法 `UserPromptSubmit`              | 202，返回 `shell_idle/null`，不写 running                 |
| TS-HOOK-008 | running session，`activeCommand="codex"`                                                | `SessionStart`                       | 202，`agent_idle/codex`                                   |
| TS-HOOK-009 | running session，`activeCommand="codex"`                                                | `UserPromptSubmit`                   | 202，`agent_running/codex`                                |
| TS-HOOK-010 | running session，`activeCommand="codex"`，已有 running                                  | `Stop`                               | 202，`agent_idle/codex`                                   |
| TS-HOOK-011 | running session，`activeCommand="node"`，store 为空                                     | `UserPromptSubmit`                   | 202，保持 `shell_idle/null`，记录 ignored                 |
| TS-HOOK-012 | running session，`activeCommand=null`，`lastAiActiveCommand=codex` 且在 grace window 内 | `Stop`                               | 202，接收并写 `agent_idle/codex`                          |
| TS-HOOK-013 | running session，`activeCommand=null`，`lastAiActiveCommand=codex` 但超过 grace window  | `Stop`                               | 202，保持当前非 Codex 状态                                |
| TS-HOOK-014 | 真实普通 shell/node 前台，非 grace window，且服务端当前不是 Codex 状态                  | `UserPromptSubmit`                   | 202，忽略并保持 `shell_idle/null`                         |
| TS-HOOK-015 | 真实 shell idle，非 grace window，且服务端当前不是 Codex 状态                           | `Stop`                               | 202，忽略并保持 `shell_idle/null`                         |
| TS-HOOK-016 | running session，store 已为 `agent_running`，但 `activeCommand` 短暂为空                | `Stop`                               | 202，允许落到 `agent_idle/codex`，避免 Stop hook 晚到丢失 |

## metadata / WebSocket 集成测试

| ID        | 初始条件                                                                      | 操作                                    | 预期                                                                               |
| --------- | ----------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| TS-WS-001 | session `activeCommand=null`                                                  | metadata 更新为 `activeCommand="codex"` | 调用 `setShellActiveCommand()`，状态为 `agent_starting/codex`，发送 metadata event |
| TS-WS-002 | store 为 `agent_running`                                                      | metadata 更新为 `activeCommand=null`    | 状态为 `shell_idle/null`                                                           |
| TS-WS-003 | 真实 Codex 状态之后，shell hook/tmux metadata 报告普通 `activeCommand="node"` | publish metadata                        | 状态为 `shell_idle/null`；`activeCommand` 保持真实 node，不被旧 Codex 覆盖         |
| TS-WS-004 | metadata cwd 变化但 `activeCommand` 未变                                      | publish metadata                        | 只因 cwd 变化发送 metadata；状态不应被错误推进                                     |
| TS-WS-005 | metadata 完全未变化且非 force                                                 | publish metadata                        | 不发送 metadata，不调用状态服务                                                    |
| TS-WS-006 | force send 但 metadata 未变化                                                 | publish metadata                        | 发送 metadata；不应重复写状态                                                      |
| TS-WS-007 | tmux metadata reader 返回 `activeCommand="/path/to/codex"`                    | sync metadata                           | 状态为 `agent_starting/codex`，后续只由可信 lifecycle 推进                         |
| TS-WS-008 | tmux metadata reader 返回 `activeCommand="claude"`                            | sync metadata                           | 第一阶段为 `shell_idle/null`                                                       |

## App home overview 测试

| ID          | 初始条件                                                                        | 请求                         | 预期                                                                                                              |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TS-HOME-001 | running session，store `agent_running`                                          | `GET /api/app/home/overview` | session `displayStatus="running"`，`displayStatusLabel="Agent Running"`，携带 `terminalState=agent_running/codex` |
| TS-HOME-002 | running session，`activeCommand="codex"`，尚无可信 lifecycle                    | `GET /home/overview`         | `displayStatus="agent-starting"`，`terminalState=agent_starting/codex`                                            |
| TS-HOME-008 | running session，store 为 `agent_starting`，scrollback 有 Codex ready prompt       | `GET /home/overview`         | 仍为 `displayStatus="agent-starting"`；TUI 文案不能推进状态                                                       |
| TS-HOME-003 | running shell session                                                           | `GET /home/overview`         | `displayStatus="idle"`，`terminalState=shell_idle/null`                                                           |
| TS-HOME-004 | exited session，残留 `activeCommand="codex"`                                    | `GET /home/overview`         | `displayStatus="exited"`，`terminalState=shell_idle/null`                                                         |
| TS-HOME-005 | 多 session 混排                                                                 | `GET /home/overview`         | 按 `lastActivityAt` 降序；同时间保持原顺序                                                                        |
| TS-HOME-006 | 真实 shell session 中进入 Codex 后回到 shell，再执行普通 node 命令              | `GET /home/overview`         | 展示普通 shell/命令状态，不展示 Agent Idle/Running                                                                |
| TS-HOME-007 | response payload                                                                | `GET /home/overview`         | 不读取或返回 tail；不触发 live scrollback 读取                                                                    |

## CLI 测试

| ID         | 初始条件                                                                                                                | 命令                                                            | 预期                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| TS-CLI-001 | `/state` 返回 `shell_idle/null`，session `activeCommand="sleep"`                                                        | `rw terminal handoff <id> --json`                               | `terminalState="shell_idle"`，`agent=null`，`inferredWorkloadState="shell_idle"`，`stateConfidence="strong"` |
| TS-CLI-002 | `/state` 返回 `agent_idle/codex`，tail 看起来像 busy                                                                    | `handoff --json`                                                | 仍输出 `agent_idle`，不被 tail heuristic 改成 running                                                        |
| TS-CLI-003 | `/state` 返回 `agent_running/codex`，session `activeCommand="codex"`                                                    | `handoff --json`                                                | 输出 `agent_running`、`agent="codex"`，`stateReasons` 包含 `terminalState=agent_running`                     |
| TS-CLI-004 | session exited，旧 tail 含 Codex prompt                                                                                 | `handoff --json`                                                | `terminalState="shell_idle"`，不显示 agent running                                                           |
| TS-CLI-005 | 真实 shell session 中进入 Codex 后回到 shell，再执行普通 node 命令，`/state` 返回 `shell_idle`                          | `handoff --json`                                                | 输出 shell idle，避免旧 Codex 状态影响 handoff                                                               |
| TS-CLI-006 | interrupt success                                                                                                       | `rw terminal interrupt <id> --json`                             | 输出 HTTP interrupt response + `transport="http"`；不包含状态变更字段                                        |
| TS-CLI-007 | interrupt 之后立即 handoff，后端仍 `agent_running`                                                                      | `interrupt` 后 `handoff`                                        | handoff 仍为 `agent_running`，直到 hook Stop 或 activeCommand 变化                                           |
| TS-CLI-008 | `rw terminal send --agent codex` 启动 Codex 后，backend 返回 `phase="command_submitted"` 与 `operationId`            | `rw terminal send <id> --agent codex --text ... --enter --json` | CLI 以 launch operation 响应确认提交，不解析 Codex TUI 文案                                                   |

## App terminal detail / UI 验收

涉及打开页面、点击、截图或浏览器自动化时，必须使用 `$toolkit:playwright-cli`，不要使用其它浏览器操作方案。

| ID        | 初始条件                                            | 操作                                                                                                                                                                                                                                                                                | 预期                                                                                                         |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| TS-UI-001 | App overview 初始状态为 `shell_idle`                | 打开 App terminal detail                                                                                                                                                                                                                                                            | 不显示 Stop                                                                                                  |
| TS-UI-002 | App overview 初始状态为 `agent_starting`            | 打开 App terminal detail                                                                                                                                                                                                                                                            | 不显示 Stop；列表/详情显示 Agent Starting                                                                    |
| TS-UI-011 | App overview 初始状态为 `agent_idle`                | 打开 App terminal detail                                                                                                                                                                                                                                                            | 不显示 Stop；标题可显示当前 command 或 session title                                                         |
| TS-UI-003 | Codex prompt 提交后，hook 写 `agent_running`        | 等待 `/ws/terminal-events` 推送 `terminal_state_changed`                                                                                                                                                                                                                            | 显示 Stop                                                                                                    |
| TS-UI-004 | 点击 Stop，interrupt 成功但状态仍为 `agent_running` | 点击 Stop 后立即观察                                                                                                                                                                                                                                                                | Stop 不因本地乐观状态消失                                                                                    |
| TS-UI-005 | hook `Stop` 到达，推送 `agent_idle`                 | 等待 `/ws/terminal-events` 状态刷新                                                                                                                                                                                                                                                 | Stop 消失，composer 仍可输入                                                                                 |
| TS-UI-006 | `activeCommand` 清空，推送 `shell_idle`             | 等待 `/ws/terminal-events` 状态刷新                                                                                                                                                                                                                                                 | Stop 消失                                                                                                    |
| TS-UI-007 | terminal session 404                                | 打开已删除 terminal detail                                                                                                                                                                                                                                                          | UI 显示终端不存在或已被删除；不清登录态                                                                      |
| TS-UI-008 | terminal-events 401                                 | 先打开一个 running terminal detail，再用页面内 `fetch("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer <当前 accessToken>" } })` 让后端注销当前 session；不要用 Playwright `route.fulfill({ status: 401 })` mock WebSocket，当前环境下可能无法复现真实 close | 下一次 terminal-events ticket 或 WebSocket 认证失败后调用 auth expired：清理 App 当前连接 session 并回到登录 |
| TS-UI-009 | terminal-events 普通网络错误                        | 断开后端网络或停止 backend                                                                                                                                                                                                                                                          | 保持当前可见状态，不清空输入；设备连接状态进入 Offline 路径                                                  |
| TS-UI-010 | sendTerminalInput 第一次失败                        | composer 提交命令                                                                                                                                                                                                                                                                   | 不应发送第二个 bare newline，不应清空用户输入；这是既有 review 指出的回归用例                                |

## Electron hook installer 测试

| ID          | 初始条件                                                              | 操作                            | 预期                                                                                      |
| ----------- | --------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| TS-ELEC-001 | Codex hook installer 生成配置                                         | 读取生成脚本/配置               | endpoint 指向 `/internal/terminal/agent-hook`                                             |
| TS-ELEC-002 | runtime env 有 `RUNWEAVE_TERMINAL_SESSION_ID`                         | hook bridge 收到 `SessionStart` | body 携带 `terminalSessionId`、`projectId`、`agent="codex"`、`hookEvent="SessionStart"`   |
| TS-ELEC-003 | hook bridge 收到 `UserPromptSubmit`                                   | 上报                            | body `hookEvent="UserPromptSubmit"`                                                       |
| TS-ELEC-004 | hook bridge 收到 `Stop`                                               | 上报                            | body `hookEvent="Stop"`                                                                   |
| TS-ELEC-005 | hook bridge 收到 `SubagentStop`                                       | 上报                            | body 映射为 `hookEvent="Stop"`                                                            |
| TS-ELEC-006 | 缺 `RUNWEAVE_HOOK_TOKEN`                                              | 执行 hook bridge                | 整体 return；不发 agent-hook，不发 completion，不触发桌面/飞书通知                        |
| TS-ELEC-007 | 缺 `RUNWEAVE_TERMINAL_SESSION_ID`                                     | 执行 hook bridge                | 整体 return；不发 agent-hook，不发 completion，不触发桌面/飞书通知                        |
| TS-ELEC-008 | 缺 `RUNWEAVE_HOOK_ENDPOINT`，但有 `RUNWEAVE_COMPLETION_HOOK_ENDPOINT` | 执行 hook bridge                | 不发 agent-hook；completion 是否发送按通知链路用例单独固定，不把它当 TerminalState 副作用 |
| TS-ELEC-009 | 缺 `RUNWEAVE_HOOK_ENDPOINT`，也无 `RUNWEAVE_COMPLETION_HOOK_ENDPOINT` | 执行 hook bridge                | 不发 agent-hook；不因缺 state endpoint 派生状态写入                                       |
| TS-ELEC-010 | 非 Codex source                                                       | 执行 hook bridge                | 第一阶段不写 TerminalState；completion 行为按通知链路独立验证                             |

## 非状态来源回归测试

| ID         | 初始条件                                                | 操作                                 | 预期                                                                                               |
| ---------- | ------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| TS-SRC-001 | store 为 `agent_running`                                | 调用 `/internal/terminal-completion` | 不改变 `TerminalState`                                                                             |
| TS-SRC-002 | store 为 `agent_running`                                | 旧 completion feed 产生 event        | 不改变 `TerminalState`                                                                             |
| TS-SRC-003 | store 为 `agent_running`，当前 session 为 Codex running | HTTP interrupt 成功                  | 当前 P0 兼容行为：写入 `agent_idle/codex`；后续 Codex Stop hook 修复后恢复为不改变 `TerminalState` |
| TS-SRC-004 | store 为 `agent_running`                                | WebSocket signal `SIGINT`            | 不改变 `TerminalState`                                                                             |
| TS-SRC-005 | store 为 `agent_idle`                                   | 普通 terminal input / resize         | 不改变 `TerminalState`                                                                             |

## 推荐落地顺序

1. 先用代码审查和静态检查确认 `TerminalStateService` 目标契约：agent 判断只来自当前 `activeCommand`，原始启动 `command` 不参与状态复活。
2. 再审查 route 级 hook gate，确保普通 shell/node 前台或 shell idle 的真实路径不会放宽 `UserPromptSubmit/Stop`。
3. 确认 `/state` 不读取 live scrollback，TUI ready/Working 文案不能推进任何 authoritative state。
4. 用真实浏览器流量验证 launch operation 与 lifecycle：通过 Dev Session 创建真实 Codex terminal，读取真实 `/api/terminal/session/:id/state` 与 lifecycle 事件。
5. 用手工/脚本化 CLI 验证 App home overview 和 CLI handoff 以 `/state` 为准。
6. 分开做 Web 真实页面验收和 App terminal detail 验收；App Stop/composer 属于 App manual / App Playwright，不由 `frontend/tests` 兜底覆盖。

## 浏览器真实流量验收步骤

以下步骤用于 TS-API-002、TS-API-004、TS-HOME-002、TS-HOME-008、TS-UI-002、TS-UI-011 的真实路径验收。不要用 Playwright E2E harness 或 `frontend/tests/*.spec.ts` 替代。

1. 按 `$toolkit:runweave-change-validation` 启动 planner 选定的隔离 Dev Session，不设置 `RUNWEAVE_E2E_TEST_ROUTES=true`。
2. 用 `$toolkit:playwright-cli` 打开前端登录页，使用真实登录表单登录。
3. 通过页面真实 API 创建 terminal session，命令使用本机真实 `codex`，例如 `command="/opt/homebrew/bin/codex"`，`runtimePreference="tmux"`。
4. 打开 `/terminal/<terminalSessionId>`，记录 launch response 的 `operationId`、`phase="command_submitted"` 与 `commandSubmittedAt`。
5. 在同一页面上下文内 `fetch("/api/terminal/session/<id>/state")`。
6. 预期：命令提交后为 `agent_starting/codex`；页面出现任何 ready 文案都不改变状态；匹配 `SessionStart` 后进入 `agent_idle/codex`，提交 prompt 后只有可信 `UserPromptSubmit` 能进入 `agent_running/codex`。
7. 验收结束后删除临时 terminal session，并停止临时 dev 服务。

## 建议验证命令

```sh
pnpm --filter ./backend typecheck
pnpm --filter ./backend lint
pnpm --filter ./packages/shared typecheck
pnpm --filter ./packages/runweave-cli typecheck
pnpm --filter ./packages/runweave-cli lint
pnpm --filter @runweave/app typecheck
pnpm --filter ./electron typecheck
pnpm --filter ./electron lint
```

本仓库不新增或维护单测。TerminalState 这类真实终端状态验收使用 Dev Session + `$toolkit:playwright-cli` 的真实浏览器流量；不要为了本文档新增或执行 Playwright E2E spec。App terminal detail 通过 App manual / App Playwright 单独验收。
