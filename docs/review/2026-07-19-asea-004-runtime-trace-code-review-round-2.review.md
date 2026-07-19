# ASEA-004 RuntimeTrace 独立代码复审 Round 2

## 结论

不通过。Round 1 的“新增其他候选导致既有 revision 翻桶”和 run-wide outcome 广播已修复，但两个原 invariant 都没有完整闭合：assignment 仍以 `revisionId` 而非稳定 `assetId` 为键，同一资产换 revision 会翻桶；带已暴露 Memory 的 code outbox 省略 `evolutionFeedback` 时仍被静默接受，RuntimeTrace 不会产生 Agent feedback。保留 2 条 blocking P1，并复用原 invariantKey。

## 审查边界

- Dispatch：`70fc925c-3379-4a7a-96c9-83c53a4fe376`
- Run：`atr_dd8353fe_20260719020754`，Round 2。
- `reviewTarget=null`、`reviewCheckpointMode=disabled`；以两个 repair cycle、Round 2 Code Worker `fixVerifications` 和当前 Evolution 增量为边界。
- 当前工作树另有 Agent Team 生命周期相关改动，本轮未修改、未纳入 ASEA-004 结论。

## Findings

### P1：assignment 仍以 revisionId 为键，同一 asset 换 revision 会翻桶

`backend/src/evolution/injection/memory-provider.ts:69-80` 已从集合级 hash 改为逐 revision hash，因此新增 `rev-b` 不再改变 `rev-a`；但 hash 输入仍是 `revisionId`。`CandidateAsset` 明确区分稳定 `assetId` 与 `revisionId`，同一资产产生新 revision 后会重新分桶，仍违反 `ASEA-004` 的“同一 run/asset assignment 幂等”。

review harness 保持 `learningScopeId`、`runId`、policy revision 和 `assetId=asset-a` 不变：`rev-a-1` 为 canary/hash `08c277...`，替换为 `rev-a-2` 后变为 control/hash `3e8c8f...`。修复方向是以稳定 `assetId` 计算实验 bucket，同时把 revisionId 作为当次检索/暴露审计字段；revision 更新不能改变同一 run/asset 的实验身份。

### P1：缺失 evolutionFeedback 的 canary code outbox 被静默接受

`backend/src/agent-team/prompt-builders.ts:89-95` 要求使用 Evolution Context 时必须填写三态 feedback，但 `backend/src/agent-team/outbox-resolver.ts:290-319` 会把缺失/非法值规范化为 `null`，`backend/src/agent-team/service-completion.ts:489-505` 又仅在字段存在时记录，没有协议纠正或缺失事件。

review harness 为 dispatch d1 建立已暴露 `rev-a` 的 canary trace，再提交没有 `evolutionFeedback` 的有效 code outbox：normalizer 接受 outbox，`normalizedFeedback=null`，最终 `agent_feedback` 事件数为 0。修复方向是在 code dispatch 确有 exposed revision 时把 feedback 设为消费合同必填；缺失或引用不匹配 revision 应触发协议纠正，不能静默完成。

## 已确认的部分修复

- 同一 `rev-a` 前后新增其他候选时，逐 revision assignment 保持一致。
- `recordForDispatch` 只把 d2 review 写入 d2 trace；d1 无事件。
- adopted feedback 只命中暴露对应 revision 的 d2 trace，伪造的未暴露 revision 被拒绝。
- feedback detail 包含 `advisoryOnly=true`，没有进入 promotion 判定。

由于上述两个稳定 invariant 仍有可执行反例，本轮不把它们写入 `resolvedFindings`。

## 验证

- `pnpm evolution:verify-activation`：通过。
- `pnpm testplan:validate docs/testing/evolution/agent-self-evolution-activation.testplan.yaml`：通过，7 条 required Case。
- `pnpm typecheck`：通过，9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm --filter @runweave/shared build && pnpm --filter @runweave/backend build`：通过。
- `git diff --check`：通过。
- `asea-004-stable-asset-revision-change` review harness：复现同一 asset 换 revision 后 canary → control。
- `asea-004-run-wide-outcome-fanout` review harness：原 fanout 场景通过，d2 精确命中 1 条 trace。
- `asea-004-feedback-omission-silently-accepted` review harness：复现 outbox 被接受但 feedback 事件为 0。

## 残余风险

本轮是结构性 code review，没有把内存 harness 冒充真实 Agent Team canary 行为通过。两个 P1 修复后仍需 behavior worker 用多个真实 code task 验证 control/canary、后续 review/behavior、repair、用户纠偏与完成结果。
