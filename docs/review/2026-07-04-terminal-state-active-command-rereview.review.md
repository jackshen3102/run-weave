# TerminalState activeCommand 复审

## 审查范围

- Run: `atr_d164c24a_20260704130233`
- Role: `code_review`
- 当前工作区 diff：
  - `backend/src/terminal/terminal-state-service.ts`
  - `backend/src/terminal/tmux-service.ts`
  - `backend/src/ws/terminal-server.ts`
  - `docs/testing/terminal-state-test-cases.md`

本次审查只覆盖当前 live diff 及其直接调用链，不接管主控调度，不修改源码逻辑。

## 结论

发现 1 个 P1 正确性/回归覆盖问题。当前 diff 已把 `TerminalStateService` 的 agent 判断改成只依赖当前 `activeCommand`，方向正确；但 hook 接收链仍会把任意 `activeCommand="node"` 的 session 在 gate 前改写成上报的 agent command，导致文档新增/保留的 `TS-HOOK-011`、`TS-HOOK-014` 目标契约在真实普通 node 前台路径下仍不成立。

## 关键发现

- **P1 严重：普通 node 前台仍可能被 agent hook 重新污染为 Codex/Agent 状态。** `backend/src/terminal/agent-hook-processor.ts:89` 在校验 `currentCommandMatches`、grace window、当前 `terminalState` 之前，只要 session 当前 basename 是 `node`，就把 `activeCommand` 更新成 `AGENT_ACTIVE_COMMANDS[input.agent]`。因此普通 shell/node 前台收到 `UserPromptSubmit` 或 `Stop` 时，会先被改写成 `codex`/`trae`，随后 `backend/src/terminal/agent-hook-processor.ts:130` 的 current gate 变为通过，最终 `handleAgentHook()` 写入 `agent_running` 或 `agent_idle`。这与 `docs/testing/terminal-state-test-cases.md:130` 的 `TS-HOOK-011` 以及 `docs/testing/terminal-state-test-cases.md:133` 的真实普通 shell/node hook 忽略契约冲突，也会削弱本次 `backend/src/ws/terminal-server.ts:66` 通过 `activeCommandSource` 区分 `pane_current_command=node` 的修复效果。修复方向：不要在非 `SessionStart` hook 的 gate 前无条件把 `node` 改写成 agent；Node-wrapped agent 的兼容应来自真实 shell hook/tmux `@runweave_command` 已确认的 agent command、grace window、或已有同 agent `terminalState`，普通 node 前台必须保持 ignored。

## 残余风险 / 待确认

- 真实路径回归仍需要由行为验收覆盖。代码审查已确认静态问题点，但 `TS-API-007/008`、`TS-WS-003`、`TS-HOME-006`、`TS-CLI-005`、`TS-HOOK-011/014/015` 仍需要使用真实 terminal session、真实 shell hook/tmux metadata、真实 API 流量和必要的浏览器操作验证。
- 当前工作区已有未跟踪报告 `docs/review/2026-07-04-terminal-state-active-command.review.md`，其中结论为未发现 P1。本复审结论以当前 live code 调用链为准。

## 验证

- `git diff --check`：通过。
- `pnpm typecheck`：通过，9 个 workspace project typecheck 完成。
- `pnpm lint`：通过，9 个 workspace project lint 完成。
- 静态检索：`rg -n "activeCommandSource|shouldKeepExistingActiveCommand|TmuxPaneMetadata|getTerminalSessionAgent|isCodexSession|isCodexActiveCommand|lastAiActiveCommand|setShellActiveCommand|handleAgentHook|command=\"codex\"|activeCommand=\"node\"" backend frontend packages docs/testing/terminal-state-test-cases.md`。

## 证据摘要

- `backend/src/terminal/terminal-state-service.ts:214` 的 `getTerminalSessionAgent()` 现在只读取 `activeCommand`，不再读取 session 原始 `command`。
- `backend/src/terminal/tmux-service.ts:499` / `backend/src/terminal/tmux-service.ts:750` 会产出 `activeCommandSource`，区分 `@runweave_command` 与 `pane_current_command`。
- `backend/src/ws/terminal-server.ts:66` 的保留旧 command 逻辑只在 `nextActiveCommandSource === "pane_current_command"` 且下一个命令 basename 为 `node` 时触发。
- `backend/src/terminal/agent-hook-processor.ts:89` 仍在 hook gate 前把当前 `node` 改写为上报 agent command，是本次发现的回归缺口。
