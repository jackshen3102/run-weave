# Agent Team 计划文件审查 Loop 代码复审 3

## 结论

**Fail**。本轮复审发现 1 个 P1 阻断问题，`case_3` 不通过。

上一轮已指出的类型迁移阻断项已经修复：`normalizePlanReviewAcceptance` 已补齐，前端也已迁移到 `intake` / `plan_review` phase；`git diff --check`、`pnpm typecheck`、`pnpm lint` 均通过。但新增串行门禁的 watchdog 补偿路径会在 `code_review` pass 后丢失完成 worker role，导致后续 `behavior_verify` 不被触发。

## 审查范围

- 当前 live worktree 的 Agent Team 相关源码增量：
  - `backend/src/agent-team/prompt-builders.ts`
  - `backend/src/agent-team/service.ts`
  - `backend/src/routes/agent-team.ts`
  - `backend/src/routes/terminal-completion.ts`
  - `frontend/src/components/terminal/terminal-agent-team-panel-model.ts`
  - `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`
  - `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
  - `packages/shared/src/agent-team.ts`

## 发现

### P1 阻断：watchdog 折叠 code_review outbox 后不会继续触发 behavior_verify

正常 completion 事件路径会在 `applyRound` 时传入 `completedWorkerRole: parseWorkerRole(outbox.role)`，因此 `code_review` 通过后可以进入 `dispatchSerialWorker(..., "behavior_verify", ...)`。但 watchdog 补偿路径在检测到 worker outbox 已更新后，只把 `acceptanceResults` 和 `forceBounceCaseIds` 传给 `applyRound`，没有传 `completedWorkerRole`。

定位：

- `backend/src/agent-team/service.ts:1326` 到 `backend/src/agent-team/service.ts:1336`
- `backend/src/agent-team/service.ts:866` 到 `backend/src/agent-team/service.ts:875`
- `backend/src/agent-team/service.ts:1391` 到 `backend/src/agent-team/service.ts:1428`

影响：如果 `code_review` pane 已写入 pass outbox，但 terminal completion 事件丢失或未被路由到 `handleTerminalCompletion`，watchdog 会在超时后识别到更新并把 `case_3` 折叠为 pass；由于没有传入 `completedWorkerRole: "code_review"`，`applyRound` 不会启动 `behavior_verify`。run 会停留在 `running`，`activeWorkerRole` 仍可能是 `code_review`，后续验收用例无法自动推进。这正好破坏本次串行门禁 code -> code_review -> behavior_verify 的长期正确性。

修复方向：在 `handleTimedOutRechecks` 的 `completedOutbox` 分支调用 `applyRound` 时补传 `completedWorkerRole: parseWorkerRole(completedOutbox.role)`；同时建议用一个现有 E2E/集成路径覆盖“completion 事件缺失、watchdog 发现 outbox 更新、code_review pass 后继续触发 behavior_verify”的场景。

## 已确认修复项

- `backend/src/agent-team/service.ts:2027` 到 `backend/src/agent-team/service.ts:2048`：`normalizePlanReviewAcceptance` 已补齐并初始化 plan review case 状态。
- `frontend/src/components/terminal/terminal-agent-team-panel-model.ts:5` 到 `frontend/src/components/terminal/terminal-agent-team-panel-model.ts:10`：phase label 已覆盖 `intake` / `plan_review`。
- `frontend/src/components/terminal/terminal-agent-team-panel.tsx:331` 到 `frontend/src/components/terminal/terminal-agent-team-panel.tsx:339`：前端已新增 `plan_review` 渲染入口。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行 Playwright：本轮是 `code_review` 门禁；已发现 P1 代码路径阻断，浏览器验收应在修复后由 `behavior_verify` 执行。

## Gate 结果

- `case_3`：fail。Code Review 仍发现 P1 阻断问题。
