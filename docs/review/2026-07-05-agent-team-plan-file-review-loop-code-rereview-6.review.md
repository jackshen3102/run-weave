# Agent Team 计划文件审查 Loop 代码复审 6

## 结论

**Fail**。上一轮 P1（watchdog 折叠 `code_review` pass outbox 时未传 `completedWorkerRole`）已经修复，但本轮复审仍发现 1 个 P1 阻断问题，`case_3` 不通过。

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

- `backend/src/agent-team/service.ts:1333`：`handleTimedOutRechecks` 的 `completedOutbox` 分支现在调用 `applyRound` 时已传入 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`，上一轮阻断项已修复。

## 发现

### P1 阻断：behavior_verify fail 不会按串行门禁契约立即抛回 code

- 风险：测试计划明确要求 `behavior_verify` 失败必须回到 `code`。但 `resolveOutboxRound` 只在 `isReviewWorkerOutbox(outbox)` 为 true 时把 fail case 放入 `forceBounceCaseIds`；`behavior_verify` outbox 的 fail 只会进入 `foldRound`。`foldRound` 对首次 fail 只把 `consecutiveFail` 置为 1，而默认 `stableFailThreshold=2`，因此 `applyRound` 第 854-864 行不会立即调用 `bounceFailuresToCode`。结果是 verify fail 后 run 可能仍停在 `activeWorkerRole=behavior_verify`，违背本次 worker 串行验证计划。
- 定位：`backend/src/agent-team/service.ts:1633`、`backend/src/agent-team/loop.ts:85`、`docs/plans/2026-07-05-agent-team-worker-serial-verification.md:176`
- 修复方向：把 gate worker fail 的 immediate bounce 规则覆盖到 `behavior_verify`，例如恢复/引入 `isGateWorkerOutbox` 并让 `code_review`、`plan_review`、`behavior_verify` 的 fail 都生成 `forceBounceCaseIds`；或在 `applyRound` 中基于 `completedWorkerRole === "behavior_verify"` 对 fail case 立即 bounce。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行 Playwright：本轮是 `code_review` 门禁复审，已通过代码路径确认 P1 阻断；浏览器验收应在修复后由后续 `behavior_verify` 执行。

## Gate 结果

- `case_3`：fail。Code Review 仍发现 P1 阻断问题。
