# Agent Team 计划文件审查 Loop 代码复审 4

## 结论

**Fail**。本轮复审仍发现 1 个 P1 阻断问题，`case_3` 不通过。

当前 live diff 中，上一轮指出的 watchdog 补偿路径缺口仍存在：`handleTimedOutRechecks` 在发现复验 outbox 已更新后调用 `applyRound`，但没有传入 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`。因此如果 `code_review` pane 写出 pass outbox，但 completion 事件丢失或没有路由到 `handleTerminalCompletion`，watchdog 折叠结果后仍无法满足 `applyRound` 中启动 `behavior_verify` 的条件。

## 审查范围

- `backend/src/agent-team/service.ts`
- `backend/src/agent-team/prompt-builders.ts`
- `backend/src/routes/agent-team.ts`
- `backend/src/routes/terminal-completion.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel-model.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`
- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
- `packages/shared/src/agent-team.ts`

## 发现

### P1 阻断：watchdog 折叠 code_review pass 后仍不会继续触发 behavior_verify

- 风险：正常 completion 事件路径在 `applyRound` 时传入了 `completedWorkerRole: parseWorkerRole(outbox.role)`，但 watchdog 补偿路径没有传。`applyRound` 只有在 `params.completedWorkerRole === "code_review"` 且 code review gate 已 pass 时才调用 `dispatchSerialWorker(..., "behavior_verify", ...)`。补偿路径会把 review gate 折叠为 pass，却不会启动下一门禁，run 可能停在 running/code_review，破坏 `code_review -> behavior_verify` 串行推进。
- 定位：`backend/src/agent-team/service.ts:1333`
- 修复方向：在 `handleTimedOutRechecks` 的 `completedOutbox` 分支调用 `applyRound` 时补传 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`；同时保留现有正常 completion 路径中的同名参数。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行 Playwright：本轮是 `code_review` 门禁复审，已通过代码路径确认 P1 阻断；浏览器验收应在修复后由后续 `behavior_verify` 执行。

## Gate 结果

- `case_3`：fail。Code Review 仍发现 P1 阻断问题。
