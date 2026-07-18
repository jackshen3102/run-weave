# Terminal Browser Adaptive Tabs Prototype

面向 Runweave Terminal Browser 多 tab 的可运行 HTML 交互原型，基于 Chrome tab strip 调研验证“active 保真、inactive 降噪、minimum 有底线、overflow 有入口、连续操作不跳”的方案。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-browser-adaptive-tabs
```

打开默认 10-tab、420px sidecar：

```text
http://127.0.0.1:6188/?tabs=10&width=420&active=4
```

常用场景：

```text
# 最窄 sidecar + 10 tabs
http://127.0.0.1:6188/?tabs=10&width=320&active=4

# 480px + 20 tabs，active 在尾部
http://127.0.0.1:6188/?tabs=20&width=480&active=19

# 展开宽度 + 6 tabs
http://127.0.0.1:6188/?tabs=6&width=800&active=2

# 显示原型辅助切换器
http://127.0.0.1:6188/?tabs=10&width=420&active=4&prototypeControls=1
```

## 文件

- `index.html`：Runweave Terminal + Browser sidecar 产品画面与 adaptive tab 样式。
- `app.js`：宽度分配、overflow、overview/search、关闭冻结、拖拽、resize 等交互。
- `mock-state.json`：20 个 browser tab、terminal 输出和状态样例。
- `prototype-preview.png`：Playwright 验证后的默认产品画面截图。

## 原型简报

- 目标：在 320px～800px Browser sidecar 中，让 1～20 个 tab 保持可识别、可选择、可关闭、可找回，不发生固定控件重叠。
- 用户动作：选择 tab、新建、关闭、连续关闭、横向滚动、打开 Tab Overview/Search、搜索并激活/关闭、拖拽排序、resize sidecar、键盘切换。
- 主要用户：同时使用人工浏览、页面 opener、MCP/Playwright 创建多个 Terminal Browser tab 的 Runweave 用户。
- 影响的产品界面或模块：`terminal-browser-tabs.tsx`、`sortable-tabs.tsx`、`preview-store.ts`、Terminal Browser Electron tab order persistence。
- 关键流程：空间充足时展示完整 title；空间减少时 inactive 进入 compact/icon-only；达到 minimum 后横向 overflow；active 自动进入可视区；固定 Overview/Search 提供全量入口。
- 重要状态：sidecar width、tab count、active tab、loading、MCP active、browser group、overview query、mouse/touch closing mode、dragging。
- 非目标：不连接真实 Electron/CDP；不实现 pinned tabs、用户可编辑 groups、vertical tabs、recently closed、hover thumbnail。

## 验证点

- 320px + 10 tabs：active width ≥ 80px，inactive width ≥ 44px，无 tab 交互区域重叠。
- 480px + 20 tabs：active 自动滚入可视区，固定 Overview 与 New Tab 按钮始终可见。
- 800px + 6 tabs：tab 最宽不超过 180px，不无意义拉满整行。
- comfortable/compact/icon-only 三档按宽度隐藏 title、MCP 文本和 inactive close。
- inactive close 只在 hover/focus 显示，不改变 tab width。
- Overview/Search 能搜索 title、URL、group，能激活与关闭全部 tab。
- 鼠标关闭后冻结剩余 tab width，pointer 离开 tab bar 后再展开。
- touch/pen 关闭后约 1.8 秒解除冻结。
- sidecar resize、tab active 变化都保持 active 可视。
- tab 可拖拽排序；键盘 Left/Right/Home/End 可切换。

## 功能分类

### 产品核心功能

| 元素 / 行为                        | 最终产品是否需要 | 产品价值                           | 备注                                  |
| ---------------------------------- | ---------------- | ---------------------------------- | ------------------------------------- |
| active/inactive 不同 minimum       | 是               | active 可读可关，inactive 承担压缩 | 原型 80px / 44px，产品需校准          |
| comfortable/compact/icon-only 降级 | 是               | 避免固定控件重叠                   | MCP 文本在窄宽降级为点/边框           |
| 横向 overflow + active 自动入视    | 是               | minimum 总和超出容器时仍可操作     | scrollbar 视觉隐藏，但支持滚轮/触控板 |
| 固定 Tab Overview/Search           | 是               | 提供全量、可搜索的找回入口         | 搜索、激活、关闭                      |
| inactive close hover/focus 显示    | 是               | 节省背景 tab 空间                  | 不改变 tab 宽度                       |
| 连续关闭冻结布局                   | 是               | close target 不从鼠标下跳走        | mouse leave / touch timer 解冻        |
| sidecar resize                     | 已有             | 验证不同宽度下 adaptive 行为       | 原型复刻现有产品能力                  |
| tab 拖拽与键盘导航                 | 是               | 保持现有排序并补齐可访问性         | 产品需同步 Electron 持久化            |

### 原型辅助功能

| 元素 / 行为                          | 辅助验证什么                          | 为什么不进入产品                        | 备注                                   |
| ------------------------------------ | ------------------------------------- | --------------------------------------- | -------------------------------------- |
| `tabs` / `width` / `active` URL 参数 | 快速进入固定验收场景                  | 产品状态来自真实 tabs 与 sidecar        | README 使用                            |
| `prototypeControls=1` helper         | 快速切换 320/480/800 与 1/3/6/10/20   | 正式产品已有 resize，tab 数来自真实行为 | 默认隐藏，标记 `data-prototype-helper` |
| mock terminal 与网页内容             | 让 Browser sidecar 处于真实产品上下文 | 产品使用真实 xterm/WebContentsView      | 不作为实现依据                         |

## 调整记录

| 轮次 | 调整内容                                                                               | 原因                                                  | 结果                                                             |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | 基于 Chrome 调研创建 adaptive tab strip、Overview/Search、close freeze 与 URL 场景     | 用户要求先做可查看原型                                | 完成可运行原型，不改产品 UI                                      |
| 2    | 拖拽时保留原 DOM；active 入视改为直接计算 viewport scroll；Overview close 改为独立按钮 | Playwright 暴露原生拖拽重渲染与首次 active 入视不稳定 | 拖拽、active 自动入视、可聚焦关闭均通过                          |
| 3    | 跑 320/480/800 × 1/3/6/10/20 全矩阵与关键交互                                          | 验证 minimum、overflow 与固定操作区                   | 15/15 场景通过；搜索、关闭冻结、拖拽、resize、键盘切换、新建通过 |

## 冻结记录

- 最终采用的交互：用户于 2026-07-10 初步确认原型方向；按本 README 的 active 保真、inactive 分级降噪、minimum 后 overflow、Overview 全量找回和关闭布局稳定进入产品实现。
- 放弃的方向：当前 equal-shrink + hidden overflow；只恢复 76px minimum + 横向滚动；只做尾部隐藏但不提供 overview。
- 产品核心功能清单是否已确认：已确认并进入产品；真实产品验收固定为 preferred 180px、active minimum 80px、inactive minimum 44px、gap 4px 和 touch / pen 1.8 秒解冻。
- 原型辅助功能清单是否已确认：已明确不进入产品。
- 最终截图：`prototype-preview.png`（Playwright，1440 × 900，420px sidecar + 10 tabs）。
- 对应权威文档：`docs/architecture/terminal-code-preview.md` 与 `docs/testing/terminal/terminal-browser-adaptive-tabs.testplan.yaml`。
- 实施结果：Renderer 自适应布局、Overview、关闭冻结、键盘与拖拽，以及 Electron 顺序持久化已于 2026-07-10 完成。
- 冻结时间：2026-07-10。

## 边界

- 这个原型不连接真实后端 API、Electron IPC、CDP Proxy 或 WebContentsView。
- 这个原型不导入生产源码，不能证明生产状态/持久化契约已经存在。
- URL 参数和 prototype helper 只用于演示，不进入产品实现。
- 原型中的 width token 与 touch timer 已由真实产品 Playwright / Electron 行为验收固定；原型仍只保留为历史决策资产。
- 原型阶段只调整 `docs/prototypes/terminal-browser-adaptive-tabs/`，不修改产品 tab UI。

## 产品文档衔接

- 原型表达的产品行为：active 保真、inactive 分级降噪、minimum 后 overflow、overview 全量找回、关闭布局稳定。
- 已进入产品实现的核心功能：README“产品核心功能”表中的全部条目。
- 不进入产品实现的原型辅助功能：URL 参数、helper、mock terminal、mock page。
- 需要检查的现有代码：`terminal-browser-tabs.tsx`、`sortable-tabs.tsx`、`use-terminal-browser-controller.ts`、`preview-store.ts`、`electron/src/terminal-browser-view.ts`。
- 可能涉及的数据结构：前端无需新增 tab 主模型字段；实现 close freeze/overflow 可使用局部 UI 状态；reorder 持久化可能需要 Electron IPC。
- 可能涉及的前端落点：tab item container query、overview popover、active scrollIntoView、pointer/touch closing mode、keyboard navigation。
- 可能涉及的后端或运行时落点：无；Electron 仅涉及顺序持久化与既有 tab event 对齐。
- 验收方式：Playwright 覆盖 320/480/800 × 1/3/6/10/20 tabs、active 首中尾、MCP/loading、关闭/连续关闭、overview/search、拖拽、resize；真实 Electron 再验证 WebContentsView tab 同步。
