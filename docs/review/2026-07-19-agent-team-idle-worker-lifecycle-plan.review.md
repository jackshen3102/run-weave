# Agent Team idle worker 生命周期修复计划评审

## 结论

**Fail：当前方案存在 2 条 blocking P1，不能按原方案直接实现。**

问题定义成立，现场也已证明真实 `Stop` 到达后被 `inactive_agent` 拒绝；但“current identity 为空时，仅凭 Pane + provider + lastThreadId 接受 Stop”缺少 turn 级时序身份，会把迟到旧 Stop 错当成当前轮完成事件。

## 评审范围

- `docs/plans/2026-07-19-agent-team-idle-worker-lifecycle-repair.md`
- `docs/testing/agent-team/agent-team-idle-worker-lifecycle.testplan.yaml`
- `backend/src/terminal/agent-hook-processor.ts`
- `backend/src/app-server/handlers/agent-lifecycle.ts`
- `app-server/src/agent-thread-status-reconciler.ts`
- Hook bridge 与 `AgentHookStateRequest` 当前身份字段
- 当前 `dd8353fe` App Server/Backend 事件证据

## Findings

### P1 阻断：lastThreadId 不是 turn identity，迟到旧 Stop 可能把新一轮运行误标为 idle

计划在 `docs/plans/2026-07-19-agent-team-idle-worker-lifecycle-repair.md:30-40,44-51` 规定：current identity 为空时，只要 Pane、provider 与 lastThreadId 匹配，就接受 `Stop`。

这组条件不能区分同一 Codex thread 内的不同 turn。现场 main Pane 已连续出现多组 `UserPromptSubmit/Stop`，它们复用同一个 threadId `019f7849-3cb6-7241-bc99-0094aaad85e5`；operationId 同时为 `null`。当前 `AgentHookStateRequest` 也没有 `turnId`、源事件时间或单调 sequence，Hook bridge 为每次投递新建随机 activityEventId，无法用于排序。

因此存在以下合法竞态：上一轮 Stop 延迟；下一轮 UserPromptSubmit 已开始，但 current metadata 在 reconcile 窗口内为空；旧 Stop 的 Pane/provider/lastThreadId 全部匹配，方案会将新一轮错误改为 `agent_idle`。Agent Team 随后可能把 bounce prompt 送进正在运行的 turn，造成排队、交错上下文或错误 outbox 归因。

修复方向：不要扩大 raw Stop 的 last-thread 信任范围，除非先引入可比较的 turnId 或单调事件 watermark。更简单的方向是复用现有 `AgentThreadStatusReconciler`：它读取 Codex 当前 thread status，并在记录 observation 前确认 App Server `lastEventId` 未变化，再以 `lastEventId + lifecycle cursor` 去重。修复 `agent-lifecycle.ts` 的 Pane owner/last-thread 映射，让该“当前状态观测”负责 stale state 自愈，而不是重放历史 Stop。

### P1 阻断：当前现场直接重放旧 Stop 继承同一时序缺口

计划 `docs/plans/2026-07-19-agent-team-idle-worker-lifecycle-repair.md:106-108` 要求上线后重放原 Stop。重放时 Backend 只看新的到达顺序，无法证明该 Stop 晚于还是早于最近一次 UserPromptSubmit；若现场期间产生新 turn，旧 Stop 会覆盖新状态。

修复方向：现场恢复前通过 current-status reconciler 重新读取 thread 的即时状态；只有观测结果仍为 idle 且对应 App Server lastEventId 未变化时，才生成新的 lifecycle observation。不要把历史 raw Hook 当作当前事实重放。

### P2 一般：方案修复最终症状，但尚未闭合 current metadata 被提前清理的原因

计划 `docs/plans/2026-07-19-agent-team-idle-worker-lifecycle-repair.md:20` 已把 activeCommand 短暂清空导致 metadata 清理标为推测，后续实现步骤却没有继续验证 `panel-workspace.ts` 的 `shouldClearAgentThreadMetadata`、activeCommand source 与 recent activity/grace 时序。

如果真正回归是运行中的 Codex 被 tmux reconcile 短暂识别为非 Agent，那么即使本次 idle 被补偿，运行中状态、下一轮 current identity 和其它 worker 仍可能反复漂移。

修复方向：实现前增加一个 verifier，复现 Agent 启动后 `paneCommand=node`、activeCommand source 波动但 Codex thread 仍运行的路径；确认 current identity 不会在真实 Stop 前被错误清空。若能修复该源头，应优先保留 current identity 到可信 Stop，再把 lifecycle reconciler作为丢 Hook 的补偿层。

### P2 一般：测试遗漏“同 thread 新 turn”边界

`docs/testing/agent-team/agent-team-idle-worker-lifecycle.testplan.yaml` 只覆盖“已经存在另一 current thread”时拒绝旧 Stop。它没有覆盖更危险的等价类：新 turn 与旧 turn 使用同一 threadId，且新 UserPromptSubmit 与迟到 Stop 发生重排。

修复方向：新增独立 required case，固定同一 threadId，按 `Stop(turn A)` 延迟到 `UserPromptSubmit(turn B)` 之后的顺序投递；确认 turn B 保持 running，旧 Stop 不触发 idle 或 bounce。

## 推荐替代方案

### 方案 A：复用 current-status reconciler（推荐）

1. 继续保持 raw Stop 的现有 fail-closed 规则，不新增 lastThread Stop 特权。
2. 修复 `backend/src/app-server/handlers/agent-lifecycle.ts:43-52`：事件有明确 Pane 时，identity owner 必须是该 Pane；不能因为 current identity 为空而回退到父 Session。
3. 让 App Server `AgentThreadStatusReconciler` 的 current Codex status observation 在 Pane last-thread 精确匹配时完成 idle/running 自愈。
4. 保留 reconciler 现有 `lastEventId` 再确认、短窗口 defer 和 lifecycle cursor 去重；补充同 thread 多 turn 重排测试。
5. 继续追查并修复 current metadata 被提前清理的源头。

优点：复用已有当前状态读取、事件顺序和补偿能力；影响面集中在 compensation path，不放宽 direct hook、completion fallback 和所有普通 Terminal 的安全边界。

代价：状态收敛依赖 reconciler 周期，不是 raw Hook 到达即同步完成；应明确最大收敛时间并在 bounce 前允许一次有上限的 current-status reconcile。

### 方案 B：给 Hook 增加 turn 级顺序身份

若要求 raw Stop 立即成为权威，则需要在 Hook/App Server/Backend 合约中传递 provider 可验证的 `turnId`，或至少传递源端单调 sequence/occurredAt 并在 Pane 持久化 watermark。只有 `Stop` 的 turn/sequence 不旧于当前 running turn 时才允许收敛 idle。

优点：实时且因果关系明确。

代价：涉及 Hook bridge、共享协议、持久状态、双投递去重和兼容迁移，明显超出当前计划宣称的“无共享协议改动”。

## 残余风险

- Codex status reader 的 `notLoaded` 降级到 idle 需要继续保留短窗口 defer，并验证不会在 CLI 启动/恢复阶段误判。
- App Server 与 direct hook 双投递可能产生重复 observation；必须以 event id/cursor 幂等，而不是仅比较最终 state。
- 当前运行 Backend 是 bundled release。修复代码验证通过不等于现场已经使用新逻辑，恢复前必须核对 runtime source identity。

## 验证摘要

- 实时事件证明同一 Codex threadId 跨多轮 `UserPromptSubmit/Stop` 复用，operationId 可为空。
- `AgentHookStateRequest` 当前无 turnId、occurredAt 或 sequence。
- `AgentThreadStatusReconciler` 已具备 current status read、lastEventId 再确认和 cursor 去重能力，可以作为更窄的复用路径。
- 本轮严格只读评审；未修改计划、测试计划或实现代码。
