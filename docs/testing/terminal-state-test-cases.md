# TerminalState 测试案例

本文档用于审阅和补齐当前终端状态测试。目标不是描述已经完全正确的实现，而是把当前代码事实、目标契约和应补测试先编译成一份可执行清单，后续再按这些案例修正代码。

## 适用范围

- Codex CLI 终端状态三态：`shell_idle`、`agent_idle`、`agent_running`。
- 后端状态服务：`backend/src/terminal/terminal-state-service.ts`。
- 后端状态 API：`GET /api/terminal/session/:terminalSessionId/state`。
- 内部 hook API：`POST /internal/terminal/agent-hook`。
- metadata 接入：`backend/src/ws/terminal-server.ts` 在 `activeCommand` 变化后调用状态服务。
- App home overview：`GET /api/app/home/overview` 返回 `displayStatus/displayStatusLabel/terminalState`。
- App terminal detail：`app/src/pages/AppTerminalPage.tsx` 以 `terminalState.state === "agent_running"` 决定 Stop。
- CLI handoff/interrupt：`packages/runweave-cli/src/commands/terminal.ts` 以 `/state` 返回值输出 handoff 状态，`interrupt` 只发送 ESC，不直接改状态。

## 当前代码事实

- `TerminalState` 协议只允许：
  - `shell_idle` + `agent=null`
  - `agent_idle` + `agent="codex"`
  - `agent_running` + `agent="codex"`
- `TerminalStateService.handleAgentHook()` 当前映射：
  - `SessionStart` -> `agent_idle`
  - `UserPromptSubmit` -> `agent_running`
  - `Stop` -> `agent_idle`
- `session.status === "exited"` 在 `getCurrent()` 和 `setShellActiveCommand()` 中优先返回 `shell_idle`。
- `/state` 不应读取 live tail 推断 `agent_running`。如果当前代码存在 `Working (... esc to interrupt ...)` 这类输出 heuristic，应视为需要删除的实现缺陷，而不是测试契约。
- `AppHomeOverviewSession` 当前已经携带完整 `terminalState`。
- CLI `handoff` 当前仍保留旧的 `inferHandoffWorkloadState()`，但输出的 `terminalState/agent/inferredState/inferredWorkloadState/stateConfidence` 已以后端 `/state` 为强状态来源。

## 已知需要用测试固定的问题

### K1 `command="codex"` 不应永久代表当前仍在 Codex

目标契约来自 `docs/plans/2026-06-09-codex-cli-terminal-state.md`：`activeCommand=codex` 表示进入 Codex CLI；`activeCommand=null` 或非 Codex 要把状态推进到 `shell_idle`。

当前实现的 `isCodexSession()` 同时检查 `activeCommand` 和 session 原始 `command`。因此 `command="codex"` 且 `activeCommand="node"` 或 `activeCommand=null` 时，当前代码仍可能保留或恢复 Codex 状态。这类用例应该写成目标契约测试，允许先失败，再驱动修复。

### K2 hook 接收条件不应被 stale `command="codex"` 放宽

非 `SessionStart` hook 只有在当前 Codex 前台、grace window、或服务端已有 Codex 状态时才应被接收。若 session 原始 `command="codex"` 但当前 `activeCommand="node"`，`UserPromptSubmit/Stop` 不应被当作当前 Codex hook 写入状态。

### K3 Stop/Interrupt 不是状态来源

HTTP interrupt 返回 `interruptSequence="escape"`，只表示向终端输入 ESC。Stop 是否消失只能依赖后续 `hookEvent="Stop"` 或 `activeCommand` 变化，不能由点击 Stop 或 interrupt API 本地乐观改状态。

当前 P0 临时兼容：由于 Codex CLI 用户中断暂时不会稳定触发 `Stop` hook，HTTP interrupt 对当前 Codex running session 会手动写入 `agent_idle/codex`。这不是长期目标契约，后续 Codex Stop hook 修复后应回收该兼容逻辑，并恢复 interrupt 不写状态的回归测试。

### K4 live tail 不是状态来源

Codex TUI 输出里的 `Working (... esc to interrupt ...)` 只能作为用户可见文本，不能作为产品状态源。`agent_running` 只能由 Codex hook 的 `UserPromptSubmit` 写入；如果 hook 丢失，状态应保守停留在 `agent_idle` 或由 `activeCommand` 变化回到 `shell_idle`，不从 scrollback/tail 猜测 running。

## 测试分层

| 层级                        | 文件/入口                                                                                       | 目标                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| backend static              | `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint`                             | 状态服务、routes、WebSocket 相关代码无 TS 或 lint 错误                                            |
| CLI static/manual           | `pnpm --filter ./packages/runweave-cli typecheck && pnpm --filter ./packages/runweave-cli lint` | 验证 handoff 输出以后端 TerminalState 为准，interrupt 不写状态                                    |
| Electron static/manual      | `pnpm --filter ./electron typecheck && pnpm --filter ./electron lint`                           | 验证 Codex hooks 上报到 `/internal/terminal/agent-hook`，body 携带 terminal id 和 token           |
| Web E2E                     | `frontend/tests/*.spec.ts`                                                                      | 只覆盖 Web frontend 终端页和 Web mobile 行为；不覆盖 `app/src`                                    |
| App manual / App Playwright | App dev/simulator + `$playwright-cli` 或手工验收                                                | 覆盖 `app/src/pages/AppTerminalPage.tsx` 的 Stop、composer、状态轮询；不要误归到 `frontend/tests` |

## 后端状态服务测试

| ID         | 初始条件                                                                             | 操作                                                           | 预期                                                   | 当前实现             |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------ | -------------------- |
| TS-SVC-001 | 无 store；session running，`command="zsh"`，`activeCommand=null`                     | `getCurrent()`                                                 | `shell_idle/null`                                      | 应通过               |
| TS-SVC-002 | 无 store；session running，`command="zsh"`，`activeCommand="codex"`                  | `getCurrent()`                                                 | `agent_idle/codex`                                     | 应通过               |
| TS-SVC-003 | 无 store；session running，`activeCommand="/usr/local/bin/codex"`                    | `getCurrent()`                                                 | `agent_idle/codex`                                     | 应通过               |
| TS-SVC-004 | 无 store；session running，`activeCommand="node"`                                    | `getCurrent()`                                                 | `shell_idle/null`                                      | 应通过               |
| TS-SVC-005 | store 为 `agent_running`；session exited，`activeCommand="codex"`                    | `getCurrent()`                                                 | `shell_idle/null`                                      | 应通过               |
| TS-SVC-006 | session running，`activeCommand="codex"`                                             | `setShellActiveCommand()`                                      | `agent_idle/codex`                                     | 应通过               |
| TS-SVC-007 | store 为 `agent_running`；session running，`command="zsh"`，`activeCommand=null`     | `setShellActiveCommand()`                                      | `shell_idle/null`                                      | 应通过               |
| TS-SVC-008 | store 为 `agent_running`；session running，`command="zsh"`，`activeCommand="node"`   | `setShellActiveCommand()`                                      | `shell_idle/null`                                      | 应通过               |
| TS-SVC-009 | store 为 `agent_running`；session running，`command="codex"`，`activeCommand="node"` | `setShellActiveCommand()`                                      | `shell_idle/null`                                      | 当前会失败，目标契约 |
| TS-SVC-010 | store 为 `agent_idle`；session running，`command="codex"`，`activeCommand=null`      | `setShellActiveCommand()`                                      | `shell_idle/null`                                      | 当前会失败，目标契约 |
| TS-SVC-011 | 无 store；session running，`command="codex"`，`activeCommand=null`                   | `getCurrent()`                                                 | `shell_idle/null`                                      | 当前会失败，目标契约 |
| TS-SVC-012 | 无 store；session running，`activeCommand="Codex"`                                   | `getCurrent()`                                                 | 明确预期：若只支持精确 `codex`，应为 `shell_idle/null` | 需确认并固定         |
| TS-SVC-013 | 任意 store；`agent="codex"`，`hookEvent="SessionStart"`                              | `handleAgentHook()`                                            | `agent_idle/codex`                                     | 应通过               |
| TS-SVC-014 | 任意 store；`agent="codex"`，`hookEvent="UserPromptSubmit"`                          | `handleAgentHook()`                                            | `agent_running/codex`                                  | 应通过               |
| TS-SVC-015 | store 为 `agent_running`；`agent="codex"`，`hookEvent="Stop"`                        | `handleAgentHook()`                                            | `agent_idle/codex`                                     | 应通过               |
| TS-SVC-016 | 任意 store/session                                                                   | 代码搜索 `reconcileCurrentFromOutput` / Codex Working 输出正则 | 不应存在运行时代码命中；tail heuristic 不属于状态服务  | 已按目标清理         |
| TS-SVC-017 | 当前为 `agent_idle`；scrollback/tail 含 Codex Working 文案                           | `getCurrent()`                                                 | 保持 `agent_idle/codex`，不因输出文本进入 running      | 目标契约             |
| TS-SVC-018 | 当前为 `shell_idle`；scrollback/tail 含 Codex Working 文案                           | `getCurrent()`                                                 | 保持 `shell_idle/null`                                 | 目标契约             |

## 后端状态 API 测试

| ID         | 初始条件                                                                             | 请求                                        | 预期                                                                             |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------- |
| TS-API-001 | session 不存在                                                                       | `GET /api/terminal/session/not-found/state` | 404                                                                              |
| TS-API-002 | session running，`activeCommand="codex"`，无 store                                   | `GET /state`                                | 200，`agent_idle/codex`                                                          |
| TS-API-003 | session exited，store 为 `agent_running`                                             | `GET /state`                                | 200，`shell_idle/null`                                                           |
| TS-API-004 | session running，store 为 `agent_idle`，live tail 命中 Codex Working                 | `GET /state`                                | 200，保持 `agent_idle/codex`；不得读取 tail，不得推进 store                      |
| TS-API-005 | session running，store 为 `agent_idle`，live tail 不命中                             | `GET /state`                                | 200，保持 `agent_idle/codex`；不得读取 tail                                      |
| TS-API-006 | session running，store 为 `shell_idle`，live tail 命中 Working                       | `GET /state`                                | 200，保持 `shell_idle/null`；不得读取 tail                                       |
| TS-API-007 | session running，`command="codex"`，`activeCommand="node"`，store 为空               | `GET /state`                                | 目标契约：`shell_idle/null`；当前可能失败                                        |
| TS-API-008 | session running，`command="codex"`，`activeCommand="node"`，store 为 `agent_running` | `GET /state`                                | 目标契约：`shell_idle/null`；残留 store 不能覆盖新的非 Codex metadata            |
| TS-API-009 | session running，`command="codex"`，`activeCommand=null`，store 为 `agent_idle`      | `GET /state`                                | 目标契约：`shell_idle/null`；残留 store 不能让 API/App/CLI 继续看到旧 Codex 状态 |

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
| TS-HOOK-014 | running session，`command="codex"`，`activeCommand="node"`，store 为空                  | `UserPromptSubmit`                   | 目标契约：忽略并保持 `shell_idle/null`；当前可能失败      |
| TS-HOOK-015 | running session，`command="codex"`，`activeCommand=null`，store 为空                    | `Stop`                               | 目标契约：忽略并保持 `shell_idle/null`；当前可能失败      |
| TS-HOOK-016 | running session，store 已为 `agent_running`，但 `activeCommand` 短暂为空                | `Stop`                               | 202，允许落到 `agent_idle/codex`，避免 Stop hook 晚到丢失 |

## metadata / WebSocket 集成测试

| ID        | 初始条件                                                   | 操作                                    | 预期                                                                           |
| --------- | ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| TS-WS-001 | session `activeCommand=null`                               | metadata 更新为 `activeCommand="codex"` | 调用 `setShellActiveCommand()`，状态为 `agent_idle/codex`，发送 metadata event |
| TS-WS-002 | store 为 `agent_running`                                   | metadata 更新为 `activeCommand=null`    | 状态为 `shell_idle/null`                                                       |
| TS-WS-003 | store 为 `agent_running`                                   | metadata 更新为 `activeCommand="node"`  | 目标契约：状态为 `shell_idle/null`；若 session `command="codex"` 当前可能失败  |
| TS-WS-004 | metadata cwd 变化但 `activeCommand` 未变                   | publish metadata                        | 只因 cwd 变化发送 metadata；状态不应被错误推进                                 |
| TS-WS-005 | metadata 完全未变化且非 force                              | publish metadata                        | 不发送 metadata，不调用状态服务                                                |
| TS-WS-006 | force send 但 metadata 未变化                              | publish metadata                        | 发送 metadata；不应重复写状态                                                  |
| TS-WS-007 | tmux metadata reader 返回 `activeCommand="/path/to/codex"` | sync metadata                           | 状态为 `agent_idle/codex`                                                      |
| TS-WS-008 | tmux metadata reader 返回 `activeCommand="claude"`         | sync metadata                           | 第一阶段为 `shell_idle/null`                                                   |

## App home overview 测试

| ID          | 初始条件                                                  | 请求                         | 预期                                                                                                              |
| ----------- | --------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TS-HOME-001 | running session，store `agent_running`                    | `GET /api/app/home/overview` | session `displayStatus="running"`，`displayStatusLabel="Agent Running"`，携带 `terminalState=agent_running/codex` |
| TS-HOME-002 | running session，`activeCommand="codex"`，无 running hook | `GET /home/overview`         | `displayStatus="agent-idle"`，`terminalState=agent_idle/codex`                                                    |
| TS-HOME-003 | running shell session                                     | `GET /home/overview`         | `displayStatus="idle"`，`terminalState=shell_idle/null`                                                           |
| TS-HOME-004 | exited session，残留 `activeCommand="codex"`              | `GET /home/overview`         | `displayStatus="exited"`，`terminalState=shell_idle/null`                                                         |
| TS-HOME-005 | 多 session 混排                                           | `GET /home/overview`         | 按 `lastActivityAt` 降序；同时间保持原顺序                                                                        |
| TS-HOME-006 | session `command="codex"`，`activeCommand="node"`         | `GET /home/overview`         | 目标契约：展示 shell idle，不展示 Agent Idle/Running                                                              |
| TS-HOME-007 | response payload                                          | `GET /home/overview`         | 不读取或返回 tail；不触发 live scrollback 读取                                                                    |

## CLI 测试

| ID         | 初始条件                                                                              | 命令                                | 预期                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| TS-CLI-001 | `/state` 返回 `shell_idle/null`，session `activeCommand="sleep"`                      | `rw terminal handoff <id> --json`   | `terminalState="shell_idle"`，`agent=null`，`inferredWorkloadState="shell_idle"`，`stateConfidence="strong"` |
| TS-CLI-002 | `/state` 返回 `agent_idle/codex`，tail 看起来像 busy                                  | `handoff --json`                    | 仍输出 `agent_idle`，不被 tail heuristic 改成 running                                                        |
| TS-CLI-003 | `/state` 返回 `agent_running/codex`，session `activeCommand="codex"`                  | `handoff --json`                    | 输出 `agent_running`、`agent="codex"`，`stateReasons` 包含 `terminalState=agent_running`                     |
| TS-CLI-004 | session exited，旧 tail 含 Codex prompt                                               | `handoff --json`                    | `terminalState="shell_idle"`，不显示 agent running                                                           |
| TS-CLI-005 | session `command="codex"`，`activeCommand="node"`，`/state` 返回目标契约 `shell_idle` | `handoff --json`                    | 输出 shell idle，避免原始 command 影响 handoff                                                               |
| TS-CLI-006 | interrupt success                                                                     | `rw terminal interrupt <id> --json` | 输出 HTTP interrupt response + `transport="http"`；不包含状态变更字段                                        |
| TS-CLI-007 | interrupt 之后立即 handoff，后端仍 `agent_running`                                    | `interrupt` 后 `handoff`            | handoff 仍为 `agent_running`，直到 hook Stop 或 activeCommand 变化                                           |

## App terminal detail / UI 验收

涉及打开页面、点击、截图或浏览器自动化时，必须使用 `$playwright-cli`，不要使用其它浏览器操作方案。

| ID        | 初始条件                                                | 操作                                                                                                                                                                                                                                                                                     | 预期                                                                                                   |
| --------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| TS-UI-001 | 未进入 Codex，后端 `/state=shell_idle`                  | 打开 App terminal detail                                                                                                                                                                                                                                                                 | 不显示 Stop                                                                                            |
| TS-UI-002 | 已进入 Codex 等待输入，`/state=agent_idle`              | 打开 App terminal detail                                                                                                                                                                                                                                                                 | 不显示 Stop；标题可显示当前 command 或 session title                                                   |
| TS-UI-003 | Codex prompt 提交后，hook 写 `agent_running`            | 等待下一次状态刷新                                                                                                                                                                                                                                                                       | 显示 Stop                                                                                              |
| TS-UI-004 | 点击 Stop，interrupt 成功但 `/state` 仍 `agent_running` | 点击 Stop 后立即观察                                                                                                                                                                                                                                                                     | Stop 不因本地乐观状态消失                                                                              |
| TS-UI-005 | hook `Stop` 到达，`/state=agent_idle`                   | 等待状态刷新                                                                                                                                                                                                                                                                             | Stop 消失，composer 仍可输入                                                                           |
| TS-UI-006 | `activeCommand` 清空，`/state=shell_idle`               | 等待状态刷新                                                                                                                                                                                                                                                                             | Stop 消失                                                                                              |
| TS-UI-007 | terminal session 404                                    | 状态轮询返回 404                                                                                                                                                                                                                                                                         | UI 将本地状态置为 `shell_idle`，不显示 Stop                                                            |
| TS-UI-008 | 状态轮询 401                                            | 先打开一个 running terminal detail，再用页面内 `fetch("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer <当前 accessToken>" } })` 让后端注销当前 session；不要用 Playwright `route.fulfill({ status: 401 })` mock `/state`，当前环境下页面 fetch 会读到 `status=0` | 下一次 `/state` 轮询收到真实 401 后调用 auth expired：清理 `runweave-app-auth-session` 并回到 `/login` |
| TS-UI-009 | 状态轮询普通网络错误                                    | 状态 API 失败                                                                                                                                                                                                                                                                            | 保持当前可见状态，不清空输入                                                                           |
| TS-UI-010 | sendTerminalInput 第一次失败                            | composer 提交命令                                                                                                                                                                                                                                                                        | 不应发送第二个 bare newline，不应清空用户输入；这是既有 review 指出的回归用例                          |

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

1. 先用代码审查和静态检查确认 `TerminalStateService` 目标契约，尤其是 `command="codex"` + `activeCommand=null/node` 的反向案例。
2. 再审查 route 级 hook gate，确保 stale `command="codex"` 不会放宽 `UserPromptSubmit/Stop`。
3. 确认 `/state` 不读取 live tail，不让 tail/scrollback 把任何状态推进到 `agent_running`。
4. 用手工/脚本化 CLI 验证 App home overview 和 CLI handoff 以 `/state` 为准。
5. 分开做 Web E2E 和 App terminal detail 验收；App Stop/composer 属于 App manual / App Playwright，不由 `frontend/tests` 兜底覆盖。

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

本仓库不新增或维护单测。Web 行为通过 `frontend/tests` E2E 覆盖；App terminal detail 通过 App manual / App Playwright 单独验收。需要自动化页面验证时，使用 Playwright E2E；需要人工页面验收时，按仓库约束通过 `$playwright-cli` 打开和操作页面。
