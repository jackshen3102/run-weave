# Agent Team Completion Outcome 与 Follow-up Work Item 两阶段计划

## 问题

当前 persisted acceptance status 只有 `pass | fail | pending`，而 worker 已能报告 `skipped`。结构化
skip 保存在 `lastRunStatus/skip/evidence`，但人工 `/complete` 没有复用自动完成条件，可以把仍有
pending/skipped Case 的 Run 直接写成 done。

## 第一阶段：统一 completion 语义与人工 Case 裁决

本阶段解决三个事实错误：

1. Case 的最新观察明确为 `pass | fail | skipped`；pending 表示没有完成观察。
2. 自动完成和 `/complete` 使用同一个 completion evaluator；未裁决的 skipped 不能完成 Run。
3. 模型 observation 不是最终否决权；人工可确认环境问题或 Case 不适用，解除当前 Run 的 Case 义务。

### 合同

- 保留旧 `AgentTeamAcceptanceStatus`，不扩展 wire enum。
- `latestObservation?: { outcome; dispatchId; recordedAt }` 保存完成观察。
- `acceptanceDecisions` 追加保存人工 disposition，并绑定完整 observation 快照。
- `completionOutcome` 只描述 done Run：`succeeded | completed_with_exceptions`。
- `completionHistory` 在 done Run 被 refresh 重开时保留旧结果。

### 唯一完成条件

全部满足才可进入 cleanup：

- phase 为 executing，且存在 acceptance。
- 所有产品 Case 最新观察为 pass，或存在绑定当前 observation 的人工 disposition。
- Code Review gate 为 pass。
- 没有 pending finding、repair cycle、blocked framework repair 或 active dispatch。
- 最新 checkpoint 已 final review。

cleanup 成功后才能写 done/outcome。`/complete` 被阻断时返回 409，必须保持 cleanup 调用数 0、Run
写入数 0。

### 第一阶段文件边界

- 共享合同：`packages/shared/src/agent-team-run-contract.ts`、`packages/shared/src/agent-team.ts`。
- observation 写入/清空：`loop.ts`、acceptance refresh、serial dispatch、recheck/completion recheck。
- completion：`service-completion-policy.ts`、`service-round-execution.ts`、`service-lifecycle.ts`。
- 人工裁决：Agent Team route/service、终端 Agent Team 面板和 acceptance evidence 展示。
- 历史只读兼容：`service-context.ts` 三个 Run 读取入口；GET 不落盘。

Activity、export、Work History 和 failed/cancelled outcome 不在此 patch；它们只能在核心状态机独立
验证后逐个接线。

### 第一阶段验收

- `pnpm testplan:validate docs/testing/agent-team/agent-team-completion-outcome.testplan.yaml`
- `pnpm agent-team:verify-completion-outcome`
- `pnpm agent-team:verify-control-plane`
- `pnpm agent-team:verify-fixture-lifecycle`
- `pnpm typecheck`
- `pnpm lint`

## 第二阶段：真正的 Follow-up Work Item

第一阶段真实行为验收通过后才设计和实现。第二阶段不能提前向共享合同写入 `follow_up` 类型或 API。

最小必要属性：稳定 work item ID、source Run/Case、不可变 skip observation、合同 digest、独立状态与
transition history。verified resolution 必须匹配同项目、同 sourceCaseId、同 acceptance text digest、
同 testCaseSha256 的 fresh pass。

Work item 不能把 source Case 改成 pass，不能替代 Code Review/final review/cleanup，也不能由当前共享
bearer token 冒充真人裁决。创建与 source Run 义务转移必须单次原子持久化。

## 停止条件

出现任一项立即撤回对应阶段：

- 自动与人工完成没有调用同一 evaluator。
- 未裁决的 skipped 或 active dispatch 可以进入 cleanup/done。
- 人工 disposition 会改写 observation，或新 observation 继续沿用旧 disposition。
- blocked complete 会写 Run 或触发 cleanup。
- GET 会改写历史 Run。
- 第二阶段 work item 无法绑定 observation dispatchId 与合同 digest。
