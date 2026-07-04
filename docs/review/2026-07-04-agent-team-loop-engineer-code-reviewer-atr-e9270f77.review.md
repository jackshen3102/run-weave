# Agent Team / Loop Engineer 代码审查

- 日期：2026-07-04
- Run：atr_e9270f77_20260704062729
- 角色：code_reviewer
- 范围：当前 live worktree diff：`backend/src/agent-team/service.ts`、`frontend/src/components/terminal/terminal-agent-team-panel.tsx`、`frontend/src/components/terminal/terminal-workspace-shell.tsx`、`docs/README.md`，以及删除旧 `docs/testing/2026-06-17-multi-agent-orchestrator-test-cases.md`。
- 约束：只做代码审查，不修改产品代码；本文件是本轮唯一新增产物。

## 结论

不建议直接进入验收或合入。静态校验通过，但 Agent Team 启动与 tab 保留主路径仍有 2 个 P1 回归风险；回归覆盖目前主要停留在测试文档，尚未有本轮浏览器验收证据。

## 关键发现

### P1 严重：启动 prompt 注入失败仍会留下 clarify 假成功 run

- 定位：`backend/src/agent-team/service.ts:221`、`backend/src/agent-team/service.ts:226`、`backend/src/agent-team/service.ts:227`、`backend/src/agent-team/service.ts:644`
- 风险：当前顺序已把 `ensureAgentReady` 放到 `writeRun` 之前，修复了 agent readiness 失败后残留 active run 的问题；但 `writeRun(run)` 之后的 `trySendToMain(run, buildStartupPrompt(run))` 仍然吞掉注入失败，只打 warn。若 prompt sender、panel target、tmux/pty 写入失败，接口仍返回 `phase="clarify"` / `status="clarifying"`，右侧 UI 会显示流程已启动，但 main pane 没收到主 Agent 约束，后续澄清和拆分可能停在错误现场。
- 证据：`trySendToMain` 在 `backend/src/agent-team/service.ts:651` 到 `backend/src/agent-team/service.ts:663` 捕获异常后不抛出；测试文档 `docs/testing/agent-team-loop-engineer-test-cases.md:190` 到 `docs/testing/agent-team-loop-engineer-test-cases.md:206` 要求开启流程后 main pane 收到启动 prompt，且不得进入半启动假成功。
- 修复方向：把启动 prompt 注入纳入 `startRun` 成功条件。可以在持久化 active run 前完成注入，或注入失败后删除/标记该 run 为 failed，并把明确错误返回 UI。

### P1 严重：新创建 run 后外层 workspace 不知道 active run，`panelSplitEnabled=false` 时仍会隐藏 Agent Team tab

- 定位：`frontend/src/components/terminal/terminal-agent-team-panel.tsx:196`、`frontend/src/components/terminal/terminal-workspace-shell.tsx:827`、`frontend/src/components/terminal/terminal-workspace-shell.tsx:934`
- 风险：外层 `TerminalWorkspaceShell` 只在 `activeProject?.projectId` / `activeSession?.terminalSessionId` / `apiBase` / `token` 变化时调用 `getAgentTeamRunForTerminal`，子面板 `startAgentTeamRun` 成功后没有通知外层更新 `activeAgentTeamRunSessionId`。因此本次新增的 `activeAgentTeamRunPresent` 只对刷新或切换后查询到的旧 run 生效；刚在当前 tab 启动的 run 仍可能被外层视为不存在。一旦后端 metadata、UI 操作或其它窗口把同一 session 的 `panelSplitEnabled` 置回 false，`showAgentTeamTool` 会变 false，`TerminalPreviewPanel` 会把 active tool 退回 Preview，违反“active run 优先保留 Agent Team tab”契约。
- 证据：`startFlow` 只 `setRun(next)`，没有回调父层；`showAgentTeamTool` 依赖 `activeAgentTeamRunPresent || pendingAgentTeamSessionId === activeSession.terminalSessionId || (panelSplitEnabled && activeAgentTeamAvailable)`，而 pending 状态会在 `panelSplitEnabled` 成功后清空。测试文档 `docs/testing/agent-team-loop-engineer-test-cases.md:174` 到 `docs/testing/agent-team-loop-engineer-test-cases.md:185`、`:221` 到 `:233` 明确要求 active run 即使 `panelSplitEnabled=false` 也保留并恢复 Agent Team tab。
- 修复方向：让 `TerminalAgentTeamPanel` 在 start/resume/status 变为 active run 时通知父层，或把 active run 查询抽成可刷新回调，在 `startAgentTeamRun` 成功后立即更新 `activeAgentTeamRunSessionId`。仅依赖 session 切换时查询不足。

### P2 一般：回归覆盖文档已承接旧 orchestrator 用例，但本轮没有可执行浏览器证据

- 定位：`docs/README.md:29`、`docs/testing/agent-team-loop-engineer-test-cases.md:95`、`docs/testing/agent-team-loop-engineer-test-cases.md:840`
- 风险：删除旧 Multi-Agent Orchestrator 测试文档后，`agent-team-loop-engineer-test-cases.md` 确实覆盖了新 Agent Team 入口、active run 恢复、启动失败和冲突场景；但当前仓库可执行 Playwright E2E 仍未看到针对本次改动的新增覆盖或执行证据。对 UI tab 可见性、右键入口、启动失败恢复这类浏览器行为，仅靠静态检查和测试文档不足以证明回归已关闭。
- 修复方向：合入前由行为验收 worker 使用 `$playwright-cli` 至少覆盖 AGT-ENTRY-002、AGT-BOOT-003、AGT-START-001、AGT-START-005，并记录截图/DOM/run JSON 证据。

## 验证记录

- `git diff --check`：通过。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter ./frontend lint`：通过。
- `pnpm lint`：通过。
- 未执行 `$playwright-cli`：本轮角色是代码审查，未启动浏览器做页面验收；由于最终结论要求后续修复，浏览器验收应在修复后由验收 worker 执行。

## 残余风险

- 本轮审查基于当前 live worktree diff，没有重审历史中已合入的大型 Agent Team 替换全量文件。
- 工作区已有未跟踪报告 `docs/review/2026-07-04-agent-team-loop-engineer-code-rereview.review.md`，本轮未修改或覆盖。
