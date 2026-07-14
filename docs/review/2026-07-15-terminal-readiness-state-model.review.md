# Terminal Readiness 状态模型评审

## 结论

当前生产链路已经完成迁移：Terminal 与 Agent Team 不再读取 scrollback、TUI banner、状态行、输入提示符或其它界面文案来判断 readiness。同步启动接口只确认带 `operationId` 的命令已经提交；`agent_idle` / `agent_running` 由匹配 panel、provider、operation/thread 的可信 lifecycle 事件推进；worker 完成由独立的 dispatch/outbox 状态推进。

因此，readiness 的权威来源已经完全改为状态与 operation。TUI 文案只属于用户可见输出，不再是状态输入，也不保留共享 parser 或生产导出。

## 当前权威链路

### Agent launch operation

- `AgentTeamAgentLaunchService.submitAgentLaunch()` 解析目标 provider/panel 后调用 `prepareTerminalAgent()`，不读取 pane 输出。
- `prepareTerminalAgent()` 在 launch command 中携带 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID`，并把正式 prompt 作为唯一 initial query。
- `sendInputToSession()` 成功后才持久化 `agent_starting`，响应返回 `phase: "command_submitted"` 与 `commandSubmittedAt`。
- 固定 `10000ms` 仅是 shell settle 实现细节，不是 ready 状态，也不会由 TUI 文案提前结束。

### Agent lifecycle state

- `TerminalStateService.getCurrent()` 只返回 store/session 中的权威状态；无已存 agent 状态时，根据当前 active command 保守返回 `agent_starting`。
- `SessionStart`、`UserPromptSubmit`、`Stop` 等可信 hook/App Server lifecycle 事件负责推进 `agent_idle` / `agent_running`。
- `ensureTmuxPanelWorkspace()` 只使用 pane metadata、active command 和持久状态做 reconcile，不调用 `capturePane()` 推断 ready。
- `/api/terminal/session/:id/state` 不读取 live scrollback。

### Worker dispatch/result

- worker dispatch 在 launch 前持久化 dispatch boundary，并将正式 worker prompt 作为唯一 initial query。
- worker 结果由 `dispatchId`、pane identity、freshness 与 pane-scoped outbox 决定，不借用 terminal readiness 表达业务完成。

## 已移除内容

- 删除 `packages/shared/src/terminal-agent-readiness.ts`。
- 删除 `@runweave/shared/terminal-agent-readiness` 子路径导出和 shared 根导出。
- 删除基于 Codex/TraeX TUI pattern、startup scrollback boundary 和 ready-prompt fallback 的过期 verifier。
- 保留一条反向不变量：即使输入包含 Codex/TraeX ready 文案，也不得改变 authoritative terminal state。

历史 `docs/review/2026-07-13-*` 文件记录当时实现与评审结论，不回写；现行测试契约以本评审和 `docs/testing` 下当前文档为准。

## 仍需区分的边界

以下事项不是 TUI readiness 回退，也不应重新引入文本判断：

1. launch operation 当前有 `commandSubmittedAt` 和内存 generation，但 backend 崩溃后的 milestone 恢复仍可继续增强。
2. launch command 会写入结构化 pane option `pending:<operationId>` / `exit:<operationId>:<code>`；process exit 的持久消费与 generation retirement 仍是独立的生命周期闭环问题。
3. `agent_starting` 表示命令已提交但尚未收到可信 lifecycle，不等于 UI 尚未出现某段文案。

## 验收标准

1. 仓库生产代码不存在 `terminal-agent-readiness`、`hasCodexReadyPrompt`、`hasTraeReadyPrompt` 或 `hasAgentReadyPrompt` 消费者。
2. 任意 Codex/TraeX ready 文案变化都不能改变 terminal state、dispatch gate 或 outbox 结果。
3. `command_submitted` 只在 input accepted/enqueued 后出现，并携带当前 `operationId` 与 `commandSubmittedAt`。
4. matching lifecycle event 可以推进 idle/running；stale 或 identity 不匹配的 hook 零副作用。
5. initial worker、main test-case generation、serial dispatch、recheck 与 bounce 均只提交一次包含正式 prompt 的 launch command。
6. verifier、测试用例文档和 shared 导出不再把 TUI ready 当成受支持契约。

## 验证记录

- 代码与调用链检查：完成。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-review-checkpoints`：通过；包含 `bootstrap-tui-text-does-not-advance-authoritative-state`。
- Dev Session planner：最低 profile 为 `beta`，原因是 shared 子路径导出删除会影响无法进一步收窄的桌面消费者。
- Dev Session：`dvs-25f355`，Stable control plane，frontend/backend/App Server/Electron/Beta/CDP 均为 dedicated，status 机器断言 `healthy: true`。
- Playwright：显式附着 desktop CDP `http://127.0.0.1:9335`；在真实 terminal 输出 Codex/TraeX ready 文案后，真实 `/state` 仍返回 `shell_idle / agent=null`。
- 清理：关闭本次创建的 terminal，Playwright detach，`dev:stop` 后 `5002/63303/9335/9336` 均已关闭。
