# Agent Team 框架修复与重启恢复 Code Review（Round 5）

## 结论

未通过 `AGT-REVIEW-GATE`。此前针对 rerun 资源回滚的修复与现有恢复 harness 均通过，但 continue 仍存在一个未覆盖的 P1：新任务已经投递给 Worker 后，才持久化新 dispatch 与 `continued` 状态。持久化失败时，旧 Run 继续保持 blocked，已收到新任务的 Worker 却可能继续执行；再次 continue 会生成并投递第二个 dispatch。

## 审查边界

- Dispatch：`46886678-970a-45ba-816d-59f67cb772b4`
- Run：`atr_d2248b91_20260717224727`，code_review round 1。
- 范围：当前工作区的 Agent Team framework-repair 实现、共享合同、API/CLI/前端接线和恢复 harness；不归因于无关的 worktree-terminal-context 文档提交。
- `reviewTarget=null`，因此按当前 live worktree 与 framework-repair 计划/测试用例执行结构性审查。

## P1 阻断

### continue 在 durable dispatch 之前投递 Worker prompt

- invariantKey：`framework-repair.continue-persistence-before-dispatch`
- 定位：`backend/src/agent-team/service-framework-repair.ts:160-192`。
- 风险：`submitWorkerDispatchPrompt(...)` 成功后，`updateRun(...)` 才写入 `activeWorkerDispatch` 和 `frameworkRepair.result="continued"`。若此写入因存储/磁盘/进程错误失败，调用返回错误且持久 Run 仍为 `blocked`；但 Worker 已有新 prompt。后续重试会再次投递新 prompt，造成重复执行；先前 Worker 的 outbox 又因持久状态没有对应 dispatch 而无法可靠消费。
- 复现依据：对该调用顺序进行静态合同确认。现有 `ATFR-004` harness 只覆盖 prompt 投递抛错，`pnpm agent-team:verify-framework-recovery` 的通过结果并未覆盖“投递成功、随后 Run 写入失败”的分支。
- 修复方向：把恢复实现为可恢复的两阶段协议：先持久化带 fresh dispatch 的 pending/blocked 记录，再投递；投递失败时持久化回滚或明确的 retry 状态。不得在 durable dispatch 之前让 Worker 获得可执行 prompt。

## 已验证

- `pnpm agent-team:verify-framework-recovery`：通过，20 项；覆盖已有 rerun rollback 和常规 continue 场景，但不覆盖上述顺序故障。
- `pnpm typecheck`、`pnpm lint`、`git diff --check`：通过。
- 未执行 Playwright：本轮 P1 是存储与任务投递顺序的结构性合同，不以 UI 截图代替；页面级验收仍应由 behavior_verify 在修复后执行。
