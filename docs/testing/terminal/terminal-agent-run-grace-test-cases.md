# Terminal Panel Agent 活动租约测试案例

## 范围

验证真实 tmux 多 Pane 中，Agent 的 `activeCommand` 清空后，`Stop` 只在同一 Panel、同一 Agent、同一 operation 的 30 秒 grace 窗口内被接收；同一 Profile 的 Backend 重启只能恢复仍有效且身份一致的活动记录。

不验证 UI 视觉样式，不新增单元测试或 Playwright spec。浏览器与终端操作通过真实 Dev Session + `$toolkit:playwright-cli` 完成；后端响应、tmux metadata 和日志作为证据。

## 前提事实

- Agent 状态入口：`POST /internal/terminal/agent-hook`。
- Completion 入口：`POST /internal/terminal-completion`。
- 状态查询：`GET /api/terminal/session/:terminalSessionId/state`。
- Agent launch response 提供 `operationId`、`panelId` 和 `tmuxPaneId`。
- `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID` 随 launch command 注入 Agent 进程。
- grace 从后端观察到目标 Panel `activeCommand` 由 Agent command 变为 `null` 的时刻开始计算，长度为 30 秒。
- 本仓库不新增 backend 单测；测试必须创建真实 Session/Panel 并启动真实 Codex。

## 必跑命令

严格按顺序执行，任一失败即停止，不执行后续行为用例：

```sh
pnpm --filter ./backend typecheck
pnpm --filter ./backend lint
pnpm --filter ./packages/shared typecheck
pnpm --filter ./electron typecheck
pnpm --filter ./electron lint
pnpm toolkit:verify-hooks
git diff --check
```

## 判定表

| 目标 Panel            | operation identity          | 目标 command  | grace      | 结果                                 |
| --------------------- | --------------------------- | ------------- | ---------- | ------------------------------------ |
| 一致                  | 一致                        | Agent command | 不适用     | recorded                             |
| 一致                  | 一致                        | null          | 30 秒内    | recorded                             |
| 一致                  | 一致                        | null          | 超过 30 秒 | ignored/inactive_agent               |
| 不一致                | 任意                        | null          | 任意       | ignored，不得消费其它 Panel 的 grace |
| 一致                  | 过期/缺失且 generation 存在 | 任意          | 任意       | ignored/operation_identity_mismatch  |
| 无 identity 且多 Pane | 任意                        | 任意          | 任意       | ignored/panel_identity_mismatch      |

## 真实行为用例

### AR-GRACE-001 多 Pane 中同一 operation 的 Stop 在 grace 内被接收

**前置条件（Given）**

- 使用新的 Dev Session/Profile 创建真实 tmux terminal。
- Session 中至少有两个 running Panel：Panel A 保持普通 shell，Panel B 通过产品 Agent launch API 启动 Codex。
- 保存 Panel B 的 `panelId`、`tmuxPaneId` 和 `operationId`。
- `SessionStart` 已使 Panel B 进入 `agent_idle/codex`。

**操作（When）**

1. 使用 `$toolkit:playwright-cli` 附着该 Dev Session 的 Web/desktop 浏览器实例，打开目标 terminal 页面。
2. 在 Panel B 真实输入 `/quit`，等待 Panel B metadata 的 `activeCommand` 变为 `null`；记录后端首次观察到清空的时间。
3. 在清空后 5 秒内，使用真实 hook token 向 `/internal/terminal/agent-hook` 发送：
   - `terminalSessionId=<目标 Session>`
   - `panelId=<Panel B>`
   - `tmuxPaneId=<Panel B tmux pane>`
   - `operationId=<Panel B 当前 launch operation>`
   - `agent=codex`
   - `hookEvent=Stop`
4. 查询目标 Session `/state`，并读取 backend 结构化日志中的 hook disposition。

**预期结果（Then）**

- Hook HTTP 为 `202`。
- body `disposition=recorded`，返回状态为 `agent_idle/codex`。
- backend 日志为 `terminal-state.hook.recorded` 且 `panelId` 为 Panel B，不是 `inactive_agent`。
- Panel A 的 activeCommand、thread 和 TerminalState 没有被 Panel B 的 grace 污染。

**失败判断**

- 返回 `ignored/inactive_agent` 或 `operation_identity_mismatch`。
- 返回/日志归属 Panel A 或修改了 Panel A 状态。
- 只有 Session 级状态变化、Panel B 未记录对应 hook。

**验证方式**

- `$toolkit:playwright-cli` 真实页面操作与页面内真实 API 请求。
- tmux pane option、backend JSONL 日志和 HTTP body 三方取证。

### AR-GRACE-002 同一 operation 的 Stop 在 grace 外被拒绝

**前置条件（Given）**

- 独立创建与 AR-GRACE-001 相同的多 Pane真实 Codex Session，不复用其 Session。
- Panel B 已从 `activeCommand=codex` 收敛到 `null`。

**操作（When）**

- 从后端观察到 Panel B metadata 清空起等待至少 31 秒，再发送同一 Panel、Agent、operation 的 `Stop`。

**预期结果（Then）**

- HTTP `202`，`disposition=ignored`、`ignoreReason=inactive_agent`。
- Panel B 保持当前非 Agent 状态；Panel A 不变化。

**失败判断**

- 返回 `recorded`，或重新把 Panel B/Session 写为 `agent_idle/codex`。

**验证方式**

- `$toolkit:playwright-cli` 页面内真实 API + backend JSONL 时间戳。

### AR-GRACE-003 另一个 Panel 不得消费目标 Panel 的 grace

**前置条件（Given）**

- 多 Pane Session 中，Panel B 的 Codex 刚进入 grace；Panel A 为 shell。

**操作（When）**

- 使用 Panel A 的 `panelId/tmuxPaneId`，携带 Panel B 的 agent/operation 信息发送 `Stop`。

**预期结果（Then）**

- `disposition=ignored`；若 Panel A 存在不同 operation generation，则 `ignoreReason=operation_identity_mismatch`，否则为 `inactive_agent`。
- Panel A、Panel B 状态均不因该请求改变。

**失败判断**

- 请求被 `recorded`，或 Panel B 的 grace 被用于接受 Panel A 请求。

### AR-GRACE-004 新 operation 启动后拒绝旧 operation 的迟到 Stop

**前置条件（Given）**

- Panel B 的 operation O1 已进入 grace。
- 在同一 Panel 启动新 Codex operation O2，并取得新的 operation ID。

**操作（When）**

- 在 O1 的原 30 秒窗口内发送携带 O1 的迟到 `Stop`。

**预期结果（Then）**

- `disposition=ignored`、`ignoreReason=operation_identity_mismatch`。
- O2 的 `agent_starting/agent_idle/agent_running` 状态不被降为 idle。

**失败判断**

- O1 Stop 被 recorded，或 O2 状态/线程被清理。

### AR-GRACE-005 多 Pane无 Panel identity 的 Stop 必须 fail-closed

**前置条件（Given）**

- Session 有至少两个 running Panel，其中一个 Panel 正处于 Codex grace。

**操作（When）**

- 发送不含 `panelId` 和 `tmuxPaneId` 的 `Stop`。

**预期结果（Then）**

- `disposition=ignored`、`ignoreReason=panel_identity_mismatch`。
- 所有 Panel 状态不变。

**失败判断**

- 系统猜测某个 Panel 并记录 Stop。

### AR-GRACE-006 单 running Panel 的 legacy hook 解析到唯一 Panel

**前置条件（Given）**

- Session 恰好有一个 running Panel，且该 Panel 的手动 Codex 已进入 grace；该路径没有 operation generation。

**操作（When）**

- 在 grace 内发送不含 Panel identity 和 operation ID 的 legacy `Stop`。

**预期结果（Then）**

- 请求解析到唯一 running Panel并 `recorded`。
- 响应返回该 Panel ID，不创建第二份 Session 级活动事实。

**失败判断**

- 被误判为多 Pane、写入不存在的 Session scope，或 `inactive_agent`。

### AR-GRACE-007 Backend 重启后恢复 grace 的剩余有效窗口

**前置条件（Given）**

- Panel B 已进入 grace，并记录其 operation ID、`clearedAt` 和 Profile 下 `terminal-session-store.json` 的持久化活动记录。

**操作（When）**

- 在 `clearedAt` 后 5 秒内重启同一 Backend/Profile且不重启 tmux；Backend ready 后立即发送同一 Panel、Agent、operation 的 `Stop`。

**预期结果（Then）**

- LowDB 中未过期的 Panel 活动租约和 operation generation 被恢复。
- 只计算原 `clearedAt` 剩余窗口，不因 Backend 启动刷新为新的 30 秒。
- Stop 返回 `disposition=recorded`，归属原 Panel 和 operation。

**失败判断**

- 重启后有效 grace 被 `inactive_agent`/`operation_identity_mismatch` 拒绝。
- `clearedAt` 被刷新，导致原始 30 秒之后仍可接收。
- 恢复到其它 Panel 或不同 operation。

## 覆盖说明

- 功能主路径：AR-GRACE-001。
- 30 秒边界：AR-GRACE-001/002。
- 多 Pane 并发隔离：AR-GRACE-003/005。
- 迟到事件与 generation 切换：AR-GRACE-004。
- legacy 兼容：AR-GRACE-006。
- 重启恢复：AR-GRACE-007，恢复未过期窗口但不刷新时间基准。
- 重复 Stop 去重不在本次范围：当前接口允许幂等写相同 idle 状态，completion event 去重另有契约。
- 鉴权和非法 schema 不重复覆盖：已有 `docs/testing/terminal/terminal-state-test-cases.md` 的 `TS-HOOK-001` 至 `TS-HOOK-006`。
- UI 样式、移动端布局不覆盖：本需求只改变后端状态与事件归属。

## 验收通过标准

- 必跑命令全部成功。
- AR-GRACE-001 至 AR-GRACE-007 逐条通过；严格模式下任一失败立即停止。
- 多 Pane 中不存在跨 Panel、跨 operation 的 grace 接收。
- 单 Pane legacy 路径仍可用。
- 测试过程保留 Session ID、Panel ID、operation ID、请求响应、metadata 清空时间和 backend JSONL 日志证据。

## 2026-07-16 执行记录

本次按用户要求实际执行功能主路径 `AR-GRACE-001`；`AR-GRACE-002` 至 `AR-GRACE-007` 为后续完整回归矩阵，本次未执行，不能据此宣称整份矩阵通过。

- Dev Session：`dvs-718037`（beta `pool-02`），Backend `127.0.0.1:5007`。
- Terminal Session：`54c4a578`。
- Panel A：`f1b8427a-1065-48a7-b5ab-a362cfb5a795` / tmux `%0`。
- Panel B：`50542055-056c-4573-a071-a5b2fb963662` / tmux `%1`。
- launch operation：`terminal_agent_prepare_a23e6a63-e87c-4af4-aea7-f1dd17da2f53`。
- `2026-07-16T15:45:23.647Z`：Panel B 为 `activeCommand=codex`、`agent_idle/codex`。
- 使用 `$toolkit:playwright-cli` 在真实 terminal input 输入 `/quit`；`2026-07-16T15:45:40.444Z` Panels API 首次观察到 Panel B `activeCommand=null`、`shell_idle/null`。
- grace 内发送同 Panel、同 operation 的 `Stop`，HTTP `202`，响应 `{"terminalState":{"state":"agent_idle","agent":"codex"},"disposition":"recorded"}`。
- `backend-2026-07-16.jsonl` 记录 `terminal-state.hook.recorded`，`panelId=50542055-056c-4573-a071-a5b2fb963662`，时间 `2026-07-16T15:45:51.043Z`。
- 持久化记录为 Panel B 的 `phase=grace`，`clearedAt=1784216740434`，operation ID 与 launch 一致。
- hook 后复查：Panel A 与 Panel B 均保持 `activeCommand=null`、`shell_idle/null`；Panel B 的 grace 未污染 Panel A。
- 结论：`AR-GRACE-001` 通过。
