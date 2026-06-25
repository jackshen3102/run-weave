# Codex thread 在 tmux 丢失后的自动恢复方案

## 当前现状

- Codex hook 已经会把 `threadId` 写入 terminal session metadata。入口在 `backend/src/routes/terminal-state.ts`：当 `agent=codex` 且 payload 带 `threadId` 时，调用 `TerminalSessionManager.updateSessionThreadId()` 持久化。
- `threadId`、`preview`、`activeCommand` 都已经透出到 `/api/terminal/session` 与 `/api/terminal/session/:id`，字段定义在 `packages/shared/src/terminal-protocol.ts`，payload 转换在 `backend/src/routes/terminal-route-payloads.ts`。
- tmux-backed terminal 的恢复入口是 `backend/src/terminal/runtime-launcher.ts` 的 `ensureTerminalRuntime()`。当前逻辑在 `hasSession=false` 且原始 launch 是 shell 时，只会创建一个新的空 shell，并提示 “Original tmux session was lost; created a fresh terminal session”；不会使用 `threadId` 恢复 Codex。
- 终端状态文档明确：`threadId` 是 Codex 关联元数据，不能替代 `activeCommand` / hook 作为 `TerminalState` 的状态来源。因此这次优化只做“恢复入口”，不改变状态模型。

## 需求理解

目标是在 Mac 重启导致 tmux server/session 丢失后，打开原 terminal 时自动恢复 Codex thread：

- 条件 1：该 terminal 的持久化 `activeCommand` 是 `codex`。
- 条件 2：该 terminal 有 `threadId`。
- 条件 3：当前 terminal 没有正在运行的 Codex。对这次场景，最可靠的判定是 `tmuxService.hasSession(target) === false`，因为 tmux 已经丢失，不存在可读取的 pane。
- 行为：重新创建 tmux shell，并自动执行 `codex resume <threadId>`。

不建议在 `hasSession=true` 但 pane 当前不是 Codex 时自动注入 resume，因为那说明用户可能已经在同一个 terminal 里回到 shell 或运行了别的命令，自动输入会覆盖用户当前上下文。

## 推荐方案

在 `backend/src/terminal/runtime-launcher.ts` 内扩展 tmux missing-session 分支，新增一个 Codex resume recovery 分支：

1. 判断 `shouldResumeCodexThreadAfterTmuxLoss(currentSession, wasInteractiveShellLaunch)`：
   - `wasInteractiveShellLaunch === true`
   - `getAgentForCommand(currentSession.activeCommand) === "codex"`
   - `currentSession.threadId` 非空
   - `hasSession === false`
   - `allowMissingTmuxSession !== true`
2. 命中后沿用现有 `recordRebuildAttempt()` 限流，避免反复失败时无限重建。
3. 使用原 session 的 shell launch 创建 tmux session，不修改 `session.command/session.args`：
   - `createDetachedSession(target, currentSession.cwd, { command: currentSession.command, args: currentSession.args, env: existing Runweave env })`
   - `waitForPaneReady(target)`
   - `tmuxService.sendInput(target, "codex resume " + shellQuotedThreadId + "\n")`
4. warning 改成明确的恢复语义，例如：
   - `Original tmux session was lost; resumed Codex thread from saved threadId.`
5. 不主动把 `TerminalState` 写成 running/idle。让 shell integration 的 preexec metadata 和 Codex hook 自然校正 `activeCommand` / `TerminalState`。

这个方案的关键点是“恢复动作复用已有 terminal shell”，而不是把 terminal launch command 永久改成 `codex resume`。这样 Codex 退出后仍然回到用户原 shell，后续普通 terminal 行为不变。

## 修改范围

- `backend/src/terminal/runtime-launcher.ts`
  - 新增 Codex resume 判定 helper。
  - 新增 shell quoting helper，只用于安全拼接 `threadId` 到 shell input。
  - 在 `!hasSession && !allowMissingTmuxSession` 的 shell rebuild 分支前插入 Codex resume recovery。
- `backend/src/terminal/terminal-state-service.ts`
  - 如果 `getAgentForCommand()` 当前未导出给 runtime launcher 使用，可导出或新增本地 basename 判定 helper。优先复用已有 helper，避免重复 agent 命令表。
- `frontend/tests/terminal.spec.ts`
  - 新增 Playwright E2E 覆盖 tmux 丢失后自动输入 `codex resume <threadId>` 的行为。

## 验收设计

E2E 测试建议走真实 tmux，但用临时 fake `codex` 脚本避免依赖真实 Codex：

1. 创建临时 cwd，把 fake `codex` 放进 PATH：
   - 第一次运行 `codex` 时保持进程存活，模拟 Codex TUI。
   - 当收到 `resume <threadId>` 参数时，把参数写入临时文件，并保持 shell 可继续运行。
2. 创建 tmux-backed terminal，进入页面后输入 `codex`。
3. 通过 `/internal/terminal/agent-hook` 上报：
   - `agent=codex`
   - `hookEvent=SessionStart`
   - `threadId=thread-for-recovery`
4. 删除对应 tmux session，模拟 Mac 重启后 tmux 丢失：
   - 使用 session payload 的 `tmuxSessionName/tmuxSocketPath` 调用 `tmux -S <socket> kill-session -t <name>`。
5. 重新打开 terminal URL，触发 `ensureTerminalRuntime()`。
6. 断言 fake `codex` 收到 `resume thread-for-recovery`。
7. 断言 terminal tab 最终仍然显示 Codex 相关状态，且没有创建新的 terminal session。

本地验证命令：

```bash
pnpm typecheck
pnpm --filter @runweave/frontend test -- frontend/tests/terminal.spec.ts --grep "resumes Codex thread after tmux loss"
```

如果本仓库当前 Playwright 命令不是这个精确形态，以 `frontend/playwright.config.ts` 现有 webServer 配置为准运行单条 E2E。

## 风险与边界

- 不对 live tmux pane 自动 resume：避免用户已经回到 shell 或运行其他命令时被自动覆盖。
- 不读取 `~/.codex/sessions`：继续把 `threadId` 当作 Runweave 保存的元数据，不依赖 Codex 本地存储实现细节。
- 不新增非 E2E 单测：符合本仓库测试约束。
- 如果 `codex resume <threadId>` 本身失败，terminal 会留在 shell 中，后续 shell integration 会把 `activeCommand` 清回空；这比反复重启或标记 session exited 更符合用户可恢复操作。
