# Terminal Floating Composer Round 12 代码复审

## 结论

Pass。round 12 复审未发现 P0/P1 阻断性问题。

## 检查范围

- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/terminal-surface-layout.tsx`
- `frontend/src/features/terminal/floating-composer.ts`
- `frontend/src/components/terminal/use-terminal-emulator.ts`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`

## 发现

未发现 P0/P1 阻断问题。

## 已解决问题

- P1 resolved：PageUp/PageDown 被全局吞掉导致 terminal/TUI 输入回归。普通 PageUp/PageDown 仍进入 `sendTerminalInput(data)`，仅 `Shift+PageUp` / `Shift+PageDown` 本地滚动。
- P2 resolved：非编辑控制序列导致 draft mirror 降级。focus/mouse report 会从混合输入中剥离。
- P2 resolved：回底 replay 在 scrollback 退出前发送导致 TUI 保留旧 draft。tmux scrollback active 时仍延迟 replay。
- P2 resolved：混合控制序列导致 supported Codex session 离底不显示 composer。剥离控制序列后保留真实 draft 文本。
- P2 resolved：初始 unsupported 控制输入导致 supported TUI 后续不显示 composer。没有已同步 draft 时，unsupported 输入现在被忽略，不会关闭 `draftMirrorSupported`。

## 复审要点

- `frontend/src/components/terminal/terminal-surface.tsx:220-239`：初始 unsupported 输入不再直接关闭 draft mirror。
- `frontend/src/components/terminal/terminal-surface-layout.tsx:120-160`：新增 DOM diagnostics，供行为验收读取 gating 状态。
- `frontend/src/features/terminal/floating-composer.ts:78-111,167-204`：混合输入中剥离非编辑控制序列后保留 printable draft。
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
