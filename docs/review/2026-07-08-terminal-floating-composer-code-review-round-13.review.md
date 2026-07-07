# Terminal Floating Composer 代码评审 Round 13

## 评审范围

- 当前工作区 diff：Terminal floating composer 相关前端、backend input dispatcher、CLI/shared 协议改动。
- 参考计划：`docs/plans/2026-07-07-terminal-floating-composer.md`。
- 参考用例：`docs/testing/terminal-floating-composer-test-cases.md`。

## 结论

当前实现仍不建议上线。静态门禁通过，但核心行为还有 2 个 P1：supported TUI 离底不会自动显示 composer textarea；从 composer 点击回到底部时会跳过 dirty draft replay，导致编辑内容不能同步回真实 TUI 输入行。

## 发现

### P1 严重：离底后只显示打开按钮，不会按验收要求自动显示 floating composer

风险：TFC-002/TFC-004 要求 `floatingComposerEligible=true` 且离底超过阈值后 DOM 中直接出现 composer textarea，并带入当前 draft；但当前 `floatingComposerVisible` 依赖 `floatingComposerOpen`，而 `floatingComposerOpen` 只在用户点击右下角 pencil trigger 后才变为 true。结果 supported TUI 离底时默认只出现“Open floating composer”按钮，textarea 不出现，既不符合计划的“离底达到阈值即显示”，也不符合验收用例。

定位：`frontend/src/components/terminal/terminal-surface.tsx:602`、`frontend/src/components/terminal/terminal-surface.tsx:608`、`frontend/src/components/terminal/terminal-surface.tsx:609`、`frontend/src/components/terminal/terminal-surface-layout.tsx:343`、`docs/testing/terminal-floating-composer-test-cases.md:93`。

修复方向：把离底阈值/hysteresis 作为 composer 可见性的直接状态来源：未显示时 `bottomOffsetRows >= 8` 自动显示，已显示时 `bottomOffsetRows > 2` 保持显示，回到底部/失去 eligibility 时隐藏。若保留手动打开按钮，需要先改计划和 TFC-002/TFC-004，否则它是产品行为回归。

### P1 严重：点击 composer 上方回底按钮会抑制 replay，dirty draft 不会同步回 TUI

风险：TFC-005 要求用户在 floating composer 中编辑后，点击回到底部按钮时真实 TUI 输入行显示最新 draft 且不自动发送。当前 `handleFloatingComposerScrollToBottom` 先设置 `suppressNextBottomReplayRef.current = true`，随后只调用 `handleScrollToBottom()`；而 `handleBottomStateChange` 在 `suppressBottomReplay` 为 true 时跳过 `replayFloatingDraftIfNeeded(...)`。因此 dirty draft 会随着 composer 隐藏而留在 Web state，真实 TUI 输入行仍是旧内容或空内容。

定位：`frontend/src/components/terminal/terminal-surface.tsx:210`、`frontend/src/components/terminal/terminal-surface.tsx:217`、`frontend/src/components/terminal/terminal-surface.tsx:228`、`frontend/src/components/terminal/terminal-surface.tsx:365`、`docs/testing/terminal-floating-composer-test-cases.md:182`。

修复方向：回底按钮路径在滚动到底部前或进入 bottom replay 前显式调用 `sendFloatingDraftToTui({ submit: false })`，并只抑制由该主动同步造成的重复 replay；不要用全局 suppress 直接跳过 dirty draft 同步。

### P2 一般：阈值常量未接入显隐逻辑，hysteresis 实际没有生效

风险：计划要求显示阈值 `>= 8`、隐藏阈值 `<= 2`，避免在边界附近闪烁；当前 `TERMINAL_FLOATING_COMPOSER_SHOW_ROWS` / `HIDE_ROWS` 只定义未使用，显隐只受 `showScrollToBottomControl` 和手动 open 状态影响。正常 xterm scrollback 中轻微离底也会显示 trigger，不能证明满足“只在跨阈值时更新浮层显隐”的要求。

定位：`frontend/src/features/terminal/floating-composer.ts:4`、`frontend/src/features/terminal/floating-composer.ts:5`、`frontend/src/components/terminal/terminal-surface.tsx:602`、`docs/plans/2026-07-07-terminal-floating-composer.md:35`。

修复方向：在 `TerminalSurface` 中引入独立的 visibility state 或 reducer，使用这两个常量驱动 show/hide，并让 TFC 诊断属性暴露阈值后的最终可见状态。

### P2 一般：Composer UI 增加了额外关闭按钮，和原型约束不一致

风险：计划要求 composer 输入区占主要宽度、右侧只保留发送 icon，且不展示额外按钮；当前 composer 左侧新增 close 按钮。虽然不是功能阻断，但会让 TFC-002 的 UI 验收和原型一致性变弱。

定位：`frontend/src/components/terminal/terminal-surface-layout.tsx:298`、`frontend/src/components/terminal/terminal-surface-layout.tsx:302`、`docs/plans/2026-07-07-terminal-floating-composer.md:24`。

修复方向：删除 composer 内 close 按钮，或先更新计划和验收标准说明这是刻意新增的控制，并补充它不会制造第二输入入口或焦点陷阱。

## 已执行检查

- `git diff --check`：通过。
- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter ./frontend lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。

## 未执行

- 未执行 Playwright 浏览器验收。本轮是代码评审，且静态代码路径已能定位 TFC-002/TFC-005 的必现行为缺口；修复后仍需按 `docs/testing/terminal-floating-composer-test-cases.md` 使用 `$playwright-cli` 做真实浏览器验证。
