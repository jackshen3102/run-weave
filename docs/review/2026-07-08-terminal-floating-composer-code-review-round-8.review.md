# Terminal Floating Composer Round 8 代码复审

## 结论

Pass。round 8 复审未发现 P0/P1 阻断性问题。

## 检查范围

- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/use-terminal-emulator.ts`
- `frontend/src/features/terminal/floating-composer.ts`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/terminal-surface-layout.tsx`

## 发现

未发现 P0/P1 阻断问题。

## 已解决问题

- P1 resolved：PageUp/PageDown 被全局吞掉导致 terminal/TUI 输入回归。round 8 复审确认普通 PageUp/PageDown 仍进入 `sendTerminalInput(data)`，仅 `Shift+PageUp` / `Shift+PageDown` 作为本地滚动快捷键处理。
- P2 resolved：非编辑控制序列导致 draft mirror 降级。round 8 复审确认 focus report 和 mouse report 仍作为不改变 draft 的 supported 输入处理。
- P2 resolved：回底 replay 在 scrollback 退出前发送导致 TUI 保留旧 draft。round 8 已在 tmux scrollback active 时延迟 replay，避免退出 scrollback/copy-mode 的控制输入覆盖 `Ctrl+U+draft` 回写。

## 复审要点

- `frontend/src/components/terminal/terminal-surface.tsx:242-290`：`sendFloatingDraftToTui` 用 floating draft 快照发送 replay/submit，并在成功调度后同步 mirror 状态。
- `frontend/src/components/terminal/terminal-surface.tsx:324-347`：回底和发送路径在 `tmuxScrollbackActive` 时使用延迟 replay。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx:1448-1467`：每个 `TerminalSurface` 按 `apiBase:terminalSessionId` key 挂载，延迟 replay 仍绑定原 session surface。
- `frontend/src/components/terminal/use-terminal-emulator.ts:311-342`：普通输入仍发送到远端进程。

## 已执行命令

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

三项均通过。

## 残余风险

本 worker 未执行 Playwright 行为验收；该项仍属于 `behavior_verify` worker 分工。
