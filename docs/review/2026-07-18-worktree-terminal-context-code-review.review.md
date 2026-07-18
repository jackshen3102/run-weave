# Worktree Terminal Context 代码审查

结论：未通过。当前实现仍有 2 条 P1 结构性阻断问题，`AGT-REVIEW-GATE` 应记为 `fail`。

## Findings

### P1：Agent Team 会把畸形 child Project ID 回退到 cwd

`POST /api/agent-team/runs` 只要求 `projectId` 是非空字符串，`startRun` 随后直接用调用方传入的 ID 解析项目根。`resolveProjectRoot` 与 `AgentTeamPaths.projectRoot` 都只在 `parseTerminalChildProjectId(projectId)` 成功时禁止 fallback；因此 `wt:` 前缀但 base64url/段结构非法的 ID 会被解析成 `null`，继而落到 Terminal cwd 或进程 cwd。该行为违反计划中“Agent Team 对 missing/非法子 ID 拒绝 fallback”的边界，也满足 WTC-014 的失败判定“退回父根执行”。

- 定位：`backend/src/agent-team/service-support.ts:33-41`、`backend/src/agent-team/storage/agent-team-paths.ts:124-134`、`backend/src/routes/agent-team.ts:48-67`、`backend/src/agent-team/service-lifecycle.ts:35-57`
- 静态合约探针：`node --experimental-strip-types --input-type=module -e '<parseTerminalChildProjectId probe>'` 确认 `wt:not-base64!:broken` 的解析结果为 `null`；上述两个 guard 随后都会进入 cwd fallback 分支。
- 影响：畸形 child 身份不会按 404/409 被拒绝，Agent Team 的计划读取、run/outbox 根与请求中的 `projectId` 失去一致性。
- 修复方向：把“child-shaped but invalid”和 legacy non-child ID 分开；凡 `wt:` 命名空间内无法规范解析的 ID 都必须拒绝，且 `startRun` 应校验请求 project 与 Terminal session 的有效 context 关系。

### P1：Terminal 创建事件绕过原子 Project context 选择

本轮新增了 `selectProjectContext(parentProjectId, projectId, terminalSessionId)`，用于一次 store update 同步父 Project、生效 Project 和 Session；但 `terminal_session_created` 的无 active-session 分支仍只依次调用 `setActiveProjectId` 与 `selectActiveSession`，完全不更新 `activeParentProjectId`。当事件来自另一父 Project 的 child context，store 会短暂形成 `activeParentProjectId=A / activeProjectId=child(B) / activeSessionId=session(B)`，随后 context 恢复 effect 又会把选择回退到 A，既违反原子选择不变量，也可能让新建 Terminal 无法保持选中。

- 定位：`frontend/src/components/terminal/terminal-workspace-events.ts:88-104`；正确原子 action 位于 `frontend/src/features/terminal/workspace-store.ts:161-170`。
- 合同依据：`docs/plans/2026-07-18-worktree-terminal-context.md:305-331` 明确把 workspace events 列为修改点，并要求一个原子 action 同时提交三个字段。
- 影响：违反 WTC-008 对父 tab、Worktree 行、Terminal 和业务 ID 同步的要求，并破坏 WTC-017 的父 Project 独立 context 恢复。
- 修复方向：事件处理在已知 created session 的 `projectId` 后，解析其父 ID并只调用原子 context action；同时清点本轮仍直接组合多个 selection setter 的创建/删除路径，避免再次绕过同一 invariant。

## 审查范围

- 计划与测试计划：`docs/plans/2026-07-18-worktree-terminal-context.md`、`docs/testing/terminal/worktree-terminal-context.testplan.yaml`，SHA-256 与 run 记录一致。
- 实现范围：shared child ID 合约、backend registry/API/Session/Preview/Agent Team/级联删除、frontend rail/selection/recent state、App Home 分组，以及新增专项 E2E。
- 未把 `docs/testing/runbooks/terminal-vim.md`、`explorer-quick-search.testplan.yaml`、`status-lookup-ui.testplan.yaml` 纳入本次实现结论；它们与 code worker 的 Worktree context 交付无可追溯关系。

## 已执行验证

- `pnpm --filter @runweave/shared typecheck`：通过。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/frontend typecheck`：通过。
- `pnpm --filter @runweave/app typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- child ID 静态解析探针：canonical ID 可解析；畸形 `wt:` ID 返回 `null`，结合实际 fallback 分支确认第一条 finding。

本轮是 code review，不声称替代独立 `behavior_verify`；未启动 Dev Session，也未把未执行的浏览器场景包装成 runtime finding。
