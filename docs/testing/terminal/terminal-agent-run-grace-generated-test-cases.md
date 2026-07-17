# Terminal Panel Agent 活动租约生成测试案例

## 生成来源

- 输入来源：`docs/testing/terminal/terminal-agent-run-grace-test-cases.md`。
- 来源已定义可追溯 case ID 前缀 `AR-GRACE`；本文档严格沿用该前缀与 `AR-GRACE-001` 至 `AR-GRACE-007`，不新建领域前缀。
- 本文档是 Agent Team 可解析的验收合同，不代表用例已经执行。

## 范围

验证真实 tmux 多 Pane 中，Agent 的 `activeCommand` 清空后，`Stop` 只在同一 Panel、同一 Agent、同一 operation 的 30 秒 grace 窗口内被接收；同一 Profile 的 Backend 重启只能恢复仍有效且身份一致的活动租约。

不验证 UI 视觉样式，不新增单元测试或 Playwright spec。浏览器与终端操作必须通过真实 Dev Session 和 `$toolkit:playwright-cli` 完成；HTTP 响应、tmux metadata、LowDB 投影和 backend 结构化日志作为行为证据，静态检查不代替行为验收。

## 前提事实

- Agent 状态入口为 `POST /internal/terminal/agent-hook`，Completion 入口为 `POST /internal/terminal-completion`，状态查询入口为 `GET /api/terminal/session/:terminalSessionId/state`。
- Agent launch response 提供 `operationId`、`panelId` 和 `tmuxPaneId`；launch command 通过 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID` 把 operation identity 注入 Agent 进程。
- `backend/src/terminal/completion-source-gate.ts` 定义 30 秒 grace；`clearedAt` 以 Backend 首次观察到目标 Panel `activeCommand` 从 Agent command 变为 `null` 的时刻为准。
- `backend/src/terminal/agent-hook-processor.ts` 按 Panel、Agent、operation identity 和活动租约判定 hook；多 Pane 缺少 Panel identity 时 fail-closed。
- `backend/src/routes/terminal-completion.ts` 对 completion 使用相同的 Panel、operation identity 和 grace 边界。
- `backend/src/terminal/store.ts` 的持久化投影用于同一 Backend Profile 重启恢复；恢复不得刷新原 `clearedAt`。
- 本仓库不新增 backend 单元测试；用例必须创建真实 Session、真实 Panel，并启动真实 Codex。

## 设计方法与覆盖

- 判定表：目标 Panel、operation identity、当前 command、grace 是否有效共同决定 recorded 或 ignored。
- 边界值：`AR-GRACE-001` 使用明确位于窗口内的 5 秒采样；`AR-GRACE-002` 使用至少 31 秒采样，避免把轮询抖动误当作 30 秒边界结论。
- 状态迁移：覆盖 `active -> grace -> recorded/expired`、旧 operation 被新 operation 替换以及 Backend 重启恢复。
- 并发隔离：覆盖多 Pane 交叉身份和多 Pane 缺失 identity。
- 兼容性：覆盖单 running Panel 的 legacy hook。
- 幂等与重复 Stop 不覆盖：当前接口允许重复写入相同 idle 状态，completion event 去重属于另一份合同。
- 鉴权与非法 schema 不覆盖：沿用 `docs/testing/terminal/terminal-state-test-cases.md` 中 `TS-HOOK-001` 至 `TS-HOOK-006`。
- UI 样式、移动端布局和跨 Profile 恢复不覆盖：本需求只改变 Backend 状态、事件归属和同 Profile 恢复。

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

## 测试案例

### AR-GRACE-001 多 Pane 中同一 operation 的 Stop 在 grace 内被接收

前置条件：

- 使用新的 Dev Session/Profile 创建真实 tmux terminal。
- Session 中至少有两个 running Panel：Panel A 保持普通 shell，Panel B 通过产品 Agent launch API 启动 Codex。
- 保存 Panel B 的 `panelId`、`tmuxPaneId` 和 `operationId`；`SessionStart` 已使 Panel B 进入 `agent_idle/codex`。

步骤：

1. 使用 `$toolkit:playwright-cli` 附着该 Dev Session 的 Web 或 desktop 浏览器实例并打开目标 terminal 页面。
2. 在 Panel B 真实输入 `/quit`，等待 Panel B metadata 的 `activeCommand` 变为 `null`，记录 Backend 首次观察到清空的时间。
3. 在清空后 5 秒内，使用真实 hook token 向 `/internal/terminal/agent-hook` 发送 Panel B 的 `terminalSessionId`、`panelId`、`tmuxPaneId`、当前 `operationId`、`agent=codex` 和 `hookEvent=Stop`。
4. 查询目标 Session `/state`，读取 backend 结构化日志中的 hook disposition，并复查 Panel A 与 Panel B metadata。

期望：

- Hook HTTP 为 `202`，body 为 `disposition=recorded`，返回状态为 `agent_idle/codex`。
- backend 日志事件为 `terminal-state.hook.recorded`，`panelId` 精确等于 Panel B，且不是 `inactive_agent`。
- Panel A 的 activeCommand、thread 和 TerminalState 未被 Panel B 的 grace 改写。

失败判定：

- 返回 `ignored/inactive_agent`、`operation_identity_mismatch`，或返回/日志归属 Panel A。
- 只有 Session 级状态变化，Panel B 未记录对应 hook，或 Panel A 状态被修改。

标签：behavior_verify playwright tmux grace multi_panel

### AR-GRACE-002 同一 operation 的 Stop 在 grace 外被拒绝

前置条件：

- 独立创建与 `AR-GRACE-001` 等价的多 Pane 真实 Codex Session，不复用其它用例的 Session。
- Panel B 已从 `activeCommand=codex` 收敛到 `null`，并记录 Backend 首次观察到清空的时间。

步骤：

1. 从 Backend 观察到 Panel B metadata 清空起等待至少 31 秒。
2. 向 `/internal/terminal/agent-hook` 发送同一 Panel、同一 Agent、同一 operation 的 `Stop`。
3. 读取 HTTP body、backend JSONL 时间戳和两个 Panel 的最新状态。

期望：

- HTTP 为 `202`，body 为 `disposition=ignored`、`ignoreReason=inactive_agent`。
- Panel B 保持当前非 Agent 状态，Panel A 不变化。

失败判定：

- 请求返回 `recorded`，或重新把 Panel B/Session 写为 `agent_idle/codex`。
- 计时基准使用 `/quit` 输入时刻而不是 Backend 记录的 metadata 清空时刻。

标签：behavior_verify playwright boundary grace_expired

### AR-GRACE-003 另一个 Panel 不得消费目标 Panel 的 grace

前置条件：

- 独立多 Pane Session 中，Panel B 的 Codex 刚进入 grace，Panel A 为普通 shell。
- 已保存 Panel A、Panel B 的 identity 以及 Panel B 的 operation identity。

步骤：

1. 使用 Panel A 的 `panelId` 和 `tmuxPaneId`，携带 Panel B 的 agent/operation 信息发送 `Stop`。
2. 读取 HTTP body、backend 结构化日志和两个 Panel 的状态。

期望：

- 请求为 `disposition=ignored`；若 Panel A 存在不同 operation generation，`ignoreReason=operation_identity_mismatch`，否则为 `inactive_agent`。
- Panel A、Panel B 状态均不因该请求改变，Panel B 的 grace 仍只属于 Panel B。

失败判定：

- 请求被 `recorded`，Panel A 状态被改写，或 Panel B 的 grace 被用于接受 Panel A 请求。

标签：behavior_verify playwright multi_panel isolation

### AR-GRACE-004 新 operation 启动后拒绝旧 operation 的迟到 Stop

前置条件：

- 独立 Session 的 Panel B operation O1 已进入 grace。
- 在同一 Panel 启动新的 Codex operation O2，并保存 O1、O2 两个不同的 operation ID。

步骤：

1. 在 O1 原 30 秒窗口内发送携带 O1 的迟到 `Stop`。
2. 读取 HTTP body、backend 结构化日志和 O2 的 TerminalState。

期望：

- 请求为 `disposition=ignored`、`ignoreReason=operation_identity_mismatch`。
- O2 的 `agent_starting`、`agent_idle` 或 `agent_running` 状态不被 O1 的迟到事件降为 idle，也不清理 O2 thread。

失败判定：

- O1 的 `Stop` 被 recorded，O2 状态或 thread 被清理，或日志把 O1 归属为 O2。

标签：behavior_verify playwright late_event operation_generation

### AR-GRACE-005 多 Pane 无 Panel identity 的 Stop 必须 fail-closed

前置条件：

- 独立 Session 有至少两个 running Panel，其中一个 Panel 正处于 Codex grace。

步骤：

1. 发送包含 Session、Agent 和 operation 信息，但不含 `panelId`、`tmuxPaneId` 的 `Stop`。
2. 读取 HTTP body、backend 结构化日志和所有 Panel 的状态。

期望：

- 请求为 `disposition=ignored`、`ignoreReason=panel_identity_mismatch`。
- 系统不猜测目标 Panel，所有 Panel 状态保持不变。

失败判定：

- 请求被 recorded，系统选择任意 Panel，或任一 Panel 状态发生改变。

标签：behavior_verify playwright fail_closed missing_identity

### AR-GRACE-006 单 running Panel 的 legacy hook 解析到唯一 Panel

前置条件：

- 独立 Session 恰好有一个 running Panel，且该 Panel 的手动 Codex 已进入 grace。
- 该 legacy 路径没有 operation generation。

步骤：

1. 在 grace 内发送不含 `panelId`、`tmuxPaneId` 和 `operationId` 的 legacy `Stop`。
2. 读取 HTTP body、backend 结构化日志、唯一 Panel 状态和 Session 聚合状态。

期望：

- 请求解析到唯一 running Panel 并返回 `disposition=recorded`。
- 响应和日志返回该 Panel ID，不创建第二份 Session scope 活动事实。

失败判定：

- 请求被误判为多 Pane或返回 `inactive_agent`。
- 状态写入不存在的 Session scope，或生成重复活动事实。

标签：behavior_verify playwright legacy single_panel compatibility

### AR-GRACE-007 Backend 重启后恢复 grace 的剩余有效窗口

前置条件：

- 独立 Session 的 Panel B 已进入 grace，并记录 operation ID、原始 `clearedAt` 和同一 Profile 下 `terminal-session-store.json` 的活动租约。
- Backend、Profile 和 tmux 的对应关系已保存，可在不重启 tmux 的前提下重启同一 Backend/Profile。

步骤：

1. 在原 `clearedAt` 后 5 秒内重启同一 Backend/Profile，不重启 tmux。
2. Backend ready 后立即发送同一 Panel、同一 Agent、同一 operation 的 `Stop`。
3. 读取 HTTP body、重启前后 LowDB 投影、backend 结构化日志和两个 Panel 状态。

期望：

- LowDB 中未过期的 Panel 活动租约和 operation generation 被恢复，归属原 Panel 和原 operation。
- grace 只计算原 `clearedAt` 的剩余窗口，Backend 启动不得把 `clearedAt` 刷新为新的 30 秒窗口。
- `Stop` 返回 `disposition=recorded`，Panel A 不变化。

失败判定：

- 重启后有效 grace 被 `inactive_agent` 或 `operation_identity_mismatch` 拒绝。
- `clearedAt` 被刷新，导致原始 30 秒之后仍可接收。
- 活动租约恢复到其它 Panel、不同 operation，或污染 Panel A。

标签：behavior_verify playwright restart persistence grace_recovery

## 验收通过标准

- 必跑命令全部成功。
- `AR-GRACE-001` 至 `AR-GRACE-007` 逐条执行并通过；严格模式下任一失败立即停止。
- 多 Pane 中不存在跨 Panel、跨 Agent、跨 operation 的 grace 接收。
- 单 Panel legacy 路径仍可用，同一 Profile 重启只恢复原 `clearedAt` 的剩余有效窗口。
- 每条用例都保留 Session ID、Panel ID、tmuxPaneId、operation ID、请求响应、metadata 清空时间和 backend JSONL/LowDB 证据；浏览器路径由 `$toolkit:playwright-cli` 取证。
