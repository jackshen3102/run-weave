# Terminal Panel Agent 活动租约 Round 6 代码审查

## 结论

AGT-REVIEW-GATE 不通过。Round 5 已关闭原 `activeCommand=null + grace 过期` 的复现，但同一 `commandName` 信任边界仍存在 1 个 open P1：当目标 Panel 已切换到 `pnpm` 等普通非 Agent 命令且活动租约已删除时，stale `commandName=codex` 仍可让迟到 `Stop` 被记录，并把 Panel 写成 `agent_idle/codex`；completion 入口也会记录同一错误事件。

## 审查边界

- Round 5 修复：`backend/src/terminal/agent-hook-processor.ts` 与 `backend/src/routes/terminal-completion.ts`。
- 关联契约：Panel activity lease、operation generation、hook/completion source gate。
- 独立复核：Round 5 的结构证据、Round 5 behavior_verify 的 AR-GRACE-001/002 真实产品证据，以及本轮重新执行的 processor/router harness。
- 排除：当前工作树中与 Terminal activity lease 无关的 Agent Team 编排改动。
- 本轮只评审，不修改业务代码，不重复启动 Dev Session。

## Findings

### P1：非 Agent activeCommand 仍可被 stale commandName 覆盖

Round 5 新增的条件仅要求 `targetActiveCommand !== null`，随后就允许请求携带的 `commandName` 满足 current match（`backend/src/terminal/agent-hook-processor.ts:232-242`、`backend/src/routes/terminal-completion.ts:165-177`）。该条件没有验证 Backend 当前观察到的目标命令是否属于同一 Agent。

可执行 review harness 使用两个 running Panel，Panel B 设置为：

- `activeCommand=pnpm`
- `terminalState=shell_running/null`
- `recentAgentActivity=null`
- operation generation 仍为 `op-1/codex`
- 请求携带匹配 operation 与 `commandName=codex`

调用真实 `processTerminalAgentHook` 后返回：

```json
{
  "status": "recorded",
  "terminalState": { "state": "agent_idle", "agent": "codex" },
  "panelId": "panel-b"
}
```

同一 harness 通过真实 Express completion router 返回 `event-1`，`completionEventService.record` 被调用 1 次。作为对照，原 31 秒/null-target 场景现在正确返回 `ignored/inactive_agent`，说明本轮发现是修复不完整，不是旧结果复用。

这违反现有契约：Agent command 切到普通非 Agent command 必须删除租约并立即终止 grace（`docs/plans/2026-07-16-terminal-panel-agent-run-grace.md:54-65`）；`Stop` 只有在目标 Panel 当前仍属于该 Agent，或同一活动租约处于有效 grace 时才能写状态（`docs/architecture/terminal-state.md:44-52`）。

修复方向：对 `Stop` 和 hook-stop completion，只有 Backend 当前 `targetActiveCommand` 本身与 Agent 匹配时才能走 current-command 分支；请求携带的 `commandName` 不能推翻一个明确的、不同的 Backend target command。非 Stop hook 若仍需兼容 reported command，应保持单独规则。

## 独立检查

- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `git diff --check`：通过。
- 相关两文件 diff SHA-256：`140fc284bc968768fa8be3417d0d59f1caf4ab323195906a162cf4c2da405d66`。
- `pnpm --filter ./backend exec tsx <inline processor + completion review harness>`：原 31 秒/null-target 返回 ignored；非 Agent target 的 hook 返回 recorded，completion `recordCalls=1`。

## 验证边界

Round 5 behavior_verify 已用真实 Beta Dev Session 证明 AR-GRACE-001 与 AR-GRACE-002 通过；本轮 finding 的前置条件是目标已经切到普通非 Agent 命令，不冒充 AR-GRACE-002。由于当前 `reviewTarget=null`，这不是 formal final-review case mapping；修复后应由同一 review harness 重放，并补一个真实产品场景确认普通命令不会被迟到 Stop 覆盖。
