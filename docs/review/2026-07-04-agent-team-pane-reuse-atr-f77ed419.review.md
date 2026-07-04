# Agent Team pane 复用审查

- Run: `atr_f77ed419_20260704131314`
- Role: `code_review`
- 意图：审查改动与回归覆盖
- 审查对象：当前 live worktree diff
- 审查时间：2026-07-04

## 结论

当前 diff 的静态质量门禁已通过，但仍有 1 个 P1 行为风险：`processTerminalAgentHook()` 在普通 `activeCommand=node` 前台收到 Codex hook 时，会先把 session metadata 反写为 `codex`，导致后续 gate 认为当前仍是 Codex。这个行为与本次文档新增的 TS-HOOK-011/014 目标契约冲突，也会削弱 `TerminalStateService` 改为只信当前 `activeCommand` 的修复价值。

AGT-PANE-004 主目标方向基本正确：worker panel 现在带 `agentTeamRunId` / `agentTeamWorkerId`，复用逻辑限定同 run + alias + role；手工 split pane 会以 `agentTeamRunId=null`、`role=null` 进入 workspace，不会被错当本 run worker。

## 关键发现

### P1 严重：普通 node 前台会被迟到 Codex hook 重新标成 Codex

- 位置：`backend/src/terminal/agent-hook-processor.ts:89`
- 影响：当前代码在进入 hook gate 前，只要 `session.activeCommand` 的 basename 是 `node`，就执行 `updateSessionMetadata(... activeCommand: AGENT_ACTIVE_COMMANDS[input.agent])`。如果用户已经从 Codex 回到 shell 并运行普通 `node`，迟到的 `UserPromptSubmit` / `Stop` hook 会先把 `activeCommand` 改成 `codex`，随后 `currentCommandMatches` 变成 true，最终写入 `agent_running/codex` 或 `agent_idle/codex`。
- 为什么是回归风险：本次 `TerminalStateService` 已改为只根据当前 `activeCommand` 判断 agent，目标是避免原始 `command="codex"` 污染当前 shell 状态；但 hook processor 的 node 兜底会在更早阶段制造新的 `activeCommand="codex"`，等价于把已修复的 stale 状态从 session 原始 command 转移到了 hook 链路。
- 与测试文档冲突：`docs/testing/terminal-state-test-cases.md:130` 要求 `activeCommand="node"` + `UserPromptSubmit` 保持 `shell_idle/null` 并 ignored；`docs/testing/terminal-state-test-cases.md:133` 要求真实普通 shell/node 前台、非 grace window、服务端当前不是 Codex 状态时忽略。
- 修复方向：删除或收窄 `activeCommand=node` 的无条件反写。若要兼容 node 包裹的 Codex，应只在有可信来源证明该 node 是 Codex wrapper 时转换，例如 shell hook 的 `@runweave_command=codex`、明确的 hook payload 标记、或当前 session 已在 Codex grace/agent state 内；不能对普通 node 进程一概提升为 Codex。

## 已确认

- `backend/src/agent-team/service.ts` 的 worker panel 复用现在要求 `panel.agentTeamRunId === runId`，并使用 `agent-team:<runId>:<role>` 作为 panel role，能避免同名手工 pane 或旧 run pane 被误复用。
- `backend/src/routes/terminal-panel-routes.ts` 为默认 pane 和手工 split pane 写入 `agentTeamRunId=null` / `agentTeamWorkerId=null`，与 worker 归属字段区分清楚。
- `backend/src/terminal/terminal-state-service.ts` 已移除对 session 原始 `command` 的 fallback，状态判断只来自当前 `activeCommand`。
- `backend/src/terminal/tmux-service.ts` 增加 `activeCommandSource`，`backend/src/ws/terminal-server.ts` 只在 `pane_current_command=node` 且既有命令是被 node 包裹的命令时保留旧 activeCommand，避免 shell hook 明确清空或上报的命令被错误覆盖。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过
- `pnpm typecheck`：通过
- `pnpm lint`：通过

说明：审查期间工作区有并发更新，早先一次 `pnpm typecheck` 曾因 `buildSplitPanel()` 调用缺少 `agentTeamRunId` / `agentTeamWorkerId` 失败；最新 live worktree 已补齐并复测通过。

## 残余风险

- 本次没有执行浏览器级 `$playwright-cli` 验收；作为 code_review worker，本轮只做代码审查与静态校验。AGT-PANE-004 仍需要 behavior verifier 用真实页面和真实 tmux pane 验证：先手工 split，再启动 Agent Team，确认既有 pane 保持手工 pane，worker alias/role 不冲突。
- hook 链路目前缺少能覆盖 TS-HOOK-011/014 的真实路径自动化证据。修复 P1 后，应至少用内部 hook API 或真实 Codex hook 路径验证普通 node 前台不会被迟到 hook 重新标记为 Codex。
