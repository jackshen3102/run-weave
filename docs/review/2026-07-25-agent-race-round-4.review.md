# Agent Race 第 4 轮代码审查

## 结论

通过 `AGT-REVIEW-GATE`。本轮 RACE-008 / RACE-009 的共同路由修复在代码结构上成立，未发现开放的 P0/P1。

Round 2 记录的 create/remove 交错 P2 所在后端代码本轮未修改，重新运行 review harness 后仍可复现，因此继续作为非阻断 remaining finding 保留。

## Resolved Findings

### P1（已解决）：跨父项目 Worker 卡只更新 Workspace 状态，URL 仍指向旧 Session

- 位置：`frontend/src/components/terminal/terminal-race-panel.tsx:4`、`:117`、`:268-282`
- 修复核对：`focusWorker()` 先用同一份 Race Worker 身份提交 `parentProjectId / worktreeId / terminalSessionId`，随后把 React Router URL 导航到同一 `terminalSessionId`。路由参数不再保留旧源 Session，因此 `TerminalWorkspaceContent` 的 route effect 不会再把 Workspace 拉回旧父项目。
- RACE-008 影响：Worker 卡与既有 rail 选择最终落到同一个 project/session 身份；输入链路继续复用当前 active Session，不引入第二套发送路径。

### P1（已解决）：Worker Diff 在旧父项目 Preview 中打开

- 位置：`frontend/src/components/terminal/terminal-race-panel.tsx:284-294`
- 修复核对：`openWorkerDiff()` 复用修复后的 `focusWorker()`，再以同一 `worker.worktreeId` 调用 `openPreview(..., "changes")`。静态顺序检查确认 `selectProjectContext → navigate(worker session) → openPreview(worker project)`。
- RACE-009 影响：Diff 的路由 Session 与 Preview project 来自同一 WorkerRecord，不再把 Worker A 的 Diff 入口落到源项目。

## Remaining Findings

### P2：显式 Worktree 删除仍可与 Worker Session 创建交错

- 位置：`backend/src/race/race-service.ts:276-351`、`:373-400`
- 状态：本轮未修改该后端路径；重新运行 `race-create-remove-overlap` harness 后仍得到 `terminalSessionId="orphan-session"`、`launchStatus="failed"`、`destroyed=[]`。
- 影响：另一客户端可在 `createSession()` 返回前成功删除已登记 worktree，随后原 create 仍回填一个指向已删除路径的 Session。Session ID 最终仍登记在 RaceRecord、可由结束 Race 清理，且 v1 没有删除 UI，因此仍定级为非阻断 P2。
- 修复方向：让 `removeWorktree()` 复用创建屏障，或引入按 Race/Worker 的生命周期互斥。

## 检查与证据

- `pnpm --filter @runweave/frontend typecheck`：通过。
- `pnpm --filter @runweave/frontend lint`：通过。
- `pnpm --filter @runweave/frontend build`：通过。
- `pnpm testplan:validate docs/testing/terminal/agent-race.testplan.yaml`：通过，13 个 required Case。
- 路由静态契约检查：`selectBeforeNavigate=true`、`navigateBeforePreview=true`、Worker Session URL 与 Worker project Preview 均使用同一 WorkerRecord。
- `race-create-remove-overlap` review harness：P2 仍可复现。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 残余风险

本轮是只读代码审查，没有自行执行浏览器行为验收。Code Agent 提交的 Beta Electron 证据仅作为 handoff 阅读；RACE-008 / RACE-009 的最终真实产品结论仍应由后续 `behavior_verify` 按原 `scenarioId` 与 `validationSessionId` 独立复验。
