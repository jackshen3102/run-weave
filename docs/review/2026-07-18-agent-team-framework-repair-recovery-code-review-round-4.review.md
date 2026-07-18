# Agent Team 框架修复与重启恢复 Code Review（Round 4）

## 结论

未通过 `AGT-REVIEW-GATE`。Round 3 的精确场景 `agt-r3-rerun-successor-persistence-atomicity` 已关闭：successor 首次持久化失败时，新建 pane 会被回滚。但同一 `framework-repair.rerun-failure-is-rollback-safe` invariant 在下一提交边界仍存在 P1：successor 已持久化并运行后，如果旧 framework-repair Run 的最终关联写入失败，调用返回失败，却同时留下 blocked 旧 Run、running successor 和 live Worker pane。

## P1 阻断

### 旧 Run 最终关联写入失败会留下未关联的运行中 successor

- invariantKey：`framework-repair.rerun-failure-is-rollback-safe`
- 定位：`backend/src/agent-team/service-framework-repair.ts:271`、`backend/src/agent-team/service-framework-repair.ts:297`、`backend/src/agent-team/service-framework-repair.ts:312`。
- 影响：用户收到 rerun 失败，但旧 Run 仍是 `frameworkRepair.result=blocked` 且 `successorRunId=null`；与此同时，新 Run 已持久化为 `running`、已派发 code Worker，并保留 live pane。再次 rerun 会再创建一个新 successor，形成重复执行与不可追踪资源。
- 原因：`applySplit` 成功返回即已提交 successor Run 和 pane 所有权；随后更新旧 Run 的 `updateRun` 位于任何补偿/提交协议之外。一旦该写入失败，代码既不把已成立 successor 作为成功结果返回，也不撤销 successor、pane 和可能的新 Git branch。
- 修复方向：把 rerun 定义为跨 predecessor、successor、pane、Git branch 的显式提交协议。优先让旧 Run 先持久化一个可恢复的 pending successor transaction，再创建并提交 successor；或者在旧 Run finalization 失败时执行可验证的 successor/pane/branch 补偿。不能继续仅扩大 `applySplit` 内部 catch。

## 已确认修复

`agt-r3-rerun-successor-persistence-atomicity` 原样复跑通过：`fixture successor write failure` 保持明确，`splitPaneStillLive=false`、`rollbackKillCalls=["%2"]`、`runningWorkerPanels=[]`。这证明 `applySplit` 的首次 successor 写入边界已修复，但不覆盖 `rerunFrameworkRepair` 随后的 predecessor finalization。

## 独立复现

场景：`agt-r4-rerun-predecessor-finalization-atomicity`

1. 使用真实 LowDB store、`AgentTeamService.rerunFrameworkRepair`、真实 `applySplit` 和可观测 tmux harness 创建 blocked 旧 Run。
2. 允许 `applySplit` 首次写入 successor 成功并完成 Worker pane 创建。
3. 令下一次 `runStore.writeRun`（旧 Run 的 `result=rerun` / `successorRunId` finalization）抛出 `fixture predecessor finalization failure`。
4. 检查 API 异常、两个 Run 的存储状态、live pane 和 rollback kill。

实际输出：

```json
{
  "error": "fixture predecessor finalization failure",
  "oldResult": "blocked",
  "oldSuccessorRunId": null,
  "persistedSuccessors": [
    {
      "status": "running",
      "activeWorkerRole": "code",
      "predecessorRunId": "atr_r4_blocked"
    }
  ],
  "liveWorkerPanes": ["%2"],
  "rollbackKillCalls": []
}
```

## 门禁

- `pnpm agent-team:verify-framework-recovery`：18 项通过；新增检查只覆盖首次 successor 持久化失败。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

## 范围说明

本轮仅进行代码审查和可执行 review harness 验证，没有修改被审查的实现、配置或测试。
