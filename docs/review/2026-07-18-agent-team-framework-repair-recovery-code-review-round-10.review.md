# Agent Team 框架修复与重启恢复 Code Review（Round 10）

## 结论

未通过 `AGT-REVIEW-GATE`。发现 1 个未修复 P1：`continueFrameworkRepair` 在持久化新的 dispatch 之前先把可执行 prompt 投递给 Worker。若随后 Run 写入失败，持久状态仍为 `blocked`，但 Worker 已按新 dispatch 执行；重试会再次派发，造成重复执行，并使先前 outbox 无法按持久 dispatch 可靠消费。

## P1

### continue 的 dispatch 投递与持久化顺序会产生不可恢复的重复执行

- 定位：`backend/src/agent-team/service-framework-repair.ts:160-192`。
- 风险：`submitWorkerDispatchPrompt(...)` 成功后才调用 `updateRun(...)`。后者失败时 API 返回错误，Run 仍保存为 `frameworkRepair.result="blocked"` 且没有新 `activeWorkerDispatch`，但目标 Worker 已收到带 fresh dispatchId 的完整 prompt。再次 continue 会生成并投递另一个 dispatch；前一次 Worker 的 outbox 又不匹配持久 Run，造成并发重复执行、结果无法可靠归属。
- 受影响 Case：ATFR-003 要求“投递成功后”才能恢复为 `running` 并使用一个可追踪的新 dispatch；ATFR-004 要求失败后可安全重试。这里投递已成功而持久化失败时，两个状态观察者得到相互矛盾的事实。
- 复现确认：静态合同确认。Round 10 执行的 `pnpm agent-team:verify-framework-recovery` 只覆盖投递抛错（ATFR-004）和投递成功后写入成功（ATFR-003）；其 `submitWorkerDispatchPrompt` 成功 stub 没有让紧随其后的 `updateRun` 失败，故未覆盖该窗口。
- 修复方向：改成可恢复的两阶段协议。先持久化包含 fresh dispatch 的 pending 状态，再投递；投递失败时持久化回滚/可重试状态。或者在持久化失败时提供已投递 dispatch 的确定性补偿与去重。不能在 durable dispatch 之前让 Worker 得到可执行 prompt。

## 已执行检查

- `pnpm agent-team:verify-framework-recovery`：21 项通过；未覆盖上述“投递成功后持久化失败”分支。
- `pnpm typecheck`、`pnpm lint`、`git diff --check`：均通过。

本轮保持只读；除本报告和指定 pane-scoped outbox 外未修改实现。
