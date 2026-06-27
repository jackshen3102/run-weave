# Terminal Panel Split 代码与计划评审

## 评审范围

- 当前分支：`main`，相对 `origin/main` 落后 4 个提交。
- 当前未提交改动：终端 panel split 相关后端、shared protocol、CLI、frontend、Electron hook、计划文档、测试文档与 prototype。
- 评审模式：`$toolkit:review-only`，只读评审；除本报告外未修改源码、配置、测试或计划。

## 结论

当前实现不建议直接合入。核心 panel split API、store、CLI 和 UI 的方向与计划基本一致，但存在一个会阻断现有 hook/app-server 事件链路的兼容性问题，需要先修复。

## 发现

### P1 严重：`terminalPanelId` 会让 app-server 拒收所有新增 hook scope

- 影响：Electron hook bridge 现在总是在 app-server event `scope` 中带上 `terminalPanelId`，即使没有 panel 也会传 `null`。但 app-server 的 `scopeSchema` 仍是 `.strict()`，只允许 `projectId`、`terminalSessionId`、`runId`、`cwd`。结果是 `agent.hook` / `agent.completion` 请求会在 `/events` 被 400 拒绝，既拿不到 panel metadata，也会破坏现有 session 级 agent 状态/完成通知链路。
- 证据：
  - `electron/resources/hooks/runweave-hook-bridge.cjs:450` 读取 `RUNWEAVE_TERMINAL_PANEL_ID || null`，`electron/resources/hooks/runweave-hook-bridge.cjs:458` 到 `electron/resources/hooks/runweave-hook-bridge.cjs:461` 把 `terminalPanelId` 放进 `scope`。
  - `electron/src/hooks/hook-launcher-script.ts:75` 也把 `terminalPanelId` 传入生成脚本。
  - `app-server/src/http-server.ts:27` 到 `app-server/src/http-server.ts:34` 的 `scopeSchema.strict()` 未包含 `terminalPanelId`。
  - `app-server/src/http-server.ts:127` 到 `app-server/src/http-server.ts:134` 会对 schema 失败直接返回 400。
- 修复方向：同步更新 app-server 的 `scopeSchema`，允许 `terminalPanelId: z.string().trim().min(1).nullable().optional()`；同时补一条 app-server event schema 冒烟用例或脚本化校验，覆盖 `terminalPanelId: null` 和真实 panel id 两种 payload。

### P2 一般：同长度 workspace 事件会被前端丢弃，panel chip 可能不更新

- 影响：前端处理 `terminal_panel_*` 事件时，只比较 `activePanelId` 和 `panels.length`。如果 panel 的 alias、role、status、activeCommand、tmuxPaneId 或 focused 状态变化，但 active id 和数量不变，UI 会跳过更新。后端 `ensureTmuxPanelWorkspace` 会在 pane metadata 变化、stale pane 收敛、panel updated 时发 workspace；这些变化可能表现为 chip label/status 不刷新。
- 证据：
  - `frontend/src/components/terminal/terminal-workspace-events.ts:117` 到 `frontend/src/components/terminal/terminal-workspace-events.ts:123` 在 active id 和数量相同就 `continue`。
  - `backend/src/routes/terminal-panel-routes.ts:267` 到 `backend/src/routes/terminal-panel-routes.ts:277` 会更新 panel `cwd`、`activeCommand`、`status`。
  - `backend/src/routes/terminal-panel-routes.ts:319` 到 `backend/src/routes/terminal-panel-routes.ts:330` 会把更新后的 workspace 放进 `terminal_panel_updated` 事件。
- 修复方向：前端不要只用数量判断 workspace 等价；可以比较 workspace revision/event id，或按 `panelId + alias + role + status + focused + activeCommand + tmuxPaneId` 做轻量签名。

## 残余风险

- 本次没有启动真实 dev server，也没有用 `$playwright-cli` 做浏览器验收；因为当前是 review-only，且评审已在静态层发现阻断问题。
- 未执行真实 tmux split/create/send/close 流程；后续修复 P1 后仍需要按 `docs/testing/terminal-panel-split-test-cases.md` 跑 tmux API、CLI 和 Web 主路径。

## 已执行验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
