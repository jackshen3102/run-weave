# Terminal Panel Agent 活动租约 Round 7 代码审查

## 结论

AGT-REVIEW-GATE 通过。本轮未发现 open P0/P1；Round 6 的 `terminal.stop-grace-expiry-command-name-bypass` 已关闭。Backend 现在同时校验当前目标命令来源、事件来源与上报命令来源，`activeCommand=pnpm` 时 stale `commandName=codex` 不再覆盖目标 Panel。

## 审查边界

- 变更：`backend/src/terminal/agent-hook-processor.ts` 与 `backend/src/routes/terminal-completion.ts`。
- 关联契约：Panel activity lease、operation generation、hook/completion source gate。
- 独立复核：调用真实 processor 与真实 Express completion router 的结构化 harness，并检查当前 diff。
- 排除：工作树中与 Terminal activity lease 无关的 Agent Team 编排改动。
- 本轮只评审，不修改业务代码，不启动 Dev Session。

## Findings

无 open P0/P1。

## 已关闭 Finding

### P1：非 Agent activeCommand 可被 stale commandName 覆盖

稳定 invariant key：`terminal.stop-grace-expiry-command-name-bypass`。

修复后的 processor 与 completion router 均先由 Backend 当前 `targetActiveCommand` 解析 `targetCommandSource`，且只有该来源同时等于事件来源和上报 `commandName` 来源时，才允许 reported-command 分支命中（`backend/src/terminal/agent-hook-processor.ts:227-244`、`backend/src/routes/terminal-completion.ts:165-178`）。因此，请求侧的 stale `commandName` 已不能推翻明确的非 Agent Backend target。

独立 executable harness 的结果：

- `activeCommand=pnpm`、无活动租约、`commandName=codex`：processor 返回 `ignored/inactive_agent`，Panel B 保持 `shell_running/null`；completion 返回 `{ event: null, ignored: true }`，`recordCalls=0`。
- `activeCommand=null`、grace 已过 31 秒：processor/completion 均拒绝。
- `activeCommand=null`、grace 仅 1 秒：processor/completion 均接受。
- `activeCommand=codex`：processor/completion 均接受。

上述结果关闭了 Round 6 的非 Agent target 复现，同时保留宽限期和当前 Agent 命令的合法正向路径。

## 独立检查

- `pnpm --filter ./backend exec tsx <inline processor + completion review harness>`：四组边界矩阵符合预期。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `git diff --check`：通过。
- 相关两文件 diff SHA-256：`881f3a3f0a330b01a884bd56f3fefa1a584ed539a0dcfa55347f80e999c04791`。

## 验证边界

本轮为结构化代码复审，未重复启动真实产品 Dev Session。Round 5 已留存 AR-GRACE-001/002 的真实产品证据；本轮独立 harness 专门验证 Round 6 阻断项及其相邻正负边界。
