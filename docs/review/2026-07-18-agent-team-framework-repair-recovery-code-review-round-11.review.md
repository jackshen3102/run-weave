# Agent Team 框架修复与重启恢复 Code Review（Round 11）

## 结论

未通过 `AGT-REVIEW-GATE`。当前实现仍有 1 个 P1：`continueFrameworkRepair` 在把 fresh dispatch 持久化到 Run 之前，已向 Worker 投递可执行 prompt。若随后 `updateRun` / `runStore.writeRun` 失败，持久 Run 仍是 `blocked`，而 Worker 已开始执行一个不可被 outbox 消费器可靠归属的 dispatch；再次 continue 会投递第二个 dispatch，造成重复执行。

## P1 阻断

### continue 在持久化 fresh dispatch 前投递 Worker prompt

- invariantKey：`framework-repair.continue-persistence-before-dispatch`
- 定位：`backend/src/agent-team/service-framework-repair.ts:160-192`；`backend/src/agent-team/service-support.ts:393-400`。
- 风险：`submitWorkerDispatchPrompt(...)` 成功返回后，才通过 `updateRun(...)` 写入 `activeWorkerDispatch` 和 `frameworkRepair.result="continued"`。`writeRun` 没有补偿或去重；此窗口失败会让 Worker 持有未登记 dispatch，而重试生成另一份 dispatch。
- 产品 Case 影响：违反 ATFR-003 的“可追踪新 dispatch 后恢复原 Run”，也违反 ATFR-004 的“失败后可安全重试、不重复执行”。
- 独立确认：结构性合同确认。现有 `pnpm agent-team:verify-framework-recovery` 的 21 项检查通过，但 ATFR-004 只让 prompt 投递抛错；其成功 stub 不会使紧随的 `updateRun` 失败，故没有覆盖该失败窗口（`scripts/verify-agent-team-framework-recovery.mjs:623-675`）。
- 修复方向：建立可恢复的两阶段协议：先持久化带 fresh dispatch 的 pending/投递中状态，再投递，并对投递失败做可验证回滚；或提供已投递 dispatch 的确定性去重与恢复。不能在 durable dispatch 前向 Worker 发送可执行 prompt。

## 已执行检查

- `pnpm agent-team:verify-framework-recovery`：21 项通过，但未覆盖上述反向失败分支。
- `pnpm typecheck`、`pnpm lint`、`git diff --check`：均通过。

本轮仅新增本审查报告及指定 pane-scoped outbox，未修改被审查实现。
