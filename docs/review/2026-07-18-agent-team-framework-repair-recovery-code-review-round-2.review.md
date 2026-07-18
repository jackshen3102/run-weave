# Agent Team 框架修复与重启恢复代码复审（Round 2）

## 结论

未通过 `AGT-REVIEW-GATE`。Round 1 的两处直接缺口已有修复：fresh dispatch 已复制 `repairKeys`，rerun 也增加了已创建 pane 与 successor branch 的回滚。但是两个稳定 invariant 都没有完全闭合，review harness 仍复现 2 个 P1。

## 审查边界

- Dispatch：`82270d58-27ba-4612-84e2-695fc9faf7ea`
- Run：`atr_a07db00d_20260717170123`，round 2
- 修复目标：`framework-repair.continue-preserves-repair-keys`、`framework-repair.rerun-failure-is-rollback-safe`
- Code Worker 最终交接：dispatch `21d12472-e8f8-453a-ba82-026e7abf15b7`
- `reviewCheckpointMode=disabled`，本轮 `reviewTarget=null`；以两个 backend repair cycle、Code Worker outbox 和对应源码 diff 为边界。
- 排除与本 Run 无关的 `worktree-terminal-context` 文档改动。

## 阻断发现

### P1：continue 仍未向 resumed code worker 交付 repair handoff 合同

`continueFrameworkRepair` 现在会把旧 dispatch 的 `repairKeys` 复制到 fresh dispatch（`backend/src/agent-team/service-framework-repair.ts:129`），但 `buildFrameworkRepairContinuePrompt` 只输出 task、Case 和通用 outbox schema（`backend/src/agent-team/prompt-builders.ts:158`），没有输出 repairKey、invariant、`$toolkit:reproduce-before-fix` 门槛或 `fixVerifications` schema。

可执行 harness 构造了带当前稳定 repair key 的 blocked code Run，再调用真实 prompt builder；输出为：`containsRepairKey=false`、`containsFixVerificationsContract=false`、`containsReproduceBeforeFix=false`。与此同时 Backend 会依据 fresh dispatch 的非空 `repairKeys` 强制校验 code handoff（`backend/src/agent-team/repair-loop.ts:375`）。因此 resumed code worker 会在不知道修复协议的情况下工作，完成后必然面临不可事后补写的交接错误，continue 无法可靠恢复该现场。

修复方向：framework continue 的 code 路径应复用 bounce prompt 的 repair-cycle/Before/After/fixVerifications 合同生成能力，至少逐项下发 backend-owned repairKey、invariant、source reproduction/evidence refs 和交接 schema；行为脚本必须直接断言 prompt 包含这些内容。

### P1：rerun 仍会丢弃自清理失败 pane 的恢复身份

`applySplit` 已能回滚此前成功返回并登记到 `createdPanels` 的 pane（`backend/src/agent-team/service-execution.ts:90`）。但正在失败的 `createTerminalPanelSplit` 如果自身 cleanup 不完整，会按既有合同抛出 `details.partialPanel={panelId,tmuxPaneId}`（`backend/src/terminal/application/panel-split.ts:214`）。该异常随即被 `createAgentTeamPanelError` 包装为仅含 `{runId,role}` 的 details（`backend/src/agent-team/service-run-policy.ts:111`）；失败 pane 没有成功返回，也不会进入 `createdPanels`，因此新增 rollback 无法定位它。

可执行 harness 用真实 `TerminalPanelError` 和 `createAgentTeamPanelError` 验证：source 中存在 `partialPanel`，wrapped error 中变为 `null`。这意味着 cleanup 双重失败时仍可能遗留不可追踪的 successor pane，违反 ATFR-007 的失败无半成品要求。

修复方向：保留并传播 `partialPanel` 详情；`applySplit` catch 应把它纳入本次资源补偿，或调用专用 recovery helper。新增“第二个 pane 注册失败且内部 kill 失败”的 harness，断言最终 pane/workspace/manager 均无 successor 残留。

## 验证结果

- continue prompt review harness：复现，三项修复合同标识均为 `false`。
- partialPanel propagation review harness：复现，source identity 存在而 wrapped identity 为 `null`。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-framework-recovery`：通过，16 项；未覆盖上述两条复现路径。
- `git diff --check`：通过。
- 未执行 Playwright：本轮发现均为结构性状态机/错误合同问题，真实 UI 行为仍由 behavior_verify 负责。

## 剩余风险

两个 round 1 invariant 均是部分修复，不能写入 `resolvedFindings`。在 prompt 修复合同和 partial pane 补偿闭合前，不应通过 Code Review 门禁。
