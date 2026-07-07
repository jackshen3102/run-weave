# Terminal Floating Composer Prototype

面向 Runweave Web Terminal 的可运行 HTML 交互原型，用于验证“滚动离底后出现 Mini Composer，和底部原始 TUI prompt 互斥”的方案。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-floating-composer
```

打开：

```text
http://127.0.0.1:6188/
```

## 文件

- `index.html`：静态页面壳层、terminal 外观、浮动输入框布局和样式。
- `app.js`：离底阈值、tmux scrollback、输入发送、事件流等原型状态。
- `mock-state.json`：模拟 terminal session、终端输出、阈值和初始事件。
- `prototype-preview.png`：浏览器验证截图。

## 原型简报

- 目标：用户滚动查看历史输出时，不需要滚回底部也能粘贴、编辑并发送 terminal 输入。
- 用户动作：滚动离底、粘贴或编辑文本、发送、回到底部、模拟 tmux scrollback。
- 主要用户：在 Runweave Web Terminal 中频繁查看历史输出并继续输入命令或 Agent prompt 的用户。
- 影响的产品界面或模块：`frontend/src/components/terminal/terminal-surface.tsx`、`terminal-surface-layout.tsx`、xterm 滚动状态与输入发送链路。
- 关键流程：`bottomOffsetRows < threshold` 时显示原始 TUI prompt；`bottomOffsetRows >= threshold` 或 `tmuxScrollbackActive` 时显示浮动 Mini Composer；发送后退出 scrollback、滚到底部并恢复原始 prompt。
- 重要状态：`bottomOffsetRows`、`thresholdRows`、`tmuxScrollbackActive`、`newOutputBelow`、共享 draft。
- 非目标：不实现真实 xterm、真实 tmux、WebSocket、后端协议、shell 当前行内容双向同步。

## 验证点

- 首屏在底部时只显示模拟的原始 TUI prompt，不显示浮动输入框。
- 点击 `Scrolled` 或滚动离底超过 `8` 行后，原始 prompt 隐藏，Mini Composer 出现。
- 点击 `Tmux` 后，即使不是普通客户端滚动，也显示 Mini Composer。
- Mini Composer 支持编辑、多行粘贴、`Enter` 发送、`Shift+Enter` 换行。
- 发送后自动回到底部，隐藏 Mini Composer，恢复原始 TUI prompt。
- 新输出到达时保留离底状态，并保留回到底部入口。

## 功能分类

### 产品核心功能

| 元素 / 行为                                     | 最终产品是否需要 | 产品价值                                    | 备注                                                              |
| ----------------------------------------------- | ---------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| 离底阈值触发 Mini Composer                      | 是               | 解决查看历史输出时无法方便粘贴输入的问题    | 阈值原型为 8 行，产品可由 xterm `baseY - viewportY` 计算          |
| Mini Composer 与原始 TUI prompt 互斥            | 是               | 避免两个输入入口同时暗示可编辑当前 shell 行 | 原型用显隐表达，产品需避免 xterm 焦点抢占                         |
| 发送后回到底部并恢复 terminal focus             | 是               | 保持输入行为符合 terminal 预期              | 产品应复用现有 `onSendInput` 和 `onScrollToBottom`                |
| tmux scrollback 下也显示 Mini Composer          | 是               | 覆盖 tmux copy mode 或服务端 scrollback     | 产品应复用现有 `tmuxScrollbackActive` 状态                        |
| 新输出到达时提示可回到底部                      | 是               | 防止离底阅读时错过后续输出                  | 可复用现有 `hasNewOutputBelow`                                    |
| 原始 TUI prompt 与 Mini Composer 双向同步 draft | 是               | 切换输入入口时用户正在编辑的内容不能丢      | 原型用单一 `draft` 状态模拟；产品实现需评估 xterm/readline 可行性 |

### 原型辅助功能

| 元素 / 行为                         | 辅助验证什么     | 为什么不进入产品                            | 备注       |
| ----------------------------------- | ---------------- | ------------------------------------------- | ---------- |
| `Bottom / Scrolled / Tmux` 分段控件 | 快速切换关键状态 | 产品状态来自真实 xterm/tmux，不需要手动开关 | 仅用于演示 |
| `Seed text` 按钮                    | 快速模拟粘贴内容 | 产品由用户真实粘贴或输入                    | 仅用于演示 |
| `Runtime state` 指标面板            | 看清状态流转     | 产品不需要展示内部状态                      | 仅用于验证 |
| 事件流                              | 观察交互结果     | 产品已有日志/性能埋点，不需要此 UI          | 仅用于验证 |

## 调整记录

| 轮次 | 调整内容                                                                                    | 原因                                               | 结果                                                       |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| 1    | 创建 Mini Composer 原型，覆盖普通离底、tmux scrollback、发送回底部                          | 用户选择方案 2 并要求先看原型                      | Playwright 已验证关键状态                                  |
| 2    | 将 Mini Composer 从大块 textarea 调整为紧凑 terminal 输入栏，移除内部重复回到底部按钮       | 原视觉过重，输入框像普通表单而不像 terminal 浮层   | Playwright 已验证离底状态，截图已更新                      |
| 3    | 优化 scroll handler：滚动中只同步偏移状态，跨显示阈值才重渲染，并忽略程序性 scroll 恢复事件 | 手势滚动时反复整页 render 和阈值抖动会造成卡顿错觉 | Playwright wheel 验证只产生一次跨阈值事件                  |
| 4    | 将回到底部按钮移到 Mini Composer 上方居中，并改为与 Composer 同步显示隐藏                   | 用户要求按钮位置和显隐都跟输入框绑定               | Playwright 已验证位置与显隐同步                            |
| 5    | 移除输入框内的状态文案，将 Send 文案按钮改为发送 icon 按钮                                  | 输入框内部不应放额外状态控件，发送操作用图标更轻   | Playwright 已验证 icon 与无额外状态控件                    |
| 6    | 将原始 TUI prompt 和 Mini Composer 绑定到同一个 draft 状态，切换视图时保留编辑内容          | 用户要求两种互斥输入框的数据双向同步               | Playwright 已验证 native -> composer 与 composer -> native |

## 冻结记录

- 最终采用的交互：待用户确认。
- 放弃的方向：暂不做 shell 当前输入行双向同步；暂不做只读剪贴板直发按钮。
- 产品核心功能清单是否已确认：否。
- 原型辅助功能清单是否已确认：否。
- 最终截图：`prototype-preview.png`
- 冻结时间：待确认。

## 边界

- 这个原型不连接真实后端 API。
- 这个原型不导入生产源码。
- 这个原型不能证明产品协议、存储或运行时支持已经存在。
- 原型中的 terminal、tmux scrollback 和输入发送均为模拟。
- 原型中的原始 TUI prompt 可编辑是为了表达双向同步意图；真实 xterm/readline 当前输入行的读取与回写需要后续技术设计验证。
- 原型辅助功能默认不进入实施计划，除非冻结时明确转为产品需求。

## 实施计划衔接

- 原型表达的产品行为：滚动离底后提供一个临时发送入口，发送后回到底部，避免和原始 TUI prompt 同时出现。
- 需要进入产品实现的核心功能：离底阈值、Mini Composer、发送回底部、tmux scrollback 兼容、新输出提示共存。
- 不进入产品实现的原型辅助功能：分段模拟控件、状态面板、事件流、Seed text。
- 需要检查的现有代码：`TerminalSurface`、`TerminalSurfaceLayout`、`useTerminalEmulator`、`packages/common/src/terminal/terminal-scroll.ts`。
- 可能涉及的协议或数据结构：无新增后端协议；前端可复用现有 `sendTerminalInput`。
- 可能涉及的前端落点：terminal layout 浮层、xterm scroll state、textarea key handling、focus 管理。
- 可能涉及的后端或运行时落点：无。
- 验收方式：`pnpm typecheck`、`pnpm lint`、Playwright 打开真实 Web Terminal 验证离底、tmux scrollback、发送回底部。
