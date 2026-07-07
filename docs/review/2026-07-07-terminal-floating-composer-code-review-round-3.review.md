# Terminal Floating Composer Round 3 代码复审

## 结论

Fail。重新审查 round 3 修复后，仍发现 1 个 P1 阻断问题，`case_3` 不通过。

## 检查范围

- `frontend/src/components/terminal/use-terminal-emulator.ts`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/terminal-surface-layout.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/features/terminal/floating-composer.ts`
- `docs/testing/terminal-floating-composer-test-cases.md`

## 发现

- P1 open：PageUp/PageDown 被全局吞掉导致 terminal/TUI 输入回归。`frontend/src/components/terminal/use-terminal-emulator.ts:40-49,346-356` 在 `onData` 层命中 PageUp/PageDown raw sequences 后直接 `terminal.scrollPages(...)` 并 `return`，不会调用 `sendTerminalInput`。这会让远端 shell/TUI 收不到 PageUp/PageDown，破坏 vim/less/man/Codex 等程序的原生按键输入。修复方向：只在明确的本地滚动快捷键路径处理 `Shift+PageUp` / `Shift+PageDown`，或把本地滚动限定到非输入语义的浏览器事件；裸 PageUp/PageDown 必须继续发送给远端进程。

## 已确认

- `frontend/src/components/terminal/use-terminal-emulator.ts:322-335` 已有 `Shift+PageUp` / `Shift+PageDown` 的本地滚动 handler；因此 `onData` 层继续吞裸 PageUp/PageDown 是扩大影响面，不是必要修复。
- `docs/testing/terminal-floating-composer-test-cases.md:57-66` 要求普通 shell 继续保留 xterm 原始输入能力；全局吞按键不满足这个约束。

## 已执行命令

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

三项均通过，但它们不能覆盖这个按键语义回归。
