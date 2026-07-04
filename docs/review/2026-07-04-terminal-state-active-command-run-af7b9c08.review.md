# TerminalState activeCommand 本 run 代码审查

## 审查范围

- Run: `atr_af7b9c08_20260704130539`
- Role: `code_review`
- 意图：审查改动与回归覆盖
- 当前 live diff：
  - `backend/src/agent-team/agent-readiness.ts`
  - `backend/src/agent-team/service.ts`
  - `backend/src/terminal/terminal-state-service.ts`
  - `backend/src/terminal/tmux-service.ts`
  - `backend/src/ws/terminal-server.ts`
  - `docs/testing/terminal-state-test-cases.md`
  - `packages/shared/src/terminal-agent-readiness.ts`

本次审查只覆盖分配的 code_review 意图，不接管主控调度，不修改源码逻辑。报告写入 `docs/review/` 是 review-only 流程允许的归档动作。

## 结论

发现 2 个 P1 级正确性/回归覆盖问题。

当前 diff 的主体方向是正确的：`TerminalStateService` 的 agent 判断已经收窄到只依赖当前 `activeCommand`，避免 session 原始启动 `command="codex"` 复活 Codex 状态；tmux metadata 增加 `activeCommandSource` 后，WebSocket 只在来源是 `pane_current_command` 且前台命令退化为 `node` 时保留已有 Node-wrapped command。

但 hook 接收链仍存在旧缺口：普通 node 前台收到 agent hook 时，会在 gate 前被改写成上报 agent command，导致文档要求的真实普通 node/shell 忽略路径仍可能失败。

另外，新增的 `publishSessionState` 参数没有完整贯彻到 worker pane readiness：`publishSessionState=false` 时仍会写 session 级 `agent_idle`，会继续把分 pane 的 readiness 结果发布成整个 terminal session 的状态。

## 关键发现

- **P1 严重：普通 node 前台仍可能被 agent hook 重新污染为 Codex/Agent 状态。** `backend/src/terminal/agent-hook-processor.ts:89` 在校验 `currentCommandMatches`、grace window、当前 `terminalState` 之前，只要 session 当前 basename 是 `node`，就调用 `updateSessionMetadata()` 把 `activeCommand` 改成 `AGENT_ACTIVE_COMMANDS[input.agent]`。随后 `backend/src/terminal/agent-hook-processor.ts:122` 读取到的 `sessionAgent` 已经是上报 agent，`backend/src/terminal/agent-hook-processor.ts:130` 的 current gate 变为通过，最终 `handleAgentHook()` 会写入 `agent_running` 或 `agent_idle`。这与 `docs/testing/terminal-state-test-cases.md:130` 的 `TS-HOOK-011` 以及 `docs/testing/terminal-state-test-cases.md:133` 的真实普通 shell/node hook 忽略契约冲突，也会削弱 `backend/src/ws/terminal-server.ts:66` 通过 `activeCommandSource` 区分真实 `pane_current_command=node` 的修复效果。修复方向：不要在非 `SessionStart` hook 的 gate 前无条件把 `node` 改写成 agent；Node-wrapped agent 的兼容应来自真实 shell hook/tmux `@runweave_command` 已确认的 agent command、grace window、或已有同 agent `terminalState`，普通 node 前台必须保持 ignored。
- **P1 严重：`publishSessionState=false` 仍会发布 session 级 agent idle，worker pane readiness 会污染主 session 状态。** `backend/src/agent-team/agent-readiness.ts:57` 定义了 `publishSessionState = target?.publishSessionState ?? !target`，而 `backend/src/agent-team/service.ts:485` 启动 worker pane 时只传 `{ panelId }`，因此 worker pane 默认是 `publishSessionState=false`。但 `backend/src/agent-team/agent-readiness.ts:200` 进入 false 分支后，在检测到 worker pane 的 Codex UI 后仍调用 `terminalStateService.setAgentIdle(session.id, agent)`，把 worker pane 的 ready 结果写入 session 级 terminal state。这与参数名和 `backend/src/agent-team/service.ts:222` 为 main panel 显式传 `publishSessionState: true` 的设计相反，会让多 pane 场景中非主 pane 的 Codex 状态继续影响 App/home/CLI/handoff 看到的整个 session 状态。修复方向：`publishSessionState=false` 分支只用 scrollback 判断 ready 并返回，不调用 `setAgentIdle()` / `setAgentStarting()`；如果需要面向 panel 展示 readiness，应引入 panel 级状态，不复用 session 级 `TerminalStateService`。

## 覆盖判断

- 已覆盖的静态不变量：
  - `backend/src/terminal/terminal-state-service.ts:12` 的 `TerminalStateSessionSnapshot` 已移除原始 `command`。
  - `backend/src/terminal/terminal-state-service.ts:214` 的 `getTerminalSessionAgent()` 只读取当前 `activeCommand`。
  - `backend/src/terminal/tmux-service.ts:34`、`backend/src/terminal/tmux-service.ts:499`、`backend/src/terminal/tmux-service.ts:750`、`backend/src/terminal/tmux-service.ts:1158` 已把 `activeCommandSource` 贯穿 metadata 读取。
  - `backend/src/ws/terminal-server.ts:66` 只在 `nextActiveCommandSource === "pane_current_command"` 且 next basename 为 `node` 时保留已有 command。
  - `backend/src/agent-team/service.ts:222` 已为 main panel 显式传入 `publishSessionState: true`，说明该参数确实用于区分主 pane 与 worker pane 的 session 状态发布边界。
  - `packages/shared/src/terminal-agent-readiness.ts:8` 删除仅凭 `›` 的 ready 识别，降低空提示符误判 Codex ready 的概率；但需要由真实 Codex TUI 启动验收确认不会漏判当前版本 UI。
- 未闭合的回归覆盖：
  - `TS-HOOK-011`、`TS-HOOK-014`、`TS-HOOK-015` 仍需要覆盖真实普通 node/shell 前台、非 grace window、无同 agent 当前状态的 hook ignored 路径。
  - `TS-API-007/008`、`TS-WS-003`、`TS-HOME-006`、`TS-CLI-005` 仍需要行为验收 worker 使用真实 terminal session、真实 shell hook/tmux metadata、真实 API 流量和必要浏览器操作补证。
  - Agent Team 主 pane 启动、worker pane 启动、worker pane ready 后 App/home/CLI/handoff 的 session 状态，需要用真实 split pane 验证 `publishSessionState` 的边界。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过，9 个 workspace project typecheck 完成。
- `pnpm lint`：通过，9 个 workspace project lint 完成。
- 静态阅读范围：
  - `backend/src/terminal/terminal-state-service.ts`
  - `backend/src/terminal/tmux-service.ts`
  - `backend/src/ws/terminal-server.ts`
  - `backend/src/terminal/agent-hook-processor.ts`
  - `backend/src/agent-team/agent-readiness.ts`
  - `backend/src/agent-team/service.ts`
  - `backend/src/routes/terminal.ts`
  - `backend/src/routes/terminal-completion.ts`
  - `packages/shared/src/terminal-agent-readiness.ts`
  - `docs/testing/terminal-state-test-cases.md`

## 残余风险 / 待确认

- 当前本地 `main` 落后 `origin/main` 1 个提交，本报告基于当前 dirty worktree live diff；合入前应由主控决定是否先同步远端主分支并重新跑审查/验证。
- 未执行浏览器或真实终端行为验收；本 worker 只承担 code_review，不替代 behavior_verify。
