# Agent Team 计划文件审查 Loop 代码复审 7

## 结论

**Pass**。本轮复审未发现 P0/P1 阻断问题，`case_3` 通过。

上一轮 P1 已修复：`behavior_verify` fail 现在会按 gate worker 规则生成 `forceBounceCaseIds`，后续 `applyRound` 会立即调用 `bounceFailuresToCode` 并把 active worker 切回 `code`。

## 审查范围

- `backend/src/agent-team/service.ts`
- `backend/src/agent-team/loop.ts`
- `backend/src/agent-team/prompt-builders.ts`
- `backend/src/routes/agent-team.ts`
- `backend/src/routes/terminal-completion.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel-model.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`
- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
- `packages/shared/src/agent-team.ts`

## 已确认修复

- `backend/src/agent-team/service.ts:1333`：watchdog `completedOutbox` 分支调用 `applyRound` 时保留 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`，`code_review` pass 的补偿路径可以继续启动 `behavior_verify`。
- `backend/src/agent-team/service.ts:1633`：direct acceptance results 的 fail case 现在基于 `isGateWorkerOutbox(outbox)` 生成 `forceBounceCaseIds`。
- `backend/src/agent-team/service.ts:2093`：`isGateWorkerOutbox` 覆盖 `code_review`、`plan_review` 和 `behavior_verify`。
- `backend/src/agent-team/service.ts:854`、`backend/src/agent-team/service.ts:959`：`forceBounceCaseIds` 会进入 `bounceFailuresToCode`，并把 `activeWorkerRole` 切回 `code`。

## 残余风险

- 本轮是 `code_review` 门禁复审，只做静态门禁和代码路径审查；未执行 Playwright 浏览器验收。串行 worker 的端到端 UI、tmux pane、outbox 推进仍应由后续 `behavior_verify` 按测试计划执行。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。

## Gate 结果

- `case_3`：pass。Code Review 未发现 P0/P1 阻断问题，上一轮阻断问题已修复。
