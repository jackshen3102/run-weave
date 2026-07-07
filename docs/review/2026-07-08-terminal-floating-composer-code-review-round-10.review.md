# Terminal Floating Composer Round 10 代码复审

## 结论

Pass。round 10 复审未发现 P0/P1 阻断性问题。

## 检查范围

- `frontend/src/features/terminal/floating-composer.ts`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/use-terminal-emulator.ts`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/terminal-surface-layout.tsx`

## 发现

未发现 P0/P1 阻断问题。

## 已解决问题

- P1 resolved：PageUp/PageDown 被全局吞掉导致 terminal/TUI 输入回归。round 10 复审确认普通 PageUp/PageDown 仍进入 `sendTerminalInput(data)`，仅 `Shift+PageUp` / `Shift+PageDown` 作为本地滚动快捷键处理。
- P2 resolved：非编辑控制序列导致 draft mirror 降级。round 10 复审确认 focus report 和 mouse report 会被识别并从混合输入中剥离。
- P2 resolved：回底 replay 在 scrollback 退出前发送导致 TUI 保留旧 draft。round 10 复审确认 tmux scrollback active 时仍延迟 replay。
- P2 resolved：混合控制序列导致 supported Codex session 离底不显示 composer。round 10 新增 `stripNonEditingTerminalControlInputs`，剥离 focus/mouse report 后保留真实 draft 文本。

## 复审要点

- `frontend/src/features/terminal/floating-composer.ts:49-87`：逐段消费 focus report、SGR mouse report、X10 mouse report。
- `frontend/src/features/terminal/floating-composer.ts:160-204`：先剥离非编辑控制输入，再处理 bracketed paste、Enter、Backspace、Ctrl+U、printable text。
- `frontend/src/components/terminal/terminal-surface.tsx:220-235`：draft mirror 只在 helper 返回 unsupported 时降级，正常文本会同步到 floating draft。
- `frontend/src/components/terminal/use-terminal-emulator.ts:335-342`：真实输入仍发送给远端进程。

## 已执行命令

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

三项均通过。

## 残余风险

本 worker 未执行 Playwright 行为验收；该项仍属于 `behavior_verify` worker 分工。
