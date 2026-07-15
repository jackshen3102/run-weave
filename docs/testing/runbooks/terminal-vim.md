# 终端 Vim 回归 Runbook

## 测试门槛

- E2E：当前仅有 `frontend/tests/smoke.spec.ts`；先执行 `pnpm test:e2e`，Vim 行为按本 Runbook 使用合规 `$toolkit:playwright-cli` 手工验收
- 静态检查：涉及后端或终端协议时补 `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint`

## 发布规则

- E2E 与相关静态检查在同一提交范围内通过，才视为终端兼容可发布。

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
