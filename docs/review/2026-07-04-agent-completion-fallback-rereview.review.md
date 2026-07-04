# agent completion fallback 代码复评

## 评审范围

- 评审对象：当前工作区 `HEAD` vs worktree diff。
- 涉及文件：
  - `backend/src/app-server/handlers/agent-completion.ts`
  - `backend/src/index.ts`
  - `docs/architecture/terminal-state.md`
- 说明：上一轮生成的 `docs/review/2026-07-04-agent-completion-fallback.review.md` 是既有归档产物，未作为本次源码/方案变更评审对象。
- 评审类型：代码 + 架构文档复评，只读；未修改源码、配置、测试。

## 结论

上一轮 P1 的前置 `getCurrent()` 过滤问题已经修正：当前实现只确认 session 存在，然后进入共享 `processTerminalAgentHook()`，能复用 active command、grace window、session 生命周期和 source gate 规则。

本轮未发现 P0/P1 阻断或严重问题。仍有 1 个 P2：测试契约和自动化覆盖没有跟上新增的 app-server completion fallback 状态副作用。

## 发现

- **P2 一般：新增 `agent.completion` 状态 fallback 后，测试契约仍保留旧的“completion 不改变 TerminalState”边界，且没有直接覆盖 backend consumer 状态写入。** 代码现在会把 app-server `agent.completion` 中 `completionReason="hook_stop"` 且 `rawHookEvent/hookEvent` 为 Stop/SubagentStop 的事件规范化为 `Stop` hook 并进入 `processTerminalAgentHook()`；架构文档也补充了这个受限例外。但 `docs/testing/terminal-state-test-cases.md` 仍写着 completion 不作为 TerminalState 副作用，`docs/testing/app-server-event-center-test-cases.md` 也仍说 “full backend runtime smoke can be added if this path later gains user-visible side effects”。现在这个 path 已经有 user-visible 状态副作用，现有 `toolkit:verify-hooks` 只验证 hook bridge 会写 `agent.completion`，`app-server:verify` 只验证事件中心协议，不验证 backend consumer 收到 completion 后是否把 `agent_running` 校正为 `agent_idle`，也不验证 notify/manual/ai_process_exit 不写状态。定位：`backend/src/app-server/handlers/agent-completion.ts:45`、`docs/architecture/terminal-state.md:41`、`docs/testing/terminal-state-test-cases.md:186`、`docs/testing/terminal-state-test-cases.md:194`、`docs/testing/app-server-event-center-test-cases.md:139`。修复方向：更新测试文档，把“不改变 TerminalState”限定为 `/internal/terminal-completion` 和普通 completion feed；新增一个隔离 backend/app-server smoke 或现有验证脚本分支，覆盖 `agent_running + app-server hook_stop Stop completion -> agent_idle`、重复 `agent.hook + agent.completion` 不重复发布、以及 notify/manual/ai_process_exit 不写状态。

## 已确认的修复点

- `backend/src/app-server/handlers/agent-completion.ts:34` 当前只用 `getSession()` 做存在性检查，没有再用 `TerminalStateService.getCurrent()` 作为前置 agent/running gate；上一轮指出的绕过 `processTerminalAgentHook()` 中 `node` activeCommand 修正路径的问题已解除。
- `docs/architecture/terminal-state.md:41` 和 `docs/architecture/terminal-state.md:89` 已把 app-server `hook_stop + Stop` completion 定义为受限 fallback，而不是新的 completion 状态机。

## 验证

- `git status --short`：源码 diff 为两个 backend 文件 + 一个架构文档文件；另有上一轮 review 报告未跟踪。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm toolkit:verify-hooks`：通过。
- `pnpm app-server:verify`：通过。

## 残余风险

- 未执行浏览器验证；本次 diff 是 backend app-server consumer 状态处理和架构文档更新，不涉及浏览器页面复现或验收。
- 未执行完整 backend consumer runtime smoke；现有通过的脚本仍不能直接证明新增 `handleAgentCompletionEvent()` 状态副作用。
