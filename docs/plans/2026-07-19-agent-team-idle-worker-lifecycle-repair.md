# Agent Team idle worker 生命周期修复计划

## 目标

修复 Agent Team worker 已结束本轮响应并停在 Codex 输入提示符后，Backend 仍把对应 Pane 保留为 `agent_starting`，进而阻断同 Pane bounce prompt 的问题。

完成后的行为必须满足：可信的同 Pane、同 provider、同 thread `Stop` 即使晚于 `activeCommand`/当前 thread metadata 清理到达，也能把 Pane 收敛为 `agent_idle`；错误 thread、错误 provider、跨 Pane 或仍有另一 current thread 的迟到事件继续被拒绝。

## 当前事实与根因

现场 `dd8353fe / code-1 / %76` 已提供完整证据：

- `SessionStart` 于 `2026-07-19T02:08:26Z` 被记录为 `agent_idle`。
- `UserPromptSubmit` 随后被记录为 `agent_running`。
- `Stop` 于 `2026-07-19T02:42:40Z` 携带正确的 `panelId`、`tmuxPaneId`、threadId `019f7821-956e-7590-b8fc-f0e5d65df202` 和原 operationId 到达 Backend，但被 `inactive_agent` 拒绝。
- 此时 Pane 的 current `threadId/threadProvider` 已被清理，只有匹配的 `lastThreadId/lastThreadProvider/lastThreadStatus=idle`；后续 Pane 持久状态为 `activeCommand=codex + terminalState=agent_starting`。

当前 [agent-hook-processor](../../backend/src/terminal/agent-hook-processor.ts) 只允许 `UserPromptSubmit` 用匹配的 last-thread identity 恢复可信身份；`Stop` 不享有同一身份恢复规则。于是结束事件虽然有完整身份，仍会在 current identity 已清理时被当成 inactive。

基于当前代码推测，tmux activeCommand 的短暂清空先移除了 current thread metadata，后续重新观察到 `codex` 时按默认规则回到 `agent_starting`；本次修复不依赖该时序推测成立，而是让已到达的可信 `Stop` 成为最终状态权威。

## 非目标

- 不通过 scrollback、`ready` 文案或提示符文本推断状态。
- 不放宽 Agent Team 的 `agent_starting` bounce 安全门禁。
- 不允许仅凭 `lastThreadStatus=idle` 无条件发送 prompt。
- 不修改 Agent 自进化业务代码、review finding、repair cycle 或 outbox 合同。
- 不新增单元测试文件，不修改共享 API/DTO，不做数据库迁移。

## 行为与安全合同

匹配 last-thread identity 的 `Stop` 只有同时满足以下条件才可信：

1. 通过 `panelId + tmuxPaneId` 唯一解析到同一 running Pane。
2. Hook 的非空 threadId 等于该 Pane 的 `lastThreadId`。
3. Hook provider 等于该 Pane 的 `lastThreadProvider`。
4. Pane 当前没有另一组 `threadId/threadProvider`；若存在 current identity，只能由 current identity 规则判断。
5. Hook 类型是 `Stop`；该放宽不适用于任意 tool/completion 文本。

可信 `Stop` 的结果为：Pane `terminalState=agent_idle`，last-thread 状态和时间更新为该 `Stop`，current thread metadata 保持为空，聚合 Session 状态按所有 Pane 重新计算。任一身份条件不满足时返回 `ignored`，且 Pane、Session、operation generation 和事件流均不得变化。

## 实施步骤

### 1. 统一 shared processor 的 last-thread Stop 身份判定

修改 `backend/src/terminal/agent-hook-processor.ts`：

- 将当前仅面向 resume `UserPromptSubmit` 的 `resumedLastThreadIdentityMatched` 收敛为语义明确的 trusted last-thread identity 判断。
- 在 current thread identity 为空时，同时允许匹配 last-thread identity 的 `UserPromptSubmit` 和 `Stop` 进入已有可信路径。
- 保留 operation generation、provider、Pane identity、current-thread 冲突和 `shell_idle` 等现有拒绝规则；不要增加基于 terminal 文本的 fallback。
- `Stop` 继续通过现有 `resolveAgentHookTerminalState`、`updatePanelTerminalState` 和 `syncAgentThreadMetadata` 落成 `agent_idle`，不新增旁路写 store。

验证：运行 review-checkpoint bootstrap verifier，确认匹配 last-thread `Stop` 被 recorded，错误 identity 保持零副作用。

### 2. 让 App Server lifecycle 补偿读取 Pane 自己的 last-thread identity

修改 `backend/src/app-server/handlers/agent-lifecycle.ts`：

- 当事件明确解析到 Pane 时，identity owner 必须是该 Pane，不能因为 Pane current identity 为空而回退到父 Session 的另一条 thread。
- 在 current identity 为空时，将同 Pane last-thread 精确匹配纳入 `currentThreadIdentityMatched` 的可信来源，再交给 shared processor。
- current thread 存在且不匹配时继续 fail closed；错误 lifecycle observation 不得覆盖新 thread。

验证：运行 app-server state-sync verifier，确认 hook、completion fallback、lifecycle compensation 三条路径对同一匹配 `Stop` 都收敛为 idle，并继续拒绝错 thread/跨 Pane 事件。

### 3. 补充现有 verifier，不新增单元测试

修改：

- `scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle-core.mjs`
- `scripts/verify-app-server-state-sync.mjs`

覆盖以下确定场景：

- `activeCommand=null`、current identity 为空、terminalState 为 `agent_starting`、last-thread 精确匹配时，`Stop` recorded 并收敛为 `agent_idle`。
- 同条件下 threadId、provider、panelId 或 tmuxPaneId 任一不匹配时 ignored 且零副作用。
- current identity 已指向新 thread 时，旧 last-thread `Stop` 不得覆盖新状态。
- 状态收敛后，Agent Team 原有 bounce 门禁可复用该 idle Pane，并建立 fresh code dispatch；门禁实现本身不修改。

对应行为测试计划：[agent-team-idle-worker-lifecycle.testplan.yaml](../testing/agent-team/agent-team-idle-worker-lifecycle.testplan.yaml)。

## 文件范围

- `backend/src/terminal/agent-hook-processor.ts`：唯一的 direct hook/completion 状态与 thread identity 判定权威。
- `backend/src/app-server/handlers/agent-lifecycle.ts`：lifecycle observation 的 Pane 级 identity 选择与补偿入口。
- `scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle-core.mjs`：生产 processor 与 Agent Team bounce 回归。
- `scripts/verify-app-server-state-sync.mjs`：App Server 三条状态来源的一致性回归。
- `docs/testing/agent-team/agent-team-idle-worker-lifecycle.testplan.yaml`：可执行行为验收合同。

除非实现证据证明现有 shared processor 无法表达上述合同，否则不修改 `service-worker-dispatch-support.ts`、前端组件或共享协议。

## 验证顺序

1. `pnpm testplan:validate docs/testing/agent-team/agent-team-idle-worker-lifecycle.testplan.yaml`
   - 预期：3 个 case 通过 schema 校验。
2. `pnpm agent-team:verify-review-checkpoints`
   - 预期：新增 matching last-thread Stop 和 bounce 检查通过；现有 stale/missing hook 检查仍通过。
3. `pnpm app-server:verify-state-sync`
   - 预期：direct hook、completion fallback、lifecycle compensation 状态一致，错 identity 无副作用。
4. `pnpm --filter @runweave/backend typecheck`
5. `pnpm --filter @runweave/backend lint`
6. `pnpm git diff --check`
7. 在只包含本修复 patch 的 Dev Session 中创建真实 Agent Team fixture，使用 `$toolkit:playwright-cli` 附着官方 surface：让 code worker 完成、review 失败并 bounce；确认 Code Pane 在 Stop 后显示 idle、Backend panel API 返回 `agent_idle`、fresh code dispatch 投递到原 Pane，且没有新开 thread。

任何 verifier 或真实行为出现以下结果都判失败：匹配 Stop 仍为 ignored、错 thread 被接受、旧 Stop 覆盖新 current thread、bounce 通过新开 thread 绕过上下文、或 UI 与 Backend 状态不一致。

## 当前现场恢复

实现和运行态更新完成后，不直接编辑 terminal store，也不手工投递 repair prompt。使用原现场已经记录的精确 `Stop` 身份重新走内部 Hook 入口，要求返回 `disposition=recorded` 并确认 `%76` 为 `agent_idle`；随后通过 Agent Team 官方恢复入口建立 fresh dispatch。若精确 Hook 重放不能通过新合同，则停止恢复并保留 `need_human`，不得绕过门禁。

## 兼容、回滚与风险

- 无 schema 或数据迁移；历史 terminal store 保持可读。
- 回滚只需撤销 processor、lifecycle handler 和 verifier patch，不删除任何用户数据。
- 主要风险是接受迟到旧 `Stop`。上述 current identity 冲突、Pane 双身份和 provider/thread 精确匹配是硬门禁；验证必须证明旧 Stop 不能覆盖新 thread。
- 当前工作区有 Agent 自进化未提交改动。实现时只触碰列出的文件；若存在重叠改动，使用独立 worktree 承载本修复并在验证环境只应用本 patch。
