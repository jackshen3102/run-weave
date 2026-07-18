# Worktree Terminal Context 代码复审（Round 2）

结论：通过。上轮 2 条 P1 结构性阻断均已修复，本轮增量未发现新的 P0/P1，`AGT-REVIEW-GATE` 应记为 `pass`。

## Findings

未发现仍处于 open 状态的 P0/P1。

## 已关闭问题

### P1（resolved）：Agent Team 对畸形 child Project ID 回退 cwd

修复在共享合约中新增 `isTerminalChildProjectIdLike`，并在 Agent Team 的两个根目录 resolver 中把 `wt:` 命名空间 guard 放到 legacy cwd fallback 之前。已注册 Project 仍返回自身 path；未注册、畸形或不可用的 `wt:` ID 分别返回 `null` 或抛出 `Terminal project context is unavailable`；legacy non-child ID 保留原有 cwd 兼容行为。

- 定位：`packages/shared/src/terminal/project-context.ts:110-112`、`backend/src/agent-team/service-support.ts:33-44`、`backend/src/agent-team/storage/agent-team-paths.ts:124-137`。
- 独立结构化探针：`AgentTeamPaths` fake-manager harness 对 `wt:not-base64!:broken` 和 canonical-but-unknown child ID 均抛出 `Terminal project context is unavailable`，而 `legacy-project` 仍解析到 `/review-legacy-root/.runweave/agent-team`。
- 结论：`agent-team.child-project-root-no-fallback` 已关闭。

### P1（resolved）：Terminal 创建事件绕过原子 Project context 选择

`terminal_session_created` 分支现在先通过 `resolveTerminalParentProjectId` 得到父 Project，再仅调用一次 `selectProjectContext(parent, effective, session)`；该 action 在单次 Zustand `set` 中同步三个选择字段。项目创建和删除路径也改用同一原子 action，避免再次组合多个 setter。

- 定位：`frontend/src/components/terminal/terminal-workspace-events.ts:94-106`、`frontend/src/features/terminal/workspace-store.ts:161-175`、`frontend/src/components/terminal/terminal-workspace-actions.ts:219-227,270-273`。
- 独立结构化探针：从 `parent-a/parent-a/null` 切换到 `child(parent-b)/session-b` 后，store 一次提交为 `parent-b/child-b/session-b`，一致性断言为 `true`。
- 结论：`terminal.workspace-context-selection-atomicity` 已关闭。

## 审查范围

- 重新读取 round 2 当前 live diff，而非复用 round 1 结论；本轮 run 未提供 checkpoint reviewTarget，因此复审边界以当前 Worktree context 实现与 code repair 回执标出的两个 invariant 为准。
- 重点复核 shared child ID 合约、Agent Team 根目录解析、Terminal workspace event/store/action 的修复增量，并检查相关调用点是否仍绕过原子选择。
- `docs/testing/runbooks/terminal-vim.md`、`explorer-quick-search.testplan.yaml`、`status-lookup-ui.testplan.yaml` 等无关工作区变更不纳入本轮结论。

## 已执行验证

- `pnpm --filter @runweave/shared typecheck`：通过。
- `pnpm --dir backend typecheck`：通过。
- `pnpm --dir frontend typecheck`：通过。
- `pnpm --dir app typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- 两个独立 review harness：畸形 child root 拒绝与 workspace context 原子提交均通过。

本轮仅给出 code review 结论，不替代独立 `behavior_verify`，也不把静态检查或 review harness 表述为真实产品 runtime 验收。
