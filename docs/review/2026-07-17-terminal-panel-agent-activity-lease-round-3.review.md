# Terminal Panel Agent 活动租约 Round 3 代码审查

## 结论

AGT-REVIEW-GATE 不通过。独立审查确认 1 个仍开放的 P1：`Stop` 的 30 秒 grace 可以被请求中的 stale `commandName` 绕过，导致过期事件重新把已退出 Agent 的 Panel 写成 `agent_idle/codex`。

## 审查边界

- 功能闭包：`e622458^` 到当前工作树中的 Terminal Panel activity lease、Panel/operation identity、hook/completion gate，以及 Round 3 对 `backend/src/terminal/application/panel-metadata.ts` 的一行修复。
- 排除：当前工作树内与本修复无关的 Agent Team verify-first 编排改动。
- 本轮是只读代码审查；未改业务代码，未重跑 Playwright 行为用例。

## Findings

### P1：stale `commandName` 可绕过 grace 过期门禁

本轮把 `@runweave_command` 仍为 Agent、但 `pane_current_command` 已回到交互 shell 的 Panel 归一化为 `activeCommand=null`（`backend/src/terminal/application/panel-metadata.ts:265-272`）。但 hook bridge 仍优先使用 `@runweave_command` 生成 `commandName`（`electron/resources/hooks/runweave-hook-payload.cjs:97-106`），而 agent hook processor 又把 `input.commandName` 作为独立的 `currentCommandMatches` 依据（`backend/src/terminal/agent-hook-processor.ts:226-250`）。因此，即使目标 Panel 已为 `activeCommand=null` 且 `clearedAt` 超过 30 秒，只要 stale `commandName=codex` 仍随请求上报，过期 `Stop` 就不会走 grace 失败分支。

可执行 review harness 使用两个 running Panel、Panel B `activeCommand=null`、同一 operation generation、`clearedAt=now-31s` 和 `commandName=codex` 调用真实 `processTerminalAgentHook`。实际返回：

```json
{
  "status": "recorded",
  "terminalState": { "state": "agent_idle", "agent": "codex" },
  "panelId": "panel-b"
}
```

这直接违反 `docs/testing/terminal/terminal-agent-run-grace-test-cases.md:35-40,86-104` 的 AR-GRACE-002：grace 超过 30 秒必须返回 `ignored/inactive_agent`，Panel 保持非 Agent 状态。相同的 `commandName` 绕过模式也存在于 completion gate（`backend/src/routes/terminal-completion.ts:165-185`）。

修复方向：当 `Stop` 的目标 scope 已是 `activeCommand=null` 时，不得再用请求携带的 `commandName` 证明 Agent 当前活跃；必须仅由同 Panel、同 Agent、同 operation 且未过期的 grace 租约放行。completion 入口应保持同一规则。修复后应补跑 AR-GRACE-002，并覆盖带 `commandName=codex` 的真实 hook body。

## 独立检查

- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `git diff --check`：通过。
- `pnpm --filter ./backend exec tsx <inline review harness>`：确认上述过期 Stop 被错误记录。

## 验证边界

AR-GRACE-001 的现有真实产品 After 证据表明 Round 3 修复可接收 1 ms 内的 Stop；本审查发现的是尚未执行的 31 秒边界。P1 修复后仍需由 behavior_verify 按真实产品路径执行 AR-GRACE-002，不能用本 review harness 代替最终行为验收。
