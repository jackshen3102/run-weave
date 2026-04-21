# 终端 Vim 回归 Runbook

## 测试门槛

- 后端单测：`pnpm --filter ./backend test -- src/terminal/pty-service.test.ts src/ws/heartbeat.test.ts src/ws/terminal-server.test.ts`
- E2E：`pnpm --filter ./frontend e2e -- tests/terminal.spec.ts tests/terminal-vim.spec.ts`

## 发布规则

- 两个门槛在同一提交范围内都通过，才视为终端兼容可发布。

## 手动验证

1. 打开终端会话。
2. 执行 `vim /tmp/viewer-vim-manual.txt` 并进入插入模式。
3. 输入 `manual-check-before-resize`。
4. 浏览器窗口缩放。
5. 继续输入 `-after-resize`，再 `Esc`、`:wq`、`Enter`。
6. `cat /tmp/viewer-vim-manual.txt`。
7. 确认包含 `manual-check-before-resize-after-resize`。

## 失败排查

- 缩放后输出异常：`frontend/src/components/terminal/terminal-surface.tsx` 与 `backend/src/ws/terminal-server.ts`。
- 认证刷新导致离线：`frontend/src/features/terminal/use-terminal-connection.ts`。
- Idle 断线：`backend/src/ws/heartbeat.ts` 与 `backend/src/ws/terminal-server.ts`。
