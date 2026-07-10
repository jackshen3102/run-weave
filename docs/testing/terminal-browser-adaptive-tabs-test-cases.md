# Terminal Browser 自适应多 Tab 测试案例

本文档是 Terminal Browser 自适应多 Tab 行为的 Agent Team 可追溯验收来源，稳定事实以 `docs/architecture/terminal-code-preview.md` 为准。浏览器行为必须使用 `$playwright-cli` 取证；桌面应用启动、重启和窗口操作使用 `$computer-use`。typecheck/lint 只是前置门禁，不能替代行为验收。

## Agent Team 解析格式

- 每条 case 使用 `### TBAT-xxx 标题` 三级标题。
- case 正文只使用 loader 可识别的 `标签`、`步骤`、`期望`、`失败判定`；环境准备和证据要求都写入步骤或期望。
- case ID 唯一且连续，可直接填写到 Agent Team 的 `测试案例文件`：`docs/testing/terminal-browser-adaptive-tabs-test-cases.md`。
- 每条 case 独立准备环境，不依赖上一条遗留状态；失败即保留现场证据并停止当前 case。

## 范围

覆盖：

- 320px～800px sidecar 中 1～20 个 tab 的宽度、overflow 和 active 入视。
- comfortable/compact/icon-only、MCP/loading、close 可见性。
- Overview/Search、mouse/touch 连续关闭冻结、resize、键盘和拖拽。
- Renderer 与 Electron 的 tab 顺序同步、持久化、重启恢复和竞态收敛。
- page-open、CDP create/activate/close、MCP activity 和 WebContentsView 回归。

不覆盖：

- pinned tabs、可编辑 groups、vertical tabs、recently closed、hover thumbnail。
- App/Ionic、backend HTTP API、鉴权和 Origin；本改动没有这些调用方或协议。
- AI tab 上限、CDP 连接上限的完整安全测试；沿用 `docs/testing/terminal-browser-cdp-mcp-test-cases.md`。
- 单元测试/Vitest；本仓库使用真实浏览器和桌面端验收。

## 前提事实

- 原型：`docs/prototypes/terminal-browser-adaptive-tabs/`。
- UI：`frontend/src/components/terminal/terminal-browser-tabs.tsx`。
- 状态：`frontend/src/features/terminal/preview-store.ts`。
- Renderer/Electron：`frontend/src/components/terminal/use-terminal-browser-controller.ts`、`electron/src/preload.ts`、`electron/src/terminal-browser-view.ts`。
- 持久化：Electron `userData/terminal-browser-tabs.json`，schema version 1，最多恢复 5 个 tab。
- React harness：`frontend/src/e2e/terminal-browser-tabs-harness.tsx`。
- width token：preferred 180px、active minimum 80px、inactive minimum 44px、gap 4px。
- density：`>95px` comfortable，`64～95px` compact，`44～63px` icon-only inactive。

## 必跑门禁

按顺序执行，任一失败即停止：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
pnpm --filter ./electron typecheck
pnpm --filter ./electron lint
git diff --check
```

浏览器场景启动 `pnpm dev`；真实桌面场景启动 `pnpm dev:electron`。先用 `$computer-use` 将桌面端准备到 Terminal → Browser，再用 `$playwright-cli` 对页面 DOM、交互和截图取证。

## 测试案例

### TBAT-001 单 tab 不拉满且 active 保持可关闭

标签：browser-ui width-boundary playwright

步骤：

1. 启动 frontend，用 `$playwright-cli` 加载 Browser tab React harness。
2. 设置 host width=800，渲染 1 个 active tab。
3. 读取 tab、close、Overview 和 New Tab 的 bounding box，并保存 DOM snapshot。

期望：

1. 唯一 tab width=180px，不拉满 viewport。
2. active 的 title、group marker、favicon 和 close 完整可见且可点击。
3. Overview 和 New Tab 固定可见，与 tab 无重叠。

失败判定：

1. tab 超过 180px、拉满 viewport 或小于 active minimum。
2. active close 不可见、不可点击，或任一固定元素发生重叠。

### TBAT-002 中等空间等分且不产生舍入 overflow

标签：browser-ui width-rounding playwright

步骤：

1. 用 harness 设置 host width=480，渲染 3 个 tab，最后一个为 active。
2. 使用 `$playwright-cli` 读取三个 slot、viewport 的 `clientWidth/scrollWidth` 和 fixed actions 位置。
3. 保存几何数据和 DOM snapshot。

期望：

1. 三个 tab 等宽，单项宽度在 80～180px。
2. `scrollWidth === clientWidth`，没有由 1px 舍入产生的 overflow。
3. slot 互不重叠，fixed actions 完整可见。

失败判定：

1. 三个 tab 不等宽、发生重叠或超出 width token。
2. 仅因舍入多出横向滚动，或 fixed actions 被挤出。

### TBAT-003 320px 与 10 tabs 保留 minimum 和恢复入口

标签：browser-ui minimum overflow playwright

步骤：

1. 用 harness 设置 host width=320，渲染 10 个 tab，中间 tab 为 active。
2. 读取全部 slot、viewport、Overview 和 New Tab 的 bounding box。
3. 保存截图与 `clientWidth/scrollWidth/scrollLeft`。

期望：

1. active width≥80px，inactive width≥44px，所有 slot 无重叠。
2. track 产生横向 overflow，但 Overview 和 New Tab 不随 track 滚动。
3. active 完整处于 viewport 内，用户始终有横向滚动和 Overview 两条恢复路径。

失败判定：

1. 任一 tab 小于 minimum、内部内容重叠或 active 被裁剪。
2. fixed actions 被滚走，或 minimum 总和超出后没有 overflow。

### TBAT-004 15 组宽度与数量矩阵满足几何约束

标签：browser-ui boundary-matrix playwright

步骤：

1. 用 harness 组合 width=320/480/800 与 tab count=1/3/6/10/20，共 15 组独立场景。
2. 每组把尾 tab 设为 active，等待一帧后读取 slot、viewport 和 fixed actions 几何数据。
3. 汇总每组 tab count、min/max width、overlap count 和 active visibility。

期望：

1. 15/15 场景 tab 数正确、overlap count=0。
2. 每组 active 完整可见，fixed actions 完整可见。
3. 所有 tab min width≥44px、max width≤180px。

失败判定：

1. 15 组中任一组数量、overlap、active visibility 或 min/max 断言失败。
2. 只提交截图但没有可核对的几何汇总。

### TBAT-005 首中尾 active 都自动进入 viewport

标签：browser-ui active-scroll playwright

步骤：

1. 设置 width=480、20 tabs，分别独立渲染第 1、10、20 个 active 场景。
2. 每次等待下一帧，读取 active 与 viewport bounding box、viewport `scrollLeft`。
3. 保存三组 DOM/数值证据。

期望：

1. 三个场景中 active 左右边界都在 viewport 内。
2. 首 tab 对应左侧 scroll，尾 tab 对应最大 scroll，中间 tab 使用最小必要滚动。
3. 只滚动 tab viewport，不引起页面级横向滚动。

失败判定：

1. active 被部分裁剪，或必须人工滚动后才出现。
2. 自动入视滚动了页面或错误祖先。

### TBAT-006 sidecar resize 后重新分配宽度并保留 active

标签：browser-ui resize active-scroll playwright

步骤：

1. 在真实页面或 harness 中设置 width=800、10 tabs、尾 tab active。
2. 用 `$playwright-cli` 依次缩到 480、320，再扩回 800。
3. 每次 resize 后读取 active/viewport bounding box、slot width 和 frozen 状态，并保存截图。

期望：

1. 每次 resize 后 active 都完整可见，slot 遵循 180/80/44 规则。
2. resize 会清除关闭操作留下的旧 frozen width。
3. 扩回 800 后 tab 可以重新展开，无重叠或空白 viewport。

失败判定：

1. active 丢失、被裁剪、slot 重叠或 viewport 空白。
2. 旧 frozen width 在 resize 后仍生效，导致宽度卡住。

### TBAT-007 density、MCP 和 loading 按阈值降级

标签：browser-ui density mcp loading playwright

步骤：

1. 用 harness 分别构造 120px、80px、44px slot，包含普通、MCP active、loading tab。
2. 用 `$playwright-cli` 读取 title、MCP badge/dot、favicon/spinner、inactive close 的可见性。
3. 保存三个阈值场景的截图和 DOM 摘要。

期望：

1. 120px 显示完整 title、MCP badge 和可用 close。
2. 80px 保留 title，MCP 降为状态点，active close 仍可用。
3. 44px inactive 只显示 group marker 与 favicon/spinner，隐藏 title、MCP 文本和 close；MCP 状态仍可感知。

失败判定：

1. 任何阈值下固定元素重叠或 loading 没有可见状态。
2. 44px inactive 仍塞入 title/close，或 active close 被隐藏。

### TBAT-008 inactive close 的 hover/focus 不改变布局

标签：browser-ui close hover focus playwright accessibility

步骤：

1. 设置 width=800、6 tabs，记录一个非 icon-only inactive tab 的宽度和相邻 tab x 坐标。
2. 用 `$playwright-cli` hover 该 tab，再用键盘 focus 其选择按钮。
3. 分别读取 close 可见性、slot width 和相邻 tab x 坐标。

期望：

1. hover/focus 时 close 可见、可聚焦、可点击。
2. close 显示前后 slot width 和相邻 tab x 坐标不变。
3. tab 选择按钮与 close 按钮保持独立语义，不嵌套 button。

失败判定：

1. close 出现导致 tab 变宽或相邻 tab 跳动。
2. close 不可键盘访问，或 DOM 出现嵌套 button。

### TBAT-009 Overview 按 title、URL、group 搜索全部 tab

标签：browser-ui overview search playwright

步骤：

1. 设置 width=320、20 tabs，数据中分别放入唯一 title、URL 片段和 browserGroupId。
2. 打开 `Search all browser tabs`，记录空 query 结果数。
3. 依次输入 title、URL、group query，再输入无匹配 query，保存结果 DOM。

期望：

1. 空 query 展示全部 20 个结果，顺序与 tab strip 一致。
2. 三类 query 都只保留对应匹配项且不重排。
3. 无匹配时显示 `No matching tabs`。

失败判定：

1. Overview 只包含当前 viewport 可见 tab，或缺少任一搜索字段。
2. 搜索重排结果、错误匹配，或无结果状态缺失。

### TBAT-010 Overview 选择和关闭作用于正确 tab

标签：browser-ui overview select close playwright

步骤：

1. 设置 width=480、20 tabs，选择一个当前 viewport 外的目标 tab。
2. 从 Overview 点击该 tab 的选择按钮，读取 active id 和 viewport。
3. 重新打开 Overview，点击另一行独立 close，读取 tab ids、count 和 Popover 状态。

期望：

1. 选择后 Popover 关闭，目标成为 active 并完整进入 viewport。
2. close 只删除指定 tab，不触发该行选择，tab count 减 1。
3. close 后 Overview 保持可用并展示更新后的结果。

失败判定：

1. 选择或关闭串 tab，close 同时触发选择，或 active 未入视。
2. Overview 卡住、关闭错误项，或 DOM 出现嵌套 button。

### TBAT-011 鼠标连续关闭期间关闭目标保持稳定

标签：browser-ui close-freeze mouse playwright

步骤：

1. 设置 width=800、6 tabs，记录 active close 的 x 坐标和所有 slot width。
2. 鼠标不离开 tab bar，连续关闭 active tab 两次，每次后立即记录下一 active close x 坐标和 slot width。
3. 将 pointer 移出整个 tab bar，再记录剩余 slot width。

期望：

1. 连续关闭期间剩余 slot 保持关闭前像素宽度，下一 active close 仍在同一可点击位置。
2. frozen width 按 tab id 对应，不因 active 改变套错对象。
3. pointerleave 后才解除冻结并重新展开。

失败判定：

1. 第一次关闭后 close target 立即跳走或 frozen width 按 index 错位。
2. pointerleave 前提前展开，或 pointerleave 后仍不解冻。

### TBAT-012 touch/pen 关闭在 1.8 秒后解除冻结

标签：browser-ui close-freeze touch timing playwright

步骤：

1. 独立渲染 width=800、6 tabs，通过 `$playwright-cli` 触发 `pointerType=touch` 的 close。
2. 在 1.6 秒读取 slot width，再在 2.1 秒读取 slot width。
3. 重新渲染场景，连续触发两次 touch close，确认第二次操作重置 timer。

期望：

1. 1.6 秒时宽度仍冻结，2.1 秒时已解除并重新分配。
2. 第二次 touch close 从自身触发时间重新计算 1.8 秒。
3. harness unmount 后 timer 不再修改状态或产生 console error。

失败判定：

1. 1.6 秒前提前解冻，或 2.1 秒后仍冻结。
2. 旧 timer 提前解除新冻结，或 unmount 后出现状态更新错误。

### TBAT-013 键盘导航使用 roving focus 并循环切换

标签：browser-ui keyboard accessibility playwright

步骤：

1. 渲染 6 tabs，第三个 active 并 focus 其 tab 按钮。
2. 依次按 Right、Left、Home、End，再从尾 tab 按 Right。
3. 每步读取 active id、`document.activeElement`、各 tab 的 `tabIndex` 和 viewport。

期望：

1. active 与 DOM focus 同步移动；Home 到首、End 到尾、尾部 Right 循环到首。
2. 任一时刻只有 active tab `tabIndex=0`，其余为 -1。
3. 新 active 完整入视，按键不滚动页面。

失败判定：

1. 只移动 focus 不切 active，或出现多个 `tabIndex=0`。
2. 按键滚动页面、焦点丢失或 active 被裁剪。

### TBAT-014 拖拽排序不丢 tab 且 active 身份不变

标签：browser-ui drag-reorder playwright

步骤：

1. 渲染 6 tabs，第三个 active，记录初始 id 顺序和 active id。
2. 用 `$playwright-cli` 将第一个 tab 拖到第五个位置。
3. 读取 drop 后顺序、id 集合、active id、DragOverlay/目标几何数据。

期望：

1. 顺序按 drop 目标改变，id 集合完全一致且无重复。
2. active id 不变并保持可见，不因 index 变化切到其他 tab。
3. DragOverlay 宽度与源 tab 一致，拖拽不触发误点击。

失败判定：

1. drop 无效、tab 丢失/重复或 active 按 index 错换。
2. DragOverlay 宽度错误，或拖拽同时触发选择/关闭。

### TBAT-015 Electron 顺序在 UI、IPC、文件和重启后一致

标签：electron reorder persistence restart playwright computer-use

步骤：

1. 用 `$computer-use` 启动真实 Electron，在 Terminal Browser 准备 5 个合法 http/https/about:blank tab，记录 id、active 和初始顺序。
2. 用 `$playwright-cli` 拖拽形成新顺序，读取 UI 和 `terminalBrowserListTabs()`。
3. 读取 Electron userData 下 `terminal-browser-tabs.json` 的 `tabs[]` 顺序。
4. 用 `$computer-use` 正常重启客户端，再读取恢复后的 UI、active 和顺序。

期望：

1. 拖拽后 UI、IPC list、文件 `tabs[]` 顺序一致。
2. 重启后顺序仍一致，active 仍为重启前 active。
3. 持久化 schema 保持 version 1，5 个合法 tab 均恢复。

失败判定：

1. 四个观察面任一顺序不一致，或重启退回创建顺序。
2. schema version 改变、active 错误或合法 tab 丢失。

### TBAT-016 非法或竞态 reorder 不产生半成功状态

标签：electron reorder validation race resync

步骤：

1. 在真实 Electron 准备 5 个 tab，保存 UI/IPC 顺序和持久化文件快照。
2. 分别调用包含重复 id、缺失 id、未知 id 的 reorder payload，记录 reject 和文件内容。
3. 重新准备场景，在 drop 计算完成后通过 CDP 外部关闭其中一个 tab，等待 Renderer resync。

期望：

1. 非全排列 payload reject `Invalid terminal browser tab order`，UI 权威顺序和文件均不改变。
2. 竞态 reject 后 Renderer 使用 Electron live list 收敛。
3. 最终 id 无重复、无 ghost tab、无已关闭 tab。

失败判定：

1. 主进程接受重复/缺失/未知 id，或文件写入半成功顺序。
2. Renderer 未 resync，永久保留 ghost tab 或与 IPC list 分叉。

### TBAT-017 page-open tab 插入 opener 右侧

标签：electron page-open opener order browser-group

步骤：

1. 在真实 Electron 准备顺序 A、B、C，记录 B 的 browserGroupId。
2. 在 B 页面触发 tab-style `window.open` 创建 D。
3. 读取 UI、`terminalBrowserListTabs()`、持久化 `tabs[]` 和 D 的 browserGroupId。

期望：

1. UI、IPC list、持久化顺序均为 A、B、D、C。
2. D 继承 B 的 browserGroupId，active 行为保持当前产品语义。
3. Renderer 和 Electron 不出现一端插入、另一端追加的分叉。

失败判定：

1. D 只在 Renderer 插到 B 后而主进程追加到尾部，或三处顺序不一致。
2. D 未继承 opener group，或创建后出现重复 tab。

### TBAT-018 CDP create/activate/close 与 MCP activity 无回归

标签：electron cdp mcp regression playwright

步骤：

1. 在真实 Electron 复制 group-scoped CDP endpoint，并用 Playwright/CDP 连接。
2. 通过 CDP 创建 tab、导航/点击触发 MCP activity、激活另一 tab、关闭新 tab。
3. 用 `$playwright-cli` 记录 tab bar 增删/active/MCP 状态，用页面截图确认 WebContentsView 内容。
4. 对比操作前后的 target id 和 browserGroupId。

期望：

1. UI 实时创建、激活和关闭正确 tab，active 自动入视。
2. 只有真实 MCP 操作显示 activity，状态不串 tab。
3. UI reorder 不改变 CDP target identity 或 group，WebContentsView 内容与 active 一致。

失败判定：

1. 迟到事件覆盖错误 active、MCP 状态串 tab或关闭后出现 ghost tab。
2. target/group 因 UI 行为改变，或 active tab 显示错误 WebContentsView。

### TBAT-019 tab strip 与 Overview 可访问性语义完整

标签：browser-ui accessibility keyboard overview playwright

步骤：

1. 渲染 10 tabs，包含 active、inactive、MCP tab，获取 accessibility snapshot。
2. 仅用键盘打开 Overview、输入搜索、选择结果、重新打开并关闭结果。
3. 按 Escape 关闭 Overview，读取 trigger focus 和 tab/close 语义。

期望：

1. tablist 名为 `Browser tabs`；每个 tab 有唯一可读名称和正确 selected 状态。
2. tab 与 close 是独立 button；Overview trigger、search、result select、result close 均可聚焦。
3. Escape 关闭后焦点回到 Overview trigger，键盘全流程无需鼠标。

失败判定：

1. 存在嵌套 button、tab 无名称/selected、close 无法键盘访问。
2. 焦点逃逸、键盘流程中断，或 Escape 后焦点丢失。

## 覆盖清单

- 功能正确性：TBAT-001～010、TBAT-013～015。
- 数值边界：TBAT-001～007，覆盖 1/3/6/10/20 与 320/480/800。
- 状态与时序：TBAT-005、TBAT-010～013。
- 异步、竞态和收敛：TBAT-012、TBAT-016、TBAT-018。
- 持久化与恢复：TBAT-015、TBAT-017。
- 幂等和去重：TBAT-014、TBAT-016。
- 错误与空状态：TBAT-009、TBAT-016。
- 安全与权限：不覆盖；没有新增受保护 API 或远端边界。
- 敏感字段：不覆盖；reorder payload 只有 tab id，不含 token、URL 或正文。
- 回归与兼容：TBAT-017～019。

## 验收通过标准

必须同时满足：

1. 必跑门禁全部通过。
2. Agent Team loader 从本文档解析出 TBAT-001～TBAT-019 共 19 条 acceptance，且每条包含步骤、期望、失败判定。
3. 19 条行为用例全部通过；环境前提不成立时记为 blocked，不得计为 pass。
4. 15 组几何矩阵 15/15 通过，并保存 DOM/数值或截图证据。
5. Electron UI、IPC list、持久化文件、重启恢复顺序一致。
6. CDP、page-open、MCP activity 和 WebContentsView 无回归。
