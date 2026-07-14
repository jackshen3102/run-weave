# Terminal Agent Operation Generation Round 127 独立代码审查

## 结论

`case_25=fail`。本轮增量已关闭上一轮“prepare 返回后 stale operation hook 仍被 recorded”的直接反例，但同一个 `terminal.agent-bootstrap-operation-lifecycle-boundary` 尚未真正关闭：command 提交后保留的 generation 会把 App Server 已按当前 thread/provider 精确匹配的 `agent.lifecycle.observed` 事件一律拒绝，因为该消费者没有 `operationId`，而 generation guard 在读取 `currentThreadIdentityMatched` 之前就返回 `ignored`。

这会让 Codex `thread/read` 或 Trae lifecycle reader 发现的真实 running/idle compensation 无法回写 panel/session terminal state；当直接 hook 缺失、延迟或需要 reconciliation 时，当前 worker 可能长期停留在错误的 `agent_running` / `agent_idle` 状态，继续影响 UI、readiness 与串行调度。因此仍有 1 条 P1，不能通过 code review gate。

本轮只读审查；未修改生产代码、verifier 或暂存区。唯一写入是本报告和 reviewer 指定 pane outbox，未执行 `behavior_verify`。

## 固定边界

- scope：`incremental`
- base / HEAD：`d83ce3955024d8f5628090191b42dd38e0204dee`
- target / index tree：`c7597464241a57880d7c836d979866e57792d063`
- changed paths：prompt 指定的 6 个路径，实际 `git diff --cached --name-only` 完全一致
- diff：103 additions / 20 deletions；`git diff --cached --check` 通过
- 计划 SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试用例 SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`

## P1 阻断

### 当前 thread 的 App Server lifecycle compensation 被 generation guard 永久挡住

`prepareTerminalAgent` 在命令成功提交后只释放 `panelAgentPreparations` single-flight，并保留 `panelAgentOperationGenerations`。这个方向确实使带 stale/missing operation 的直接 hook 在响应后继续 fail closed。

但 `handleAgentLifecycleEvent` 是另一条受信任消费者链：它先要求 event 的 thread/provider 与 panel 或 session 当前 owner 一致，再把 `currentThreadIdentityMatched=true` 传给 `processTerminalAgentHook`。`agent.lifecycle.observed` 来自 App Server 的 Codex `thread/read` / Trae lifecycle reconciler，事件结构包含 thread、panel、pane 和 observed status，却不包含 terminal preparation `operationId`。

本轮 guard 先计算 `operationGenerationTracked=true` 与 `operationIdentityMatched=false`，随即在第 136 行返回 `ignored`；第 150 行才把 caller 已验证的 `currentThreadIdentityMatched` 纳入身份判断，因此永远不可达。generation 只会被下一次失败 preparation 或 session/panel 全量清理删除，正常当前 thread 的 lifecycle compensation 在 agent 生命周期内持续失效。

独立生产函数反例使用 current thread/provider、正确 panel/pane、`currentThreadIdentityMatched=true`、无 operationId 和已跟踪 generation：直接 `processTerminalAgentHook` 返回 `ignored`；再通过 `handleAgentLifecycleEvent` 投递同一 idle observation，`TerminalStateService.handleAgentHook` 调用次数仍为 0，panel 保持 `agent_running/codex`。

影响：直接 hook 仍正常到达时 happy path 可通过，但 App Server reconciler 正是直接 hook 缺失、状态漂移或 provider lifecycle 与投影不一致时的补偿源；屏蔽它会让真实完成/运行状态无法收敛。

定位：`backend/src/terminal/agent-hook-processor.ts:118-151`；受影响消费者 `backend/src/app-server/handlers/agent-lifecycle.ts:43-62`；无 operationId 的生产者 `app-server/src/agent-thread-status-reconciler.ts:218-265`。

修复方向：operation generation 必须拒绝未经证明的 stale/missing-operation hook，同时允许已经由独立可信链路证明为 current thread/provider 的 lifecycle observation。需要在 guard 设计中显式区分 direct hook operation identity 与 reconciler current-thread identity，且新增生产消费者用例，断言 current matched lifecycle 可 recorded、错误 thread/provider 仍 ignored、上一轮 stale operation 反例继续零副作用。

稳定 invariant：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

verificationMode：`runtime`。

## 已关闭部分与回归检查

- command 提交成功后 `releasePanelAgentPreparation` 只释放 single-flight，current generation 继续保留；上一轮 old-operation/old-thread Stop 反例已在 code worker 的同 scenario Before/After 中从污染状态变为 ignored。
- 当前 operationId 的 running/idle hook 在 prepare 返回后可 recorded，stale operationId hook ignored，metadata 前后不变。
- command 未提交、取消与失败路径通过 `endPanelAgentPreparation` 清理本次 generation；`clearPanelsForSession` 与 `destroySession` 清理 session 下两张 map。
- fixed 10000ms delay、existing-panel respawn、panel single-flight 与 CLI compatibility 不在本增量中发生行为回归。
- 上述部分修复不足以把 invariant 标记为 resolved，因为 current-thread reconciliation consumer 被同一 guard 阻断。

## 验证

- `pnpm agent-team:verify-review-checkpoints`：exit 0；现有 checks 覆盖 current operation hook 成功、stale/missing direct hook 拒绝，但没有通过 `handleAgentLifecycleEvent` 覆盖 current-thread compensation。
- `pnpm --filter @runweave/backend typecheck`：exit 0。
- `pnpm --filter @runweave/backend lint`：exit 0。
- 定向生产函数 probe：`directStatus=ignored`、`currentThreadIdentityMatched=true`、`operationId=null`、`operationGenerationTracked=true`、direct 与 lifecycle handler 后 `handleCalls=0`、final panel state 仍为 `agent_running/codex`。
- `git diff --cached --check`：exit 0。
- `behavior_verify`：未执行；本轮是独立 code review gate。

## Findings

- P1 open：`terminal.agent-bootstrap-operation-lifecycle-boundary`，`verificationMode=runtime`。
- `remainingFindings`：1。
- `resolvedFindings`：0；上一轮直接 stale-hook 反例虽已修复，但同一 invariant 尚未完整关闭。
