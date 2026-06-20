# Terminal Scroll To Bottom 代码评审

- 日期：2026-06-21
- 评审对象：当前 live worktree diff，重点覆盖 Web/App 终端滚动到底部按钮、tmux copy-mode 退出输入模式、`packages/common` terminal scroll helper、`packages/terminal-renderer` ref API 扩展。
- 评审类型：`$toolkit:review-only`，只读代码评审；未修改被评审源码、配置或测试，仅新增本报告。
- 结论：未发现 blocker / major 问题；当前可进入 `human_verify`。

## 发现

- 未发现需要阻断进入 `human_verify` 的问题。

## 已核对

- Web 端 `TerminalSurface` 在输出追加前读取 xterm 底部状态；用户离开底部时会显示按钮并标记后续输出，点击后会滚动到底部并清除 `hasNewOutputBelow` / `tmuxScrollbackActive`。
- Web 端 tmux alternate screen 滚轮路径仍沿用 `buildTmuxScrollInput`，仅在向上滚动时标记 `tmuxScrollbackActive`；按钮点击会通过新增 `tmux_exit_copy_mode` 模式请求后端退出 copy-mode。
- App 端 `TerminalRenderer` 新增 `onBottomStateChange`、`scrollToBottom()`、`isAtBottom()`，`AppTerminalPanels` 通过 renderer ref 滚动到底部，并通过触摸/滚轮估算 tmux scrollback 距离显示按钮。
- 后端 `sendTerminalInputSchema`、shared `TerminalInputMode` 与 `sendInputToSession()` 已补齐 `tmux_exit_copy_mode`；tmux-backed session 会调用 `TmuxService.cancelCopyMode()`，pty session 不会写入空输入。
- 新增 `packages/common/src/terminal/terminal-scroll.ts` 通过 `@runweave/common/terminal` 显式子路径被 Web/App 共享，没有新增 `@runweave/common` 根导出。
- 未引入 React `useCallback`，新增稳定函数引用仍使用 `useMemoizedFn`。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。

## 未执行

- 未执行浏览器/页面交互验证。本轮是 `$toolkit:review-only` 静态评审；如后续需要打开页面复现或验证滚动交互，必须按仓库约束使用 `$playwright-cli`。

## 剩余风险

- tmux copy-mode 退出是前端乐观清状态，后端 `cancelCopyMode()` 失败只记录 warn；如果真实 tmux pane 状态异常，用户可能需要再次滚动或等待后续输出恢复视图。
- App 侧按钮和触摸滚动经过代码审查、类型检查和 lint，但未做真实移动端/浏览器交互验证。
