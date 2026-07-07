# Terminal Floating Composer Round 4 代码复审

## 结论

Pass。round 4 复审未发现 P0/P1 阻断性问题，上一轮 PageUp/PageDown 全局吞输入问题已修复。

## 检查范围

- `frontend/src/components/terminal/use-terminal-emulator.ts`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/terminal-surface-layout.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/features/terminal/floating-composer.ts`

## 发现

未发现 P0/P1 阻断问题。

## 已解决问题

- P1 resolved：PageUp/PageDown 被全局吞掉导致 terminal/TUI 输入回归。round 4 已移除 `onData` 层的 PageUp/PageDown raw sequence 拦截；普通 PageUp/PageDown 会继续进入 `sendTerminalInput(data)`，仅 `Shift+PageUp` / `Shift+PageDown` 作为本地滚动快捷键处理。

## 复审要点

- `frontend/src/components/terminal/use-terminal-emulator.ts:311-324` 只处理明确的 Shift+PageUp / Shift+PageDown 本地滚动。
- `frontend/src/components/terminal/use-terminal-emulator.ts:335-342` 对普通用户输入继续调用 `sendTerminalInput(data)`。
- `frontend/src/features/terminal/floating-composer.ts:31-69` 保留 supported agent、desktop、running session、search closed 等 gate。
- `frontend/src/components/terminal/terminal-surface.tsx:220-305` 的 draft mirror / replay 仍走既有 terminal input 链路，未新增协议面。

## 已执行命令

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

三项均通过。

## 残余风险

本 worker 未执行 Playwright 行为验收；该项仍属于 `behavior_verify` worker 分工。
