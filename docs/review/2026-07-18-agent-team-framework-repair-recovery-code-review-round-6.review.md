# Agent Team 框架修复与重启恢复 Code Review（Round 6）

## 结论

未通过 `AGT-REVIEW-GATE`。当前实现仍有一个 P1：框架修复的 continue 在将新 dispatch 持久化之前就把 prompt 投递给 Worker。持久化失败时，Worker 已可执行新任务，而 Run 仍保留 `blocked` 和旧 dispatch；重试会投递第二个新 dispatch。

## 审查边界

- Dispatch：`492e78ea-4d3f-47f0-9777-f9d7d2ec266d`
- Run：`atr_9694c6c3-dbec1c3c_20260717231357`
- 范围：当前工作区的 Agent Team framework-repair 实现与恢复验证脚本。
- 排除：未提交的 worktree-terminal-context 文档及与本 Run 无关的既有改动。

## P1 阻断

### continue 在 durable dispatch 之前投递 Worker prompt

- invariantKey：`framework-repair.continue-persistence-before-dispatch`
- 定位：`backend/src/agent-team/service-framework-repair.ts:160`、`backend/src/agent-team/service-framework-repair.ts:175`、`backend/src/agent-team/service-worker-dispatch-support.ts:85`。
- 风险：`submitWorkerDispatchPrompt` 在 `updateRun` 之前执行；前者会把 prompt 发送到已就绪 pane。若后者因存储、磁盘或进程错误失败，调用报错但 Worker 已开始执行；持久化 Run 仍是 `blocked`，没有对应 fresh dispatch。再次 continue 会生成并发送第二个 dispatch，且第一份 outbox 无法按 durable dispatch 正确消费。
- 复现依据：静态合同确认。`pnpm agent-team:verify-framework-recovery` 仅覆盖“投递本身抛错，Run 保持 blocked”（`ATFR-004-delivery-failure-keeps-blocked-state-retryable`），未覆盖“投递成功、后续 `updateRun` 抛错”。
- 修复方向：先持久化包含 fresh dispatch 的可恢复 pending 状态，再投递；投递失败时持久化明确的 retry/paused 状态。补充一个让投递成功、随后 `updateRun` 失败的 harness，断言没有重复 dispatch 且持久状态可恢复。

## 已执行验证

- `pnpm agent-team:verify-framework-recovery`：通过 21 项，但没有上述反向路径。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

未执行 Playwright：本 finding 是结构性投递/持久化顺序缺陷，已由静态合同确认；浏览器行为验收不替代该故障分支。
