# Agent Team 计划文件审查 Loop 代码复审 5

## 结论

**Fail**。本轮复审仍发现 1 个 P1 阻断问题，`case_3` 不通过。

上一轮 P1 未修复：`handleTimedOutRechecks` 在 watchdog 发现复验 outbox 已更新后，仍然只把 `acceptanceResults` 和 `forceBounceCaseIds` 传给 `applyRound`，没有传入 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`。这会导致 `code_review` pass 的补偿路径无法触发 `behavior_verify`。

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

- 风险：`applyRound` 启动 `behavior_verify` 的条件依赖 `params.completedWorkerRole === "code_review"`。正常 completion 事件路径已传入该字段，但 watchdog 补偿路径没有传。若 completion 事件丢失或未被路由，而 watchdog 后续发现 `code_review` outbox 已更新，run 会折叠 review gate 为 pass，却不会进入下一门禁，可能卡在 running/code_review。
- 定位：`backend/src/agent-team/service.ts:1333`
- 修复方向：在 `handleTimedOutRechecks` 的 `completedOutbox` 分支调用 `applyRound` 时补传 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行 Playwright：本轮是 `code_review` 门禁复审，已通过代码路径确认 P1 阻断；浏览器验收应在修复后由后续 `behavior_verify` 执行。

## Gate 结果

- `case_3`：fail。Code Review 仍发现 P1 阻断问题。
