# Agent Team 控制面可靠性剩余优化评审

## 评审基线

- 计划：`docs/plans/2026-07-18-agent-team-control-plane-reliability-optimization.md`
- SHA-256：`b6fc27540e0a11d841932d556bc0b71ac9335aaee358b72d9a99be1ca98a5f49`
- 模式：计划评审，只读；未修改计划、源码、配置或测试。

## 结论

PR 2 的 fixture 所有权与回收方向已经实现，但当前工作区正处于 stash/merge 冲突状态，不能直接继续叠加新实现。稳定基线后，仍值得做的主体是 PR 1、PR 3、PR 4；推荐顺序不变：先恢复控制面原子性，再改 repair 合同，最后改调度和 UI。

## 发现与剩余优化

- **P0 实施前置：先解决当前冲突并冻结基线。** `packages/shared/src/agent-team.ts`、`service-context.ts`、`service-execution.ts`、`service-lifecycle.ts`、`service-support.ts`、CLI、前端执行区和 `package.json` 当前为 `UU`；在此状态继续实现会把“上游代码”和 fixture stash 混成不可验证的第三份实现。方向：先完成冲突归属审计，确认 PR 2 patch 完整，再以干净 diff 启动下一项。
- **P1 Dispatch completion 幂等顺序和原子 transition。** 计划 6/PR 1（计划:182-205）。当前 `service-completion.ts:113-161` 仍先要求 active dispatch，再检查 consumed receipt；`service-execution.ts:472-492` 先写入 active dispatch 为空的折叠结果，再另一次写入下一 dispatch。风险是迟到 completion 进入机械 Human Gate，且崩溃窗口可留下角色/dispatch 空窗。方向：先按 outbox dispatchId 命中 receipt，并用统一 transition builder 一次写入 receipt、fold、下一角色和下一 dispatch。
- **P1 同线程 protocol correction 自动恢复与 blocked/operator 状态。** 计划 5.1、6/PR 1（计划:63-109、182-205）。当前 `service-worker-dispatch-support.ts:161-170` 把 `agent_running` 当作 readiness 失败，`service-repair-protocol.ts:81-123` 投递失败后直接进入 `need_human`。方向：持久化 pending delivery，锁定原 thread identity，idle 后重送同 dispatch；identity 丢失或 deadline 到期进入 `blocked`，owner=operator，不冒充产品裁决。
- **P1 稳定 repair contract 与 source verifier 回路。** 计划 6/PR 3（计划:235-260）。当前 `repair-loop.ts:417-419` 仍逐字比较 invariant，且 `repair-loop.ts:445-466` 的 not_reproduced challenge 只覆盖 code_review。方向：backend 对 canonical repair payload 生成 contractId；challenge 按 cycle.sourceRole 回到原 code_review 或 behavior_verify，并保持原 scenario/case 范围。
- **P1 结构化 skip、依赖闭包和局部续跑。** 计划 6/PR 3（计划:241-256）。当前 shared 合同仍是 `lastRunStatus + skipReason` 自由文本，`service-execution.ts:379-444` 将所有 pending+skipped 统一视为环境阻塞并进入 `need_human`。方向：引入 blocked_by_case/fail_fast/environment/not_applicable 与 blockerCaseIds；只对可恢复依赖计算最小传递闭包，不重跑已通过且无依赖的 Case。
- **P1 scopeAssessment 必须先于 repair attempt。** 计划 6/PR 3（计划:241-250）。当前 `repair-review-contract.ts:63-146` 校验 reproduction/invariantKey，但没有 scopeAssessment；因此 out_of_scope/ambiguous finding 仍可能先消耗修复预算。方向：P0/P1 首次进入 repair 前强制提交 scopeAssessment；out/ambiguous 在 attempts=0 进入人工裁决，明确 in_scope 才建立 repair dispatch。
- **P2 critical-path 真实行为 smoke 前置。** 计划 6/PR 4（计划:262-285）。当前 `service-acceptance-policy.ts:25-36` 对 behavior_verify 仍返回全量非 review Case，没有 critical 子集调度。方向：仅对显式 `critical-path` 标签启用 code → critical smoke → review → remaining behavior；无标签 Run 保持旧顺序。
- **P2 结构化事件应复用 Activity Facts，避免双事实源。** 计划要求同时新增 `AgentTeamRun.events` 和 Activity event（计划:176-178、268-273）。当前 `activity-events.ts:5-165` 已有结构化事件管道，而 `agent-team-history-model.ts:30,127-133` 仍解析 logs。更简单方向：给现有 Activity event 增加 transitionId/reasonCode/purpose，并让 Work History 以 Activity Facts 为权威；Run JSON 只保留当前 recovery/blocker 和必要 receipt。这样避免 Run JSON 无界增长及 Run.events/Activity 双写分叉；代价是单文件离线 export 需要同时投影该 Run 的 Activity Facts。
- **P2 UI 明确区分 recovering、blocked、need_human。** 计划 6/PR 4（计划:262-283）。当前 `terminal-agent-team-panel-model.ts:70-90,121-150` 仍将 need_human/escalated 统一显示为“需要人工”。方向：状态、通知和允许动作都按 owner 分类；自动恢复不发送 Human Gate，operator blocker 不展示 scope disposition，人类裁决不能被自动越过。
- **P2 建立分场景 verifier 总入口。** 计划 7（计划:287-305）。当前只有 `scripts/verify-agent-team-fixture-lifecycle.mjs`，尚无 `agent-team:verify-control-plane` 和 dispatch/repair/scheduling 分场景脚本。方向：先抽共享 harness，再逐个接入 ATFR-011～019、023～025；不要把现有 fixture verifier机械重写进一个更大的单文件。
- **P3 历史 fixture 显式 cancelled 迁移。** 计划 11（计划:359-365）。能力全部稳定后，再生成精确清单由人确认并逐项 cancel；不按时间、project 或 running 状态猜 owner，也不与功能 PR 混提。

## 推荐实施顺序

1. 解决当前 `UU` 冲突并重新验证 PR 2；把 fixture cleanup 的临时 `need_human` 迁移接口留到 PR 1。
2. PR 1：completion 幂等顺序、原子 transition、pending delivery、blocked/operator。
3. PR 3：repairContractId、source verifier、structured skip、scope 前置。
4. PR 4：critical smoke、事件投影、UI 分类。
5. 最后补统一 verifier 和人工确认的历史 fixture 迁移。

## 残余风险

- 计划文档由并发流程短暂删除后又恢复；本报告只对上述 SHA 有效。
- 当前冲突未解决，不能把冲突工作树中的 typecheck/lint 结果作为任何 PR 的完成证据。
