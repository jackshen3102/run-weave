# Agent Team Completion Outcome 主体流程优先级评审

> 后续目标澄清：自动流程可以继续严格，但显式人工裁决必须有权解除对应 Case 的流程阻塞。
> 实现因此收敛为只在人工 Acceptance Case 裁决路径中清理已解决的 repair cycle，并把只关联
> 已解决 Case 的 blocked framework repair 记录为人工继续；未放宽自动 evaluator。

## 判断标准

只判断问题是否会阻塞 Agent Team 主体流程完成，或造成错误完成。说明完整度、代码组织、格式和非阻断审计瑕疵不作为本次阻断项。

## 结论

### P1：残留 repair cycle 可能让已满足产品结果的 Run 静默悬停

`evaluateAgentTeamCompletion` 把任何非空 `loop.repairCycles` 都视为完成 blocker。`applyRound` 在只剩一个未 exhausted repair cycle、没有达到 no-progress 熔断、没有待派发 Case 时，不进入 `done`、`need_human` 或新 dispatch 分支，最终会持久化 `status=running`、`activeWorkerDispatch=null`。

当前正常 folding 会在 behavior Case pass 或 code review finding 消失时清理对应 cycle，但这不能证明该组合不可达：旧 Run、重开 Run或历史残留状态仍可能携带与当前完成事实无关的 cycle。因此它会直接违反“合理人工裁决后不得继续阻塞整体完成”的目标。

定位：

- `backend/src/agent-team/service-completion-policy.ts:122`
- `backend/src/agent-team/service-round-execution.ts:159`
- `backend/src/agent-team/service-round-execution.ts:207`
- `backend/src/agent-team/service-round-execution.ts:331`

建议：completion evaluator 不应让已经没有对应未解决 Acceptance/finding 的残留 repair cycle 阻塞完成。最小方案是仅把仍关联未解决 Case 或 blocking finding 的 cycle 视为 blocker；纯残留 cycle 在完成时清理。

## 非主体流程问题

- `completed_with_exceptions` 对 `out_of_scope/waived` 缺单独否决性测试：属于回归保障缺口。当前 `completionExceptions` 已生成 `finding_disposition`，不构成已确认的运行时阻塞。
- completion policy 单文件职责较多：维护性问题，不影响完成。
- serial-dispatch 缩进：格式问题，且当前工作树已修正。
- legacy outcome id 依赖 `updatedAt`：可能使只读投影的历史 id 不稳定，但不阻塞 Run 完成，按本次标准不处理。

## 最终建议

本轮只修残留 repair cycle 的完成阻断，其余四项不扩大范围。
