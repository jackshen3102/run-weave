# Beta slot pool case_17 round 9 增量审查

## 结论

`case_17` 通过。对 `0c3a99c8807a20138a7586a3d9e0401821c837b9` 到 staged tree `27e8093b654d7b2a1a938694beef2baf08e13261` 的 4 个指定路径完成独立增量审查，未发现开放 P0/P1。round 8 的两个阻断 invariant 均已修复，并通过相同场景的 executable review harness 复核。

审查身份：

- DispatchId：`072382a5-0b99-4b61-9e28-104c900f5c04`
- scope：`incremental`
- baseCommit / HEAD：`0c3a99c8807a20138a7586a3d9e0401821c837b9`
- targetTree / staged tree：`27e8093b654d7b2a1a938694beef2baf08e13261`
- changedPaths：prompt 指定的 4 个 staged path，逐项匹配
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## 已解决 P1

### `agent-team.resume-preserves-failed-dispatch-role`

`pauseForWorkerDispatchError()` 现在把失败目标 `role` 保留在 `activeWorkerRole`，人工恢复优先读取该值；`consumedWorkerDispatches.at(-1).role` 只保留为没有显式失败目标时的 fallback。

相同场景 `resume-after-code-dispatch-failure` 使用真实 `AgentTeamService.resumeRun()` 复核：最后已消费角色仍为 `behavior_verify`，失败目标为 `code`；恢复结果进入 code bounce，`resultActiveWorkerRole=code`，没有错误创建 behavior verifier dispatch。

### `agent-team.starting-state-requires-readiness`

`agent_starting` 不再直接进入 prompt sender。实现会等待 authoritative `agent_idle`，同时要求 provider、当前 `threadProvider` 与 `threadId` 精确匹配已记录的 idle thread identity；不匹配、进入 shell/running、pane 消失或 10 秒超时均 fail closed。

仓库 executable harness 证明：ready 前发送数为 0；仅 terminal state idle 但 thread identity 不匹配时仍为 0；identity 匹配后才发送 1 次。额外负向场景 `starting-thread-readiness-timeout` 在 10009ms 后返回 `need_human`，`activeWorkerRole=code_review`、prompt 数为 0、mutation listener 数为 0。

## 受影响消费者与失败链路

- `submitWorkerDispatchPrompt()` 继续统一承接 serial dispatch、behavior-to-code bounce、repair protocol correction 与 recheck；所有消费者共享新的 readiness + thread identity 门禁。
- worker prompt 投递失败时 active dispatch 仍被清空，避免错误消费；失败目标 role 被保留，供人工恢复重新建立 fresh dispatch。
- `resumeRun()` 在恢复时先清空旧 boundary，再按保留角色重建；code 且仍有失败用例时重新进入 `bounceFailuresToCode()`，不会跳回最近已消费的 behavior verifier。
- readiness 等待的 timeout、状态不匹配和 thread identity 不匹配均不触发 prompt，也不会遗留 panel mutation listener。

## Resolved findings 回归

本增量未修改上一 checkpoint 的 Beta slot pool / legacy cleanup 实现路径。fresh 执行 `pnpm dev:session:verify` 与 `pnpm runweave:beta:verify` 均通过，以下 5 条既有 P1 保持 resolved：

- `beta-slot.lease-release-requires-quiescence`
- `beta-legacy.cleanup-requires-all-components-inactive`
- `beta-slot.failed-manifest-lease-state`
- `beta-slot.janitor-single-owner-recovery`
- `beta-slot.disk-budget-additive-estimate`

## 验证记录

- `review-harness:resume-after-code-dispatch-failure`：相同场景通过；code bounce 1 次，behavior dispatch 0 次。
- `pnpm agent-team:verify-review-checkpoints`：通过，`ok=true`，包含 current-thread readiness 正向/错配门禁。
- `review-harness:starting-thread-readiness-timeout`：10009ms 后 fail closed，prompt=0，active listener=0。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：通过，`ok=true`。
- `pnpm runweave:beta:verify`：通过，`ok=true`。
- `git diff --cached --check`：通过，无输出。
- `git rev-parse HEAD` 与 `git write-tree` 分别精确等于本轮 baseCommit 与 targetTree。

本轮是 review-only 增量代码审查，没有修改业务代码、配置或测试，也未执行浏览器/桌面验收；本结论针对指定后端状态机增量与其 executable harness，不替代 BSP-001 至 BSP-016 的真实产品行为验收。
