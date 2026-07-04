# agent completion fallback 代码评审

## 评审范围

- 评审对象：当前工作区 `HEAD` vs worktree diff。
- 涉及文件：
  - `backend/src/app-server/handlers/agent-completion.ts`
  - `backend/src/index.ts`
- 评审类型：代码评审，只读；未修改源码、配置、测试。

## 结论

有 1 个 P1 正确性风险和 1 个 P2 架构/测试契约风险。构建、类型、lint 和现有 hook 验证通过，但新增 fallback 的关键分支目前没有直接覆盖。

## 发现

- **P1 严重：completion fallback 在进入共享 processor 前先用 `getCurrent()` 过滤，会跳过 `node` activeCommand 的既有修正路径。** 新 handler 只有在 `currentState.state === "agent_running"` 且 `currentState.agent === agent` 时才调用 `processTerminalAgentHook`，但 `TerminalStateService.getCurrent()` 需要当前 `activeCommand` 或 `command` 能识别出 agent；当 Stop hook bridge 自身以 `node` 运行时会返回 `shell_idle`，从而直接跳过 fallback。共享 processor 本来在处理前有 `commandBasename(session.activeCommand) === "node"` 的修正逻辑，会把 activeCommand 写回对应 agent；现在这个逻辑在 completion fallback 路径上可能根本进不去。影响是直连 `/internal/terminal/agent-hook` 丢失、只剩 app-server `agent.completion` 兜底时，最需要兜底的 Stop completion 仍可能无法把终端状态校正为 idle。定位：`backend/src/app-server/handlers/agent-completion.ts:34`、`backend/src/app-server/handlers/agent-completion.ts:39`、`backend/src/terminal/terminal-state-service.ts:96`、`backend/src/terminal/agent-hook-processor.ts:89`。修复方向：不要在 handler 里用 `getCurrent()` 做前置 agent/running 过滤，改为只确认 session 存在后交给 `processTerminalAgentHook` 的现有 activeCommand/grace/stored-state 规则处理；如确实要限制 fallback，只能基于 processor 之后的结果或显式读取持久 `terminalState`，不要绕开 processor 的 `node` 修正。

- **P2 一般：新增 `agent.completion` 到 `TerminalState` 的状态副作用，但现有架构文档仍声明 completion/feed 不作为状态来源，缺少明确契约和回归用例。** `docs/architecture/terminal-state.md` 明确写着 `TerminalState` 不消费 completion event/feed，状态只能由 Stop hook 或 active command 变化校正；本 diff 让 app-server `agent.completion` 的 `hook_stop`/`Stop` 事件复用 agent hook processor 写状态。这个方向可能是合理的迁移兜底，但需要把它定义成“只针对 app-server hook_stop Stop completion 的受限 fallback”，否则后续维护者会按文档假设 completion 没有状态副作用。当前 `pnpm toolkit:verify-hooks` 只证明 hook bridge 会双写 app-server completion，并没有覆盖 backend consumer 收到 completion 后是否正确/不误写状态。定位：`backend/src/app-server/handlers/agent-completion.ts:55`、`docs/architecture/terminal-state.md:85`、`docs/testing/app-server-event-center-test-cases.md:139`。修复方向：补齐架构/测试契约，或把状态校正严格收敛到 `agent.hook` consumer；若保留 completion fallback，增加隔离 runtime/backend smoke 覆盖 `agent_running + app-server agent.completion Stop -> agent_idle`、重复 `agent.hook + agent.completion` 不重复发布、以及 `notify/manual/ai_process_exit` 不写状态。

## 验证

- `git status --short`：仅有两个源码改动文件。
- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm toolkit:verify-hooks`：通过，现有 hook bridge 双写 app-server/backend fallback 的验证仍正常。

## 残余风险

- 未执行浏览器验证；本次 diff 是 backend app-server consumer 状态处理，不涉及浏览器页面复现或验收。
- 未执行完整 app-server/backend runtime smoke；现有脚本覆盖 hook 双写和 app-server 协议，但没有直接覆盖新增 `handleAgentCompletionEvent` 的状态副作用。
