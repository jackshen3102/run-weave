# Terminal Browser Tab Strip：Chrome 体验深度调研与 Runweave 设计建议

> 状态：调研稿，尚未实施。调研日期：2026-07-10。本文用于决定 Terminal Browser 多 tab 的后续实现；实现完成后，应把稳定行为迁入 `docs/architecture/terminal-code-preview.md`，再删除本临时文档。

## 结论先行

Chrome 解决多 tab 问题的核心不是“让所有 tab 无限等分”，也不是“只加一条横向滚动”。它使用一组相互补位的机制：

1. **active 与 inactive 不对称**：active tab 获得更大的最小宽度和更强的关闭/识别保障；inactive tab 承担主要压缩。
2. **按信息价值逐级降噪**：标题先缩短，inactive close button 再隐藏，极窄时只保留居中的 favicon/状态图标；pinned tab 天生只显示图标。
3. **压缩有硬底线**：达到 active/inactive 的最小宽度后不再继续压缩。空间仍不足时允许总体宽度超过条带，并裁掉尾部不可完整显示的 tab，而不是让固定控件互相覆盖。
4. **另设“找回所有 tab”的通道**：Tab Search、`@tabs`、分组折叠、固定 tab、hover card、快捷键，以及 2026 年官方帮助中列出的 vertical tabs，共同承担“看不全仍可找回”的职责。
5. **操作稳定性优先于即时重排**：鼠标连续关闭时冻结 tab 宽度，直到指针离开 tab strip；触控关闭后延迟 2 秒再重排，避免关闭目标在手指/鼠标下跳动。

因此，Runweave 推荐采用：

- **Chrome-inspired adaptive strip**：active 最小宽度 > inactive 最小宽度，按宽度分级隐藏内容。
- **固定的 Tab Overview/Search 入口**：能够搜索、激活、关闭所有 tab；不能把横向滚动作为唯一找回方式。
- **达到最小宽度后停止压缩**：保留可操作目标；active 自动进入可视区。
- **连续关闭冻结布局**：解决 close button 跳位。

不推荐直接保留当前 `min-w-0 flex-1 basis-0 + overflow-hidden`，也不推荐只恢复旧版 `min-w-[76px] + overflow-x-auto` 后结束设计。

## 1. 调研边界与证据等级

### 1.1 调研对象

- Chrome desktop 水平 tab strip 的宽度分配、内容降级、关闭、拖拽和溢出策略。
- Chrome 的辅助找回能力：Tab Search、hover card、pinned tabs、tab groups、快捷键、vertical tabs。
- Runweave 当前 Terminal Browser 在 320px～60vw sidecar 中的约束与已有能力。

### 1.2 证据等级

本文按以下优先级使用证据：

1. Chromium `main` 源码与自带单测。
2. Google Chrome 官方帮助与 Chrome 官方产品博客。
3. 基于 Runweave 当前代码的尺寸计算与设计推导。

源码以 Chromium `main` 在 2026-07-10 的 commit `5369d2098277d37f9724edabe9ac62d7e7a5a9fc` 为观察点；本机安装的 Chrome 版本为 `150.0.7871.49`。Chromium `main` 可能领先 stable，因此本文把源码事实和已发布产品行为分开描述。

本轮尝试通过 Computer Use 观察本机 Chrome UI，但原生控制通道启动失败；因此本文不声称完成了本机肉眼对照，结论来自当前官方源码、单测和产品文档。

## 2. Chrome 如何解决多 tab 体验

### 2.1 宽度不是“一刀切”等分，而是三段式约束

Chromium 为每个 tab 提供四类宽度：preferred、minimum active、minimum inactive、pinned。布局器先尝试 preferred；空间减少时先把所有普通 tab 一起压缩；进入更窄区间后，inactive tab 可以继续缩，而 active tab 停在更大的 minimum active。空间已经小于所有 minimum 的总和时，布局仍不突破 minimum，tab 总宽可以大于可用宽度。

源码证据：

- [`tab_style.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/tabs/tab_style.cc#42) 定义 preferred、pinned、minimum active、minimum inactive。minimum active 至少要容纳 favicon/close button 对应的内容宽度；minimum inactive 允许缩到视觉内部约 16 DIP。
- [`tab_width_constraints.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_width_constraints.cc#14) 根据 active/pinned/open 状态选择不同的 minimum/preferred。
- [`tab_strip_layout.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_strip_layout.cc#19) 在“inactive 小于 active”和“active/inactive 等宽”两个区间内插值分配宽度。
- [`tab_strip_layout_unittest.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_strip_layout_unittest.cc#139) 明确断言：tab 不得小于 minimum；空间不足时整体可以宽于 tab strip。

体验含义：

- 当前任务的上下文始终有一个最清晰、最可操作的 active tab。
- inactive tab 可以牺牲标题和操作控件，但仍保留最小命中区/识别线索。
- Chrome 接受“不是每个 tab 都能在主条带上完整呈现”，拒绝“为了全塞下而把每个 tab 压成不可操作碎片”。

### 2.2 内容不是同时消失，而是按价值逐级降级

Chrome 会基于 tab 的 active/pinned 状态和实际内容宽度决定 favicon、状态图标、标题、close button 是否显示：

- pinned tab：只在 favicon 与 alert icon 中保留一个，状态图标优先，不显示 close。
- active tab：优先保证 close；在新的 declutter 变体中，如果 close 会挤掉更关键的状态/favIcon，则只在 hover/focus 时显示 close。
- inactive tab：先显示状态图标与 favicon；内容宽度小于桌面约 68 DIP（touch 约 100 DIP）时不常驻 close；新的 declutter 变体中，窄 tab 只在 hover/focus 时显示 close。
- 极窄且其它控件都放不下时：保留并居中 favicon 或状态图标，允许图标被边界裁切，但不把所有固定控件叠在一起。
- 标题只使用剩余宽度，宽度为 0 时自然不渲染。

源码证据：

- [`tab.h`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab.h#75) 定义 inactive close button 的桌面/touch 内容宽度阈值。
- [`tab.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab.cc#1017) 实现 pinned、active、inactive、极窄状态下的图标/close/标题可见性优先级。

体验含义：Chrome 不会要求一个 30px tab 同时容纳 favicon、标题、状态徽标和关闭按钮；它把“当前可操作”与“后台可识别”分开设计。

### 2.3 空间仍不够时，隐藏完整 tab，而不是制造重叠 tab

当所有 tab 已到 minimum，Chromium 的 layout 可以宽于容器。`TabContainerImpl` 会判断 tab 的右边界是否超过可用条带；被尾部裁切或激活后会被裁切的 tab 设为不可见，避免只露半个命中区或与固定的新建按钮重叠。

源码证据：[`tab_container_impl.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_container_impl.cc#1553)。

这说明 Chrome 的主条带本身不是“所有 tab 永远完整可见”的唯一真相源；Tab Search、快捷键、分组和其它导航能力必须补上。

### 2.4 Tab Search 是容量溢出的核心补偿，不是锦上添花

Chrome 官方帮助把 Tab Search 作为默认可固定在 tab strip 的能力：用户能搜索全部 open tabs，直接激活或关闭；也可使用 `Ctrl/Cmd + Shift + A`，或在地址栏输入 `@tabs`。Chrome 官方博客还明确说明 Tab Search 能跨窗口找 tab，并可显示最近关闭的 tab。

产品证据：

- [Chrome Help：Manage tabs](https://support.google.com/chrome/answer/2391819?co=GENIE.Platform%3DDesktop&hl=en#zippy=%2Csearch-open-tabs-with-tab-search) 描述 Tab Search、`@tabs`、激活与关闭。
- [Chrome 官方博客：Tab Search](https://blog.google/products-and-platforms/products/chrome/faster-chrome/) 描述跨窗口搜索 open tabs。
- [Chrome 团队使用方式](https://blog.google/products-and-platforms/products/chrome/how-the-chrome-team-uses-chrome/) 说明 Tab Search 会即时过滤，并覆盖 open/recently closed tabs。

体验含义：当 tab 变窄或不在主条带可见区时，Chrome 给用户一个确定、可搜索、可关闭的全量清单，而不是要求用户猜测水平滚动位置。

### 2.5 Hover card 负责恢复被压缩掉的信息

Chrome 在 tab 标题不可读时用 hover card 展示标题、域名，配置允许时还能展示页面缩略图和内存信息。Chromium 的 hover 延迟会随 tab 宽度变化：越窄、主条带信息越少，hover card 越快出现；当前源码的基础范围约为 300～800ms，标准宽 tab 还会额外增加延迟。

源码与产品证据：

- [`tab_hover_card_controller.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/hovercard/tab_hover_card_controller.cc#80) 根据 tab 宽度计算 hover card 延迟。
- [Chrome 官方博客：tab preview](https://blog.google/products-and-platforms/products/chrome/organize-your-tabs-and-stay-productive-chrome/) 把 hover preview 定位为大量相似 tab 的识别工具。

### 2.6 连续关闭时冻结布局，避免按钮从鼠标下逃走

Chrome 把“连续关闭多个 tab”视为独立交互模式：

- 鼠标点击关闭后进入 tab closing mode，暂时冻结用于布局的可用宽度。
- 指针只要仍在 tab strip 附近，后续 tab 不会立即铺满空白，新的 close target 会继续落在鼠标下。
- watched region 在 tab strip 下方扩展 40 DIP、向新建按钮方向扩展 60 DIP，允许用户轻微漂移而不退出 closing mode。
- touch 没有 hover/稳定光标，因此关闭后等待 2 秒再重排。

源码与单测证据：

- [`tab_container_impl.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_container_impl.cc#702) 的 closing mode、鼠标 watcher 与 touch resize timer。
- [`tab_strip_unittest.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_strip_unittest.cc#460) 验证 active minimum 和鼠标连续关闭期间 inactive tab 不缩小。

体验含义：多 tab 的关键不只是“能看到”，还包括“连续操作时目标不跳”。

### 2.7 Pin、Group、Vertical tabs 是降低主条带压力的结构化工具

- pinned tab 使用固定紧凑宽度，只展示图标，适合长期入口。
- tab groups 可命名、着色、整体拖动并折叠到组名/色点。
- Chrome 2026 官方帮助已列出 vertical tabs：标题可完整展示、列表可滚动、宽度可调、折叠态可 hover 展开。Chromium 源码仍以 feature/rollout 控制其可用性，因此不能假设所有平台/用户立即可用。

产品证据：[Chrome Help：pin、groups、vertical tabs](https://support.google.com/chrome/answer/2391819?co=GENIE.Platform%3DDesktop&hl=en)。

对 Runweave 的启示不是立刻照搬 pin/group/vertical tabs，而是：当 tab 数量进入“管理问题”而非“排版问题”时，不能继续只改 flex CSS。

### 2.8 键盘、可访问性与误关闭恢复形成兜底

Chrome 支持下一/上一 tab、指定序号、最后一个 tab、关闭当前 tab、恢复最近关闭 tab、键盘移动 tab、键盘聚焦/操作 tab group。Chrome 的 tab view 还维护可访问名称，而不是把可见的截断标题当作唯一名称。

产品证据：[Chrome Help：Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179?co=GENIE.Platform%3DDesktop&hl=en-GB)。

## 3. Chrome 没有采用的做法

从当前源码可以明确排除以下思路：

- **所有 tab 无差别等分到 0**：active/inactive 有不同 minimum，且 minimum 是硬约束。
- **所有控件始终常驻**：inactive close、标题、favicon/状态图标都有宽度与状态条件。
- **空间不足仍展示半个可点击 tab**：尾部被裁切的 tab 会被设为不可见。
- **关闭后立即让所有 tab 铺满**：鼠标 closing mode 刻意冻结布局。
- **只靠主条带找 tab**：Chrome 同时提供 Tab Search、`@tabs`、hover card、groups、快捷键和恢复入口。

“恢复横向滚动”可以是 Runweave 的实现工具，但它不是 Chrome 体验的完整答案。

## 4. Runweave 当前实现与 Chrome 的差异

### 4.1 当前 sidecar 的真实容量

Runweave sidecar 最小宽度是 320px，最大宽度是窗口的 60%：

- `frontend/src/features/terminal/preview-store.ts:127-143`
- `frontend/src/components/terminal/terminal-preview-panel-actions.ts:90-105`

在 320px sidecar 中，扣除左右 padding、固定的新建按钮和间距，tab 列表约剩 272px。10 个 tab 再扣 9 个 4px gap，平均每个 sortable slot 约为：

```text
(320 - 16px horizontal padding - 28px new-tab button - 4px outer gap - 9×4px tab gaps) / 10
= 23.6px / tab
```

而当前每个 tab 常驻的固定内容至少包括：

- 左右 padding：16px
- group marker：6px
- globe icon：14px
- close button：16px
- close 左 margin：4px
- 多个 gap

即使标题宽度变成 0，23.6px 也无法容纳固定内容。问题不是“标题截断得不好”，而是布局模型在数学上无解。

### 4.2 当前实现缺少分级降噪

`frontend/src/components/terminal/terminal-browser-tabs.tsx:109-235` 当前：

- active/inactive 使用相同 `flex-1 basis-0 min-w-0`。
- group marker、globe、close button 始终渲染。
- active tab 没有独立 minimum。
- inactive close 不会按宽度/hover/focus 隐藏。
- 没有 Tab Overview/Search。
- 容器 `overflow-hidden`，被裁内容没有找回入口。

### 4.3 已有可复用能力

- `browser.tabs` 与 `activeTabId` 已在 `preview-store.ts` 统一管理。
- 已有 `browserTabLabel()`、close/select/reorder 行为。
- 已有 DnD `SortableTabs`。
- 已有 `browserGroupId`、MCP activity、active、loading 等状态，可用于 overview/hover card。
- 已有 opener 右侧插入语义。
- sidecar 已能 resize，适合把 320/480/expanded 作为固定验收宽度。

### 4.4 需要避免的错误类比

Terminal Browser 并不等同于完整 Chrome 窗口：

- 它通常只有 320～480px，而 Chrome desktop tab strip 常占大部分窗口宽度。
- group marker 与 MCP activity 是 agent 控制边界，不是普通网页装饰，不能随意全部隐藏。
- 新 tab 可能来自用户、页面 opener 或 MCP/Playwright，来源与控制组需要可识别。

因此应该复用 Chrome 的**优先级和兜底机制**，而不是照抄视觉尺寸。

## 5. Runweave 推荐方案

### 5.1 设计原则

1. active tab 永远可识别、可选择、可关闭。
2. inactive tab 可以只保留 group marker + favicon，但不能缩成重叠命中区。
3. MCP activity 是高价值状态；tab 极窄时改为点/边框，不常驻完整 `MCP` 文本徽标。
4. 达到 minimum 后停止压缩；全量 tab 通过 overview/search 找回。
5. 新建按钮与 overview/search 按钮固定，不参与压缩。
6. hover、键盘 focus、touch 使用不同的 close 展示规则。
7. 连续关闭期间不改变鼠标下 tab 的位置。

### 5.2 推荐的三层 tab 展示状态

以下是基于当前 36px tab bar、图标尺寸和 sidecar 宽度得出的首轮建议值，最终应通过原型/Playwright 校准：

| 状态          |  建议宽度 | 展示内容                                          | close 规则                                   |
| ------------- | --------: | ------------------------------------------------- | -------------------------------------------- |
| `comfortable` | 96～180px | group marker、favicon、标题、MCP 文本/状态        | active 常驻；inactive 宽度足够时常驻或 hover |
| `compact`     |  56～95px | group marker、favicon、截短标题；MCP 改为点/边框  | active 常驻；inactive 仅 hover/focus         |
| `icon-only`   |  40～55px | group marker + favicon，标题隐藏；状态用边框/角标 | inactive 不常驻；active 不应进入此档         |

active minimum 建议从 72px 起验证，inactive minimum 建议从 40px 起验证。它们不是 Chrome DIP 的直接复制，而是从 Runweave 当前固定内容计算出的第一轮 token。

### 5.3 宽度分配算法

```text
available = stripWidth - fixedActionsWidth - gaps

1. 若所有 tab 使用 preferredWidth 可放下：
   使用 min(preferredWidth, equalShare)，最大 180px。

2. 若放不下 preferred，但 activeMin + inactiveMin 总和可放下：
   active 至少 72px；其余空间按 inactive 均分，但不低于 40px。

3. 若 minimum 总和仍放不下：
   不再压缩。
   active 保持至少 72px，inactive 保持至少 40px；
   主条带进入 overflow 状态，active 自动进入可视区；
   Overview/Search 显示总量与隐藏数量。
```

实现上可以使用 CSS flex + per-state min-width；内容降级优先用 container query，避免在 React 中为每次 resize 维护一份重复布局状态。

### 5.4 Overflow 不是一条看不见的滚动条

推荐组合：

- tab viewport 可支持触控板/Shift+wheel 横向滚动，隐藏原生 scrollbar。
- active tab 变化时调用 `scrollIntoView({ block: "nearest", inline: "nearest" })`。
- 新增固定的 Tab Overview/Search 按钮，至少支持：
  - 搜索 title / URL / group id。
  - 显示全部 tab、active、MCP activity、loading。
  - 激活 tab。
  - 关闭 tab。
  - 键盘上下选择、Enter 激活、Delete/快捷操作关闭。
- overview 是全量真相入口；横向滚动只是快速浏览手势。

这比“纯 Chrome 式尾部隐藏”更适合 Runweave 的窄 sidecar，也比“只恢复 overflow-x-auto”更可发现。

### 5.5 Close button 与连续关闭

- active close：常驻；若 active 进入极端窄宽，应优先保 close，再隐藏标题/MCP 文本。
- inactive close：只在 comfortable 或 hover/focus 时显示；compact/icon-only 默认隐藏。
- close 最好覆盖/替换尾部内容，不应在 hover 时临时扩宽 tab。
- 鼠标关闭后冻结 tab widths 与 scroll offset，直到 pointer 离开 tab strip（可允许少量垂直 slop）。
- touch/pen 关闭后使用约 1.5～2 秒定时恢复布局；没有 hover 时不能永久冻结。
- 最后一个 tab 的现有“自动补 New Tab”行为保持不变。

### 5.6 Hover card

第一版不必复制 Chrome 缩略图，但应该替代只依赖原生 `title`：

- 显示完整 title、URL、group label。
- 显示 MCP activity/loading/device mode。
- compact/icon-only tab 使用更短延迟，comfortable tab 使用更长延迟。
- hover card 不应遮挡当前 close target，也不应在拖拽期间出现。

### 5.7 键盘与无障碍

- 保持 `role="tablist"` / `role="tab"` / `aria-selected`。
- 使用 roving `tabIndex`，避免 20 个 tab 全部进入顺序 Tab 焦点链。
- Left/Right 切换焦点；Enter/Space 激活；Home/End 到首尾。
- overview/search 必须能完全用键盘操作。
- 可访问名称使用完整 title/URL/group 状态，不能使用视觉截断后的字符串。
- close button 的可访问名称应包含 tab 名称，例如 `Close <title>`，避免多个完全相同的“Close browser tab”。

### 5.8 DnD 与持久化

- 达到 overflow 后，拖拽靠近左右边缘应自动滚动。
- 拖拽开始前保留 8px activation threshold，避免点击 tab 时误拖。
- 拖拽期间不触发 hover card，也不进入 closing mode。
- renderer 的 reorder 结果必须同步给 Electron 持久化层；当前仅修改 frontend store，重启后顺序仍可能回到主进程 `Map` 插入顺序，这应在实施时一并定义清楚，但不要混成纯 CSS 修复。

## 6. 方案对比

| 方案                                            | 优点                                                        | 缺点                                                                  | 判断                          |
| ----------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| 当前 equal-shrink + hidden overflow             | 代码少；总能保持单行                                        | 数学上会低于固定控件宽度；重叠/裁剪；无找回入口                       | 拒绝                          |
| 恢复 76px minimum + 横向滚动                    | 最小改动；立即恢复可操作性                                  | active/inactive 无差异；close 常驻浪费空间；隐藏 scrollbar 可发现性差 | 可做紧急止血，不是终局        |
| 仅模仿 Chrome 尾部隐藏                          | 主条带干净；实现概念清楚                                    | Runweave sidecar 太窄；没有 Tab Search 时大量 tab 不可发现            | 必须与 overview/search 同时做 |
| adaptive strip + overview/search + close freeze | active 保真；容量可扩展；与 Chrome 原则一致；适配窄 sidecar | 工作量高于 CSS 回滚，需要布局状态与交互验收                           | **推荐**                      |
| vertical tabs                                   | 最适合 20+ tab 和长标题                                     | 会改变整个 Browser panel 信息架构，与现有页面纵向空间竞争             | 后续方向，不作为本次修复      |

## 7. 分阶段实施建议

### Phase 1：恢复可操作性

- 引入 active/inactive minimum。
- inactive close 仅 hover/focus。
- MCP 文本徽标在 compact/icon-only 降级为视觉点/边框。
- overflow viewport + active `scrollIntoView`。
- 保留固定的新建按钮。

成功标准：320px sidecar、10 个 tab 时无控件重叠；active 可见且可关闭；任一 tab 可通过滚动到达。

### Phase 2：解决可发现性

- 增加 Tab Overview/Search 固定入口。
- 支持搜索、激活、关闭、键盘导航。
- 显示隐藏数量/总 tab 数。

成功标准：20 个 tab 时无需精确横向滚动即可在 3 次操作内找到并激活指定 tab。

### Phase 3：解决高频操作稳定性

- mouse close freeze。
- touch delayed resize。
- hover card。
- overflow drag auto-scroll。
- reorder 持久化契约。

成功标准：连续关闭 5 个相邻 tab 时鼠标无需横向追踪；重启后 tab 顺序一致。

### 暂不做

- pinned tabs。
- 用户可编辑 tab groups（现有 `browserGroupId` 是控制域，不等于 Chrome 用户分组）。
- vertical tabs。
- hover thumbnail。
- recently closed tabs / reopen history。

这些能力有价值，但不是解决当前 320px 多 tab 重叠的最短路径。

## 8. 验收矩阵

实施计划和 Playwright 用例至少覆盖：

| 维度         | 取值                                                             |
| ------------ | ---------------------------------------------------------------- |
| sidecar 宽度 | 320px、480px、expanded                                           |
| tab 数量     | 1、3、6、10、20                                                  |
| active 位置  | 首、中、尾、当前不可见区                                         |
| 状态         | 普通、loading、MCP active、不同 browserGroupId                   |
| 输入         | mouse、trackpad horizontal scroll、keyboard、touch/pen（可用时） |
| 操作         | 新建、opener 新建、选择、关闭、连续关闭、拖拽、搜索、窗口 resize |

关键断言：

1. 任意宽度/数量下，tab 的交互区域不重叠。
2. active tab 始终在可视区，完整可访问名称可读，close 可操作。
3. inactive tab 不低于 minimum；compact/icon-only 状态切换没有布局抖动。
4. 固定的新建/overview 按钮始终可见。
5. 10/20 tab 时可以通过 overview 搜索并激活首、中、尾任意 tab。
6. hover/focus 显示 close 不改变 tab 宽度。
7. 连续关闭时 close target 不横向跳动。
8. 拖拽与横向 overflow 共存，边缘自动滚动且顺序持久化。
9. 页面 opener 创建的新 tab 仍插在 opener 右侧。
10. MCP activity 在所有展示档位都有不歧义的可视线索。

## 9. 最终判断

这次问题的根因不是某个 Tailwind class 写错，而是当前布局把三个互相冲突的目标同时交给了 `flex: 1 1 0`：

- 所有 tab 必须在一行内出现；
- 每个 tab 的固定控件必须常驻；
- 容器又不能滚动或提供全量入口。

Chrome 的答案是主动拆开这三个目标：主条带只保证当前任务和最小识别；内容按价值降级；容量问题交给 search/group/overview；高频操作用专门状态保证稳定。

Runweave 应采用同样的系统思路。最小正确方向不是继续压缩，而是：

> **active 保真，inactive 降噪，minimum 有底线，overflow 有入口，连续操作不跳。**

## 10. 主要资料

- [Chromium `tab_style.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/tabs/tab_style.cc)
- [Chromium `tab.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab.cc)
- [Chromium `tab_strip_layout.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_strip_layout.cc)
- [Chromium `tab_container_impl.cc`](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_container_impl.cc)
- [Chromium tab strip layout tests](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_strip_layout_unittest.cc)
- [Chromium tab strip interaction tests](https://chromium.googlesource.com/chromium/src/+/5369d2098277d37f9724edabe9ac62d7e7a5a9fc/chrome/browser/ui/views/tabs/tab_strip_unittest.cc)
- [Chrome Help：Manage tabs](https://support.google.com/chrome/answer/2391819?co=GENIE.Platform%3DDesktop&hl=en)
- [Chrome Help：Keyboard shortcuts](https://support.google.com/chrome/answer/157179?co=GENIE.Platform%3DDesktop&hl=en-GB)
- [Chrome 官方博客：Tab Search](https://blog.google/products-and-platforms/products/chrome/faster-chrome/)
- [Chrome 官方博客：groups、collapse、hover preview](https://blog.google/products-and-platforms/products/chrome/organize-your-tabs-and-stay-productive-chrome/)
