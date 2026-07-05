# Agent Team 计划文件审查 Loop 代码审查

## 结论

**Fail**。当前 live worktree 存在 P1 阻断问题：backend 与 frontend 类型检查均失败，且计划文件审查 loop 处于半迁移状态，不能进入回归验收。

## 审查范围

- 基线：`origin/main..HEAD` 的提交 `4d46c36 feat: improve agent team acceptance and manual completion`
- 审查中新增的未提交改动：
  - `packages/shared/src/agent-team.ts`
  - `backend/src/routes/agent-team.ts`
  - `backend/src/agent-team/service.ts`
  - `backend/src/agent-team/prompt-builders.ts`
- 重点：`planFile`、`intake/plan_review` phase、plan/plan_review worker、outbox evidence schema、人工完成入口。

## 发现

### P1 阻断：backend 计划审查入口调用未定义 helper，类型检查失败

`backend/src/agent-team/service.ts:516` 新增 `startPlanReview`，但 `backend/src/agent-team/service.ts:529` 调用了未定义的 `normalizePlanReviewAcceptance`。当前 `pnpm --filter @runweave/backend typecheck` 失败：

```text
src/agent-team/service.ts(529,24): error TS2304: Cannot find name 'normalizePlanReviewAcceptance'.
```

影响：带 `planFile` 的 run 无法构建，整个仓库 `pnpm typecheck` 失败。修复方向：补齐该 helper，并明确计划审查 acceptance case 的 caseId、文案、默认状态、证据初始化；补完后重新跑 backend/full typecheck。

### P1 阻断：前端仍按旧 `clarify` phase 渲染，新的 phase union 无法通过类型检查

`packages/shared/src/agent-team.ts:9` 已把 `AgentTeamPhase` 改为 `intake | plan_review | proposal | executing`，但 `frontend/src/components/terminal/terminal-agent-team-panel-model.ts:5` 的 `PHASE_LABEL` 仍包含 `clarify` 且缺少 `intake/plan_review`；`frontend/src/components/terminal/terminal-agent-team-panel.tsx:336` 仍判断 `run.phase === "clarify"`。

当前 `pnpm --filter @runweave/frontend typecheck` 失败：

```text
src/components/terminal/terminal-agent-team-panel-model.ts(6,3): error TS2353: Object literal may only specify known properties, and 'clarify' does not exist in type 'Record<AgentTeamPhase, string>'.
src/components/terminal/terminal-agent-team-panel.tsx(336,13): error TS2367: This comparison appears to be unintentional because the types 'AgentTeamPhase' and '"clarify"' have no overlap.
```

影响：即使 backend 补齐，frontend 仍不能构建；用户也看不到计划审查状态 UI。修复方向：把启动区改成“提交执行任务 + 可选计划文件”，新增 `plan_review` 渲染分支和 label，删除或迁移旧 ClarifySection。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `pnpm --filter @runweave/backend typecheck`：失败，见 P1-1。
- `pnpm --filter @runweave/frontend typecheck`：失败，见 P1-2。
- `pnpm typecheck`：失败，阻断在 backend/frontend typecheck。
- 未执行 Playwright：当前静态门禁已失败，浏览器验收没有进入条件。

## Gate 结果

- `case_1`：fail。核心 planFile/plan_review loop 尚未可构建，页面 phase 也未迁移完成。
- `case_2`：fail。关键回归门禁 `pnpm typecheck` 失败。
- `case_3`：fail。Code Review 发现 P1 阻断问题。
