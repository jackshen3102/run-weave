# Agent Team 框架修复与重启恢复 Code Review（Round 3）

## 结论

未通过 `AGT-REVIEW-GATE`。上一轮 `framework-repair.continue-preserves-repair-keys` 已关闭，`partialPanel` 身份传播的直接缺口也已修复；但 `framework-repair.rerun-failure-is-rollback-safe` 仍有一个可执行 review harness 稳定复现的 P1：Worker pane 创建完成后，如果 successor Run 持久化失败，`applySplit` 不会回滚这些 pane。

## P1 阻断

### successor Run 持久化失败仍遗留已创建 Worker pane

- invariantKey：`framework-repair.rerun-failure-is-rollback-safe`
- 影响：`rerunFrameworkRepair` 会回滚新建 Git branch 并保持旧 Run 阻塞，但已创建的 tmux pane 和 running panel 仍留在原 terminal session。再次 rerun 会使用新的 runId，无法复用这些残留 pane，形成不可追踪的半成品现场。
- 定位：`backend/src/agent-team/service-execution.ts:90`、`backend/src/agent-team/service-execution.ts:160`、`backend/src/agent-team/service-execution.ts:196`、`backend/src/agent-team/service-framework-repair.ts:282`。
- 原因：`createdPanels` 的补偿 `catch` 在 pane 创建循环结束后立即关闭；`this.updateRun(...)` 位于该补偿区之外。真实 Run store 写入抛错时，`applySplit` 直接退出，没有调用 `rollbackCreatedWorkerPanels`。
- 修复方向：把 pane 所有权的补偿边界延伸到 successor Run 成功持久化之前；同时明确持久化成功后的所有权转移点，避免后续异常把已成立的 successor 当作未创建而反向删除资源。

## 已关闭项

### continue 完整交付 repair handoff 合同

`buildFrameworkRepairContinuePrompt` 现在按 fresh active dispatch 的 `repairKeys` 选择 repair cycles，并与 bounce prompt 共用完整合同格式器。独立 harness 确认 repairKey、`fixVerifications`、`$toolkit:reproduce-before-fix` 和第二次修复的 `strategyAssessment` 均存在。

### partial pane 身份可进入外层补偿

`createAgentTeamPanelError` 已保留来源错误的 `partialPanel`、`paneRemoved` 与 `cleanupFailed`，`applySplit` 可将失败 pane 加入统一补偿集合。该直接缺口已关闭，但不代表上面的整个 rerun 原子性 invariant 已关闭。

## 独立证据

- `agt-r3-rerun-successor-persistence-atomicity`：真实 `AgentTeamService.applySplit` 配合 LowDB manager 与可观测 tmux harness，在 `runStore.writeRun` 抛出 `fixture successor write failure` 后输出 `splitPaneStillLive=true`、`rollbackKillCalls=[]`，并保留一个 running Worker panel。
- continue prompt harness：`containsEveryRepairKey=true`、`containsFixVerificationsContract=true`、`containsReproduceBeforeFix=true`、`containsStrategyAssessment=true`。
- partial identity harness：`sourcePartialPanel` 与 `wrappedPartialPanel` 相等，且 `paneRemoved=false`、`cleanupFailed=true` 被保留。
- `pnpm agent-team:verify-framework-recovery`：17 项检查通过；现有 ATFR-007 失败 harness 通过 stub 整体替换 `applySplit`，未覆盖 pane 创建成功后 successor 持久化失败的资源状态。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

## 范围说明

本轮仅进行代码审查与 review harness 验证，没有修改被审查的实现、配置或测试。发现属于结构性异常边界，不以 Playwright 或 UI 截图替代。
