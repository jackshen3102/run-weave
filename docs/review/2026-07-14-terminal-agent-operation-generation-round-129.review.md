# Terminal Agent Operation Generation Round 129 独立代码审查

## 结论

`case_25=fail`。上一轮“失败重试丢失当前 generation”已经修复，但同一个稳定 invariant `terminal.agent-bootstrap-operation-lifecycle-boundary` 仍有 1 条已真实复现的 P1：成功提交的 generation 没有 agent 生命周期退休点。

当前实现只在下一次 preparation 失败时恢复旧 generation，或在整 session/panel 集合清理时删除 generation。它不会在当前 agent completion/进程退出时退休。因此有两个真实受影响消费者：

1. `handleAgentCompletionEvent` 投递当前 panel/pane/thread 的 `hook_stop` completion 时不携带 operationId，也没有 lifecycle handler 的可信 current-thread context；generation guard 直接忽略该事件，panel/session 仍为 `agent_running/current-thread`，状态事件和 callback 都为 0。
2. launch wrapper 在 agent 进程退出后显式 `unset RUNWEAVE_TERMINAL_AGENT_OPERATION_ID`。同一 panel 后续手动启动 Codex 时，新 hook 没有 operationId，仍被旧 generation 拒绝；真实 probe 得到 `manualStart=ignored`，panel/session 保持 `agent_idle`，`manual-thread` 没有写入。

本轮只评审，不修改被审源码、verifier、HEAD 或 index。唯一写入是本报告与指定 reviewer pane outbox；未执行 behavior verification。

## 固定边界

- scope：`incremental`
- base / HEAD：`d83ce3955024d8f5628090191b42dd38e0204dee`
- target / index tree：`43ad6075a74d44b0d585eeb9e97cfd0401302d47`
- changed paths：prompt 指定的 16 个路径，实际 diff 完全一致
- diff：560 additions / 42 deletions；`git diff --check` 通过
- 计划 SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试用例 SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`

## P1 阻断

### 成功提交的 operation generation 没有生命周期退休点

`beginPanelAgentPreparation` 把本次 identity 写入 `panelAgentOperationGenerations`；成功提交后的 `releasePanelAgentPreparation` 只删除 single-flight preparation，不删除 generation。当前唯一 generation 清理点是提交前失败 rollback、`clearPanelsForSession` 和 `destroySession`，没有 agent completion 或 agent process exit 边界。

这使 `processTerminalAgentHook` 在 retained generation 存在时只接受匹配 operationId 或内部可信 current-thread context。`handleAgentCompletionEvent` 不提供二者；即使 event 的 panel、pane、provider、current thread 都精确匹配，仍会在 terminal state 和 thread metadata 更新前被忽略。独立生产链 probe 得到：

```json
{
  "generationTracked": true,
  "finalPanelState": { "state": "agent_running", "agent": "codex" },
  "finalPanelThreadId": "current-thread",
  "finalSessionState": { "state": "agent_running", "agent": "codex" },
  "finalSessionThreadId": "current-thread",
  "stateEventCount": 0,
  "callbackCount": 0
}
```

同一 generation 还跨越 agent 进程退出。启动 wrapper 在 invocation 返回后会 unset operation env，但 manager 不知道该退出，也不退休 generation。第二个生产链 probe 先用 operation A 的 Stop 收敛到 idle，再投递同 panel 的无 operationId `UserPromptSubmit/manual-thread`，结果为 `ignored`，新 thread 未进入 panel/session metadata。

影响：App Server completion fallback 在直接 Stop hook 缺失时失效；Agent Team/CLI 启动过的 panel 随后不能可靠识别用户手动启动的新 agent。两者都会让 terminal state、readiness、thread ownership 与实际进程漂移。

修复方向：在可证明的 agent process completion/exit 边界按 operationId 退休 retained generation，同时保留 agent 进程存活期间的 stale hook 防护；给 `agent.completion` 消费者和退出后手动重启各补一条生产回归。不能在任意 turn Stop 时直接删除 generation，因为同一个 TUI 的后续 turn 仍需要旧 operation identity 防护。

定位：`backend/src/terminal/manager-base.ts:169-212,260-273`；`backend/src/terminal/application/agent-preparation.ts:285-299,335-345`；`backend/src/terminal/agent-hook-processor.ts:122-160`；受影响消费者 `backend/src/app-server/handlers/agent-completion.ts:96-118`。

稳定 invariant：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

verificationMode：`runtime`；reproduction：`real_product + reproduced`；scenarioId：`terminal-agent-generation-retirement-round129`。

## 已修复与回归点

- 上一轮失败重试 rollback 已修复：active preparation 保存 `previousGeneration`，命令提交前失败会恢复旧 generation；新增 `bootstrap-failed-retry-restores-previous-operation-generation` 覆盖真实 409 前后 stale hook 均 ignored、metadata 与事件零变化。
- 上一轮 current-thread lifecycle compensation 仍保持修复：`currentThreadIdentityMatched` 是内部 context，错误 thread 零副作用，正确 current thread 可 recorded 并收敛状态。
- reviewer reproduction 契约已进入 shared type、normalizer、completion contract gate 与 repair target evidence；runtime open P0/P1 必须是 `real_product + reproduced + scenarioId`，缺失或未复现会进入协议补交。
- Agent Team bounce 改为通过 readiness bootstrap 把正式 repair prompt 作为新 agent initial query；现有 verifier 覆盖该调用链。

## 验证记录

- `git diff --cached --quiet 43ad6075... --`：exit 0。
- `git diff --check d83ce395... 43ad6075...`：exit 0。
- `pnpm agent-team:verify-review-checkpoints`：exit 0，包含失败重试恢复、可信 lifecycle compensation、review reproduction contract 与 repair bounce initial query checks。
- `pnpm --filter @runweave/backend typecheck`：exit 0。
- `pnpm --filter @runweave/shared typecheck`：exit 0。
- `pnpm --filter @runweave/backend lint`：exit 0。
- completion fallback 生产链 probe：generation retained；当前 thread completion 后 panel/session 仍 `agent_running`，事件/callback 为 0。
- manual relaunch 生产链 probe：operation A Stop recorded 后 generation 仍 retained；无 operationId manual start 返回 ignored，`manual-thread` 未写入。
- 计划与测试用例 `shasum -a 256`：均精确匹配 reviewTarget。

未执行 `behavior_verify`；本轮是独立 code review gate。
