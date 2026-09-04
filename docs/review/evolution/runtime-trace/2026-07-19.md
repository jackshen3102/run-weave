# ASEA-004 RuntimeTrace 独立代码审查

## 结论

不通过。当前实现存在 2 条 blocking P1：control/canary assignment 不是按同一 `run/asset` 稳定分配；后续客观结果按 `runId` 广播到全部 trace，且生产链路没有采集 `adopted/ignored/conflicted` Agent feedback。`ASEA-004` 不能判定为通过。

## 审查边界

- Dispatch：`3b96bb0f-dbf7-4bea-af44-9d48b6f82765`
- Run：`atr_dd8353fe_20260719020754`
- 当前 run 的 `reviewTarget=null`、`reviewCheckpointMode=disabled`；以 `origin/main` 到当前未提交工作树、Code Worker receipt 和 `ASEA-004` 合同为边界。
- 只读检查实现、执行 verifier 和内存态 review harness；未修改实现、配置、测试或测试计划。

## Findings

### P1：分桶哈希以候选集合而非单个 run/asset 为键，候选变化会翻转既有资产 assignment

`backend/src/evolution/injection/memory-provider.ts:69-85,177-190` 把全部 `selectedRevisionIds.join(",")` 放进一个 assignment hash，并为整组候选只生成一个 bucket。只要同一 run 在后续 dispatch 前新增、移除或重排候选，原有资产的 hash 和 bucket 就会变化；这不满足 `ASEA-004` 对“同一 run/asset 的 assignment 幂等”的要求。

review harness 使用相同 scope、run、policy revision 和资产 `rev-a`：第一次仅有 `rev-a` 时得到 `control`；加入 `rev-b` 后再次查询，同一 `rev-a` 变成 `canary`，hash 从 `971797...` 变为 `43ceca...`。

修复方向：以稳定的 `learningScopeId + runId + assetId（或固定 revision 身份）+ policy revision` 独立计算每个资产的 assignment，并在 trace 中保留逐资产 bucket/hash；候选集合变化不能改写既有 run/asset 的 assignment。

### P1：run-wide outcome 广播破坏 dispatch 归因，且生产链路未采集 Agent feedback

`backend/src/evolution/injection/outcome-observer.ts:34-43` 的 `recordForRun` 会把一个后续事件追加到该 run 的所有 RuntimeTrace；`backend/src/agent-team/service-worker-dispatch-support.ts:71-133` 记录 gate、repair、用户纠偏和完成时只传 `runId`，事件 detail 也没有来源 worker dispatch。多轮 code/repair 会让旧 assignment 获得属于新 dispatch 的 review/behavior 结果。

review harness 在同一 run 创建 `trace-d1`/`trace-d2`，记录仅属于 d2 的 review event 后，两个 trace 都出现 `sourceDispatchId=review-for-d2`。此外，生产目录检索只找到 `agent_feedback` 类型声明，没有任何 `adopted/ignored/conflicted` 的采集调用；该事件只在 `scripts/evolution/verify-activation.mjs` 中由 verifier 手工写入。

修复方向：在 code dispatch 与其后续 review/behavior/repair dispatch 之间持久化明确因果边，observer 按 trace/源 dispatch 定向追加事件，并在真实 worker 结果协议中采集 Agent feedback；反馈仍只作为观察字段，不参与单独判效。

## 验证

- `pnpm evolution:verify-activation`：通过，但 verifier 只验证候选集合不变时跨 dispatch hash 相等，并手工调用 observer 写反馈，未覆盖上述生产归因边界。
- `pnpm testplan:validate docs/testing/evolution/agent-self-evolution-activation.testplan.yaml`：通过，7 条 required Case 可解析。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `git diff --check origin/main`：通过。
- assignment review harness：复现同一 run/asset 在候选集合变化后 `control -> canary`。
- outcome review harness：复现 d2 review event 同时写入 d1/d2 trace。

## 残余风险

本轮是结构性代码审查，没有把 verifier 的内存模拟当作真实 Agent Team canary 行为通过证据。修复两条 P1 后仍需由 behavior worker 使用多个真实 code task 重新执行 `ASEA-004`，核对真实 control/canary、后续 code_review/behavior_verify、repair、用户纠偏和完成结果。
