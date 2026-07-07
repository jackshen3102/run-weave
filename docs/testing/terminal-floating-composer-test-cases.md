# Terminal Floating Composer 测试用例

本文档覆盖 `docs/plans/2026-07-07-terminal-floating-composer.md` 的验收范围。验证真实浏览器页面时必须使用 `$playwright-cli`；`typecheck` / `lint` 只是前置门禁，不能作为 UI 行为通过证据。

## 范围

覆盖：

- Web desktop terminal 的 TUI-gated floating composer。
- Codex / Trae-family / activeCommand 可识别的 Claude CLI TUI 中离底显示、回底隐藏。
- 原始 TUI 输入与 floating composer draft 双向同步。
- 普通 shell 保持旧行为。
- unsupported 输入序列的安全降级。

不覆盖：

- Ionic App terminal。
- mobile terminal。
- Electron 打包安装器。
- 后端 API、WebSocket 协议、terminal session storage 迁移。
- 非 supported TUI，例如 vim、less、opencode；这些必须另开 allowlist 需求和验收。Claude CLI 只有在当前 session 能通过 `activeCommand` 稳定识别时进入本次 supported 范围，否则先视为环境不适用。

## 前提事实

- 原型目录：`docs/prototypes/terminal-floating-composer/`。
- 真实前端入口：
  - `frontend/src/components/terminal/terminal-surface.tsx`
  - `frontend/src/components/terminal/terminal-surface-layout.tsx`
  - `frontend/src/components/terminal/use-terminal-emulator.ts`
  - `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- 当前 terminal bottom state 来自 xterm buffer：`packages/common/src/terminal/terminal-scroll.ts`。
- 当前 Web terminal input 来自 `useTerminalEmulator` 的 `terminal.onData(data)`。
- 当前 Web terminal connection 只发送 raw input / resize / signal，不新增协议。
- 当前 Agent 状态来自 `TerminalState` 和 `activeCommand`，supported agent 为 `codex | trae | traex | traecli`。

## 必跑命令

任一失败即停止验收：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

浏览器验收环境：

```bash
pnpm dev
```

打开真实 Web Terminal 页面时，必须使用 `$playwright-cli`，并保存关键 snapshot 或截图作为证据。

行为失败必须先记录 eligibility 诊断证据，避免把用例前提不成立误判为产品失败。TFC-002 到 TFC-006 的 DOM 证据必须至少包含：

- `terminalState.agent`、`terminalState.state`、`activeCommand`、`sessionStatus`。
- `bufferType`、`floatingComposerEligible`、`draftMirrorSupported`。
- `terminalAtBottom`、`bottomOffsetRows`、`tmuxScrollbackActive`。
- `composerVisible`、`composerValue`、`scrollButtonPosition`。

上述页面内状态从 `[data-testid="terminal-floating-composer-diagnostics"]` 的 `data-floating-composer-*` 属性读取；API 状态从 terminal session 接口交叉验证。

失败分类：

- 若 `floatingComposerEligible=false`，先判定为环境或用例前提不成立，不能直接计为 TFC-002/TFC-004 产品失败。
- 若 `floatingComposerEligible=true` 且 `draftMirrorSupported=true`，离底超过阈值后仍不显示 composer，才计为显示逻辑失败。
- 若 `draftMirrorSupported=false`，必须记录导致降级的最后一次 input chunk 或可观察输入动作，再判定是安全降级符合预期还是 mirror 误降级。

## 用例

### TFC-001 普通 shell 离底不显示 floating composer

Given：

- 打开 Web Terminal desktop 页面。
- 创建或选择一个普通 shell session，`terminalState.state=shell_idle`，`activeCommand=null` 或普通 shell/命令。

When：

- 使用 `$playwright-cli` 在 terminal 区域滚轮向上滚动，离底超过 8 行。

Then：

- DOM 中不存在 floating composer textarea。
- 现有右下角 `Scroll terminal to bottom` 按钮按旧逻辑显示。
- 用户继续点击 terminal 输入时，xterm 原始输入仍可用。

失败判断：

- 普通 shell 出现 floating composer。
- 普通 shell 的右下角 scroll button 消失或位置被改成 composer 上方。

### TFC-002 supported TUI 离底显示 floating composer

Given：

- 打开 Web Terminal desktop 页面。
- 启动 Codex、Trae-family 或 activeCommand 可识别的 Claude CLI TUI。
- 页面状态满足当前实现的 `floatingComposerEligible=true`。验收证据必须记录 `buffer.active.type`、`activeCommand`、`terminalState.agent`、`terminalState.state`；若仅 `terminalState.agent` 命中 supported agent 而 `buffer.active.type !== "alternate"`，仍可作为 Codex/Trae-family TUI 验收对象，但必须在证据中明确说明。

When：

- 使用 `$playwright-cli` 滚轮向上滚动，离底超过 8 行。

Then：

- DOM 中出现 floating composer textarea。
- Composer 右侧只有发送 icon 按钮。
- Composer 内没有 `away from bottom` 或其它状态文案。
- 回到底部按钮显示在 Composer 上方水平居中。

失败判断：

- `floatingComposerEligible=true` 且离底超过阈值后 Composer 不出现。
- Composer 中出现状态文案、demo 控件或 `Send` 文字按钮。
- 回到底部按钮仍位于右下角。

### TFC-003 supported TUI 回到底部同步隐藏

Given：

- 已处于 TFC-002 的离底状态。

When：

- 点击 Composer 上方的回到底部按钮。

Then：

- terminal 滚到底部。
- floating composer 隐藏。
- Composer 上方回到底部按钮同步隐藏。
- xterm/TUI 输入区重新成为主要输入入口。

失败判断：

- Composer 隐藏但回到底部按钮仍显示。
- 回到底部按钮隐藏但 Composer 仍显示。
- 点击后 terminal 没有回到底部。

When：

- 再次进入 TFC-002 的离底状态。
- 不点击按钮，改用滚轮或触控板向下滚回底部。

Then：

- terminal 回到底部。
- floating composer 隐藏。
- Composer 上方回到底部按钮同步隐藏。

失败判断：

- 视觉已经回到底部，但 `composerVisible=true` 或 DOM 中仍存在 floating composer textarea。
- `tmuxScrollbackActive=true` 持续保留，导致 composer 卡住不隐藏。

### TFC-004 native TUI 输入同步到 floating composer

Given：

- supported TUI 位于底部。
- floating composer 未显示。
- `floatingComposerEligible=true` 且 `draftMirrorSupported=true`。

When：

- 在真实 TUI 输入行输入 `echo from native prompt`，但不按 Enter。
- 使用 `$playwright-cli` 滚轮向上滚动超过显示阈值。

Then：

- floating composer 显示。
- composer textarea 内容为 `echo from native prompt`。
- draft 未被清空、截断或重复。

失败判断：

- `floatingComposerEligible=true` 且 `draftMirrorSupported=true` 时，composer 为空。
- composer 文本和底部输入不一致。
- 滚动切换导致文本被发送。

### TFC-005 floating composer 编辑同步回 native TUI

Given：

- 已处于 TFC-004 的 floating composer 显示状态。

When：

- 将 composer 文本改为 `echo edited in floating composer`。
- 点击回到底部按钮。

Then：

- 回到底部后，真实 TUI 输入行显示 `echo edited in floating composer`。
- 内容未自动发送。
- 光标/输入焦点回到 terminal。

失败判断：

- 回到底部后 TUI 仍显示旧文本。
- 文本被直接发送执行。
- 输入行出现重复内容，例如旧文本和新文本拼接。

When：

- 再次进入 TFC-004 的 floating composer 显示状态。
- 将 composer 文本改为 `echo edited by scroll return`。
- 不点击回到底部按钮，改用滚轮或触控板向下滚回底部。

Then：

- 回到底部后，真实 TUI 输入行显示 `echo edited by scroll return`。
- 内容未自动发送。
- floating composer 与上方回底按钮同步隐藏。

失败判断：

- 手势回底只隐藏 composer，但 TUI 仍显示旧文本。
- 文本被直接发送执行。
- `tmuxScrollbackActive` 清理后未 replay 最新 draft。

### TFC-006 floating composer 发送只发送最新 draft 一次

Given：

- supported TUI 离底，floating composer 显示。
- composer 文本为 `echo send from floating composer`。

When：

- 点击发送 icon。

Then：

- terminal 回到底部。
- TUI 收到并发送最新 draft。
- 输出或可观察 terminal 文本中只出现一次 `echo send from floating composer`。
- composer draft 清空。

失败判断：

- 命令发送两次。
- 发送的是旧 draft。
- 发送后 composer 仍显示且 draft 未清空。

### TFC-007 Shift+Enter 换行，Enter 发送

Given：

- supported TUI 离底，floating composer 显示。

When：

- 在 composer 中输入 `line one`。
- 按 `Shift+Enter`。
- 输入 `line two`。

Then：

- composer textarea 包含两行文本。
- 未发送输入。

When：

- 按 `Enter`。

Then：

- 发送两行 draft。
- terminal 回到底部。

失败判断：

- `Shift+Enter` 触发发送。
- `Enter` 没有发送。
- 多行内容被压成错误文本。

### TFC-008 search toolbar 打开时不显示 floating composer

Given：

- supported TUI session active。

When：

- 使用 `$playwright-cli` 触发 terminal search，例如 `Meta+F` / `Ctrl+F`。
- 向上滚动 terminal。

Then：

- search toolbar 正常显示。
- floating composer 不显示。
- search input 保持焦点。

失败判断：

- search 和 composer 同时抢焦点。
- composer 覆盖 search toolbar。

### TFC-009 unsupported 编辑序列安全降级

Given：

- supported TUI 位于底部。

When：

- 输入普通 draft。
- 使用方向键、历史导航或其它无法安全 mirror 的 escape sequence。
- 再向上滚动超过阈值。

Then：

- floating composer 不显示，或显示前被安全关闭。
- terminal 原始输入行为不受影响。
- 不向 TUI 发送 replay 序列。

失败判断：

- mirror draft 错误显示并可回写。
- 发生误清行、误发送或重复输入。

### TFC-010 new output below 不单独触发 composer

Given：

- 普通 shell 或 unsupported TUI 离底。

When：

- terminal 下方产生新输出。

Then：

- 只显示旧的 new-output / scroll-to-bottom 提示。
- 不显示 floating composer。

失败判断：

- 仅因 `hasNewOutputBelow=true` 就显示 composer。

### TFC-011 tmux scrollback active 下 supported TUI 显示 composer

Given：

- tmux runtime。
- supported TUI active。
- 用户通过 tmux scrollback / copy-mode 进入离底状态。

When：

- 使用 `$playwright-cli` 或真实滚轮触发 tmux scrollback。

Then：

- floating composer 显示。
- 回到底部按钮点击后调用现有 `tmux_exit_copy_mode` 路径并隐藏 composer。

失败判断：

- tmux scrollback active 时 composer 不显示。
- 点击回到底部后仍停留在 tmux scrollback/copy-mode。

### TFC-012 mobile/App 非目标不回归

Given：

- mobile mode 或 Ionic App terminal 页面。

When：

- 打开 terminal 并滚动。

Then：

- 不出现 Web desktop floating composer。
- App 原有 composer / Stop / keybar 行为不变。

失败判断：

- App 或 mobile 页面出现 Web floating composer UI。
- mobile keybar 或 App composer 被覆盖。

## 覆盖矩阵

| 需求点                | 覆盖用例                  |
| --------------------- | ------------------------- |
| 普通 shell 保持旧行为 | TFC-001、TFC-010          |
| TUI-only gate         | TFC-002、TFC-011、TFC-012 |
| 原型 UI 落地          | TFC-002、TFC-003          |
| 双向 draft 同步       | TFC-004、TFC-005、TFC-006 |
| 发送与多行编辑        | TFC-006、TFC-007          |
| 焦点冲突避免          | TFC-008、TFC-012          |
| 安全降级              | TFC-009                   |

## 验收通过标准

- 必跑命令全部通过。
- TFC-001 至 TFC-012 全部通过或有明确不适用说明；不适用只能用于环境缺少对应 TUI，例如本机未安装 Trae CLI。
- 对 Codex 至少完成 TFC-002 至 TFC-009 的真实浏览器取证。
- 普通 shell 路径必须完成 TFC-001 和 TFC-010，防止误影响现有终端体验。
