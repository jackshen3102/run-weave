# Beta slot pool case_17 round 8 增量审查

## 结论

`case_17` 不通过。对 `0c3a99c8807a20138a7586a3d9e0401821c837b9` 到 staged tree `c111b71696a9b76ccef33b009baf143e37eddd79` 的 4 个指定路径完成独立增量审查，确认 2 条开放 P1：人工恢复会把“最近已消费角色”误当成“失败待重试角色”；`agent_starting` 会绕过 agent 就绪门禁，直接向 pane 注入下一轮 prompt。

审查身份：

- DispatchId：`3883b14a-268d-4aa6-a162-ba537c4d0087`
- scope：`incremental`
- baseCommit / HEAD：`0c3a99c8807a20138a7586a3d9e0401821c837b9`
- targetTree / staged tree：`c111b71696a9b76ccef33b009baf143e37eddd79`
- changedPaths：prompt 指定的 4 个 staged path，逐项匹配
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## P1：人工恢复没有保留失败 dispatch 的目标角色

`pauseForWorkerDispatchError()` 清空 `activeWorkerRole` 与 `activeWorkerDispatch`，但未持久化参数 `role`。本轮 `resumeRun()` 改为读取最后一条 `consumedWorkerDispatches` 的角色；该 receipt 表示已经完成并消费的上游 worker，不表示刚刚投递失败、等待重试的目标 worker。

真实失败链路是：消费 `behavior_verify` 结果后准备 bounce 到 `code`，先持久化 `activeWorkerRole=code` 与 code dispatch，再因 prompt 投递失败进入 `pauseForWorkerDispatchError(..., "code", ...)`。暂停状态把 code 目标身份清掉，人工恢复随后读取最后一条已消费 receipt 的 `behavior_verify`，于是重新派发 behavior verifier，绕过本应执行的 code repair。

review harness 场景 `resume-after-code-dispatch-failure` 使用真实 `AgentTeamService.resumeRun()` 和可观察的 persistence/dispatch 边界复现：`lastConsumedRole=behavior_verify`、`failedTargetRole=code`，实际新 dispatch 仍为 `behavior_verify`，`resultActiveWorkerRole=behavior_verify`，没有执行 code bounce。

代码证据：

- `backend/src/agent-team/service-lifecycle.ts:328-380`
- `backend/src/agent-team/service-support.ts:240-252`
- `backend/src/agent-team/service-execution.ts:424-455`
- `backend/src/agent-team/service-completion.ts:470-493`

## P1：`agent_starting` 被当成已就绪 thread 直接投递

本轮把 `agent_starting + lastThreadProvider/status/id` 纳入 `reusableActiveThread`。这些 `lastThread*` 字段只证明旧 thread 曾 idle，不能证明当前刚提交的 CLI 已完成启动，也没有校验当前 `panel.threadId` 与旧 `lastThreadId` 的身份一致性。命中该分支后直接调用 `sendPromptToPane()`；低层发送器只确保 terminal runtime 存在，随后执行 bracketed paste + Enter，不等待 agent readiness。

新增 review harness `agent-team-persisted-idle-starting-thread-reuses-fixed-worker-pane` 明确把 panel 设置为 `agent_starting`，同时保留旧的 idle thread metadata；结果断言 secondary prompt 被直接发送、resume 次数为 0。这个 harness 证明了 readiness bypass，却把该行为当成成功条件，因此常规 checkpoint verifier 仍然全绿。

代码证据：

- `backend/src/agent-team/service-support.ts:359-377`
- `backend/src/agent-team/prompt-sender.ts:39-94`
- `backend/src/terminal/application/agent-preparation.ts:269-310`
- `scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle-authority.mjs:29-98`

## 受影响消费者与失败链路

- `submitWorkerDispatchPrompt()` 是 serial dispatch、behavior-to-code bounce、repair protocol correction 与 recheck 的共同投递入口；`agent_starting` bypass 会影响所有这些消费者。
- code bounce 在 prompt 投递前已经持久化 active dispatch；若 prompt 被送入尚未 ready 的进程或 shell，后端仍认为 dispatch 已建立，后续可能等待一个从未真正收到任务的 outbox。
- 人工恢复路径在清除 loop 状态后使用错误角色建立 fresh dispatch，会破坏 behavior failure 必须先由 code repair 的协议顺序。

## Resolved findings 回归

本增量未修改上一 checkpoint 的 Beta slot pool / legacy cleanup 实现路径。fresh 执行 `pnpm dev:session:verify` 与 `pnpm runweave:beta:verify` 均通过，以下 5 条既有 P1 保持 resolved：

- `beta-slot.lease-release-requires-quiescence`
- `beta-legacy.cleanup-requires-all-components-inactive`
- `beta-slot.failed-manifest-lease-state`
- `beta-slot.janitor-single-owner-recovery`
- `beta-slot.disk-budget-additive-estimate`

## 验证记录

- `pnpm agent-team:verify-review-checkpoints`：通过，`ok=true`；同时暴露新增 verifier 将 `agent_starting` 直接投递断言为成功。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：通过，`ok=true`。
- `pnpm runweave:beta:verify`：通过，`ok=true`。
- `git diff --cached --check`：通过，无输出。
- `git rev-parse HEAD` 与 `git write-tree` 分别精确等于本轮 baseCommit 与 targetTree。

本轮是 review-only 增量代码审查，没有修改业务代码、配置或测试。上述 2 条 P1 需修复并以相同 scenarioId 的 executable review harness 重新验证后，`case_17` 才能通过。
