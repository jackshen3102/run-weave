# Terminal Browser 自适应多 Tab 实施计划

> 状态：已完成（2026-07-10）。原型方向已于 2026-07-10 获得用户初步确认。计划粒度：L2（多文件、跨 Renderer / Electron IPC，已完成真实浏览器与桌面端验收）。

## 1. 目标

把已确认的 Chrome-like tab strip 原型落到真实 Terminal Browser：在 320px～800px sidecar 和 1～20 个 tab 下，当前 tab 始终可识别、可关闭、可自动进入可视区；后台 tab 按空间分级降噪，达到最小宽度后横向 overflow；固定的 Tab Overview/Search 始终提供全量找回入口；连续关闭时关闭目标不从鼠标下跳走。

计划完成后必须同时满足：

- active tab 最小宽度 80px，inactive tab 最小宽度 44px，单 tab 最大宽度 180px，tab 间距 4px。
- 空间充足时展示完整 title/MCP；空间收窄时依次降级为 compact、icon-only，不发生图标、文字、关闭按钮重叠。
- tab viewport 可以横向滚动，Overview/Search 和 New Tab 固定在 viewport 外侧，不随 tab 一起滚走。
- active tab 在首次同步、选择、新建、关闭、重排和 sidecar resize 后自动进入可视区。
- 鼠标连续关闭期间冻结剩余 tab 的像素宽度，pointer 离开 tab bar 后解除；touch/pen 在 1.8 秒后解除。
- Overview/Search 能按 title、URL、browser group 搜索全部 tab，并支持选择、关闭和无结果状态。
- Left/Right/Home/End 使用 roving tab focus 切换 tab；拖拽排序保持可用，并由 Electron 持久化恢复顺序。

## 2. 原型资产与冻结结论

- 原型目录：`docs/prototypes/terminal-browser-adaptive-tabs/`
- 原型说明：`docs/prototypes/terminal-browser-adaptive-tabs/README.md`
- 最终截图：`docs/prototypes/terminal-browser-adaptive-tabs/prototype-preview.png`
- 启动命令：`python3 -m http.server 6188 --directory docs/prototypes/terminal-browser-adaptive-tabs`
- 交互调研：`docs/plans/2026-07-10-terminal-browser-chrome-tab-strip-ux-research.md`
- 配套验收用例：`docs/testing/terminal-browser-adaptive-tabs-test-cases.md`

原型表达的是用户可见行为，不是生产代码或协议依据。实现不得复制原型 JS；宽度计算、Electron 顺序和错误恢复必须以当前产品代码为准。

### 进入产品的核心功能

1. active/inactive 非对称 minimum 和 180px maximum。
2. comfortable / compact / icon-only 三档降级。
3. 横向 overflow、active 自动入视、固定 Overview/Search。
4. inactive close 按 hover/focus 显示；icon-only inactive 通过 Overview 关闭。
5. mouse/touch 连续关闭冻结。
6. 搜索、选择、关闭、新建、拖拽和键盘导航。
7. Electron 端保存用户拖拽后的 tab 顺序。

### 不进入产品的原型辅助功能

- `tabs`、`width`、`active` URL 参数。
- `prototypeControls=1` helper。
- mock terminal 输出、mock 网页内容和原型说明卡片。

### 明确非目标

- 不实现 pinned tabs、可编辑 tab groups、vertical tabs、recently closed、hover thumbnail。
- 不改变 AI tab 上限、CDP 连接上限和重启最多恢复 5 个 tab 的既有策略。
- 不改变 Browser tab URL、MCP activity、device、headers、annotation 或 CDP Proxy 合约。
- 不改 backend HTTP API，不新增 `packages/shared` 协议。
- 不把 Terminal Browser tab 组件迁入 `packages/common`；它没有 App 真实调用方。
- 不新增单元测试文件；行为验证使用 `$playwright-cli` 和真实 Electron。

## 3. 当前代码现状（main @ 82854e3）

### 3.1 已存在的能力

- `frontend/src/components/terminal/terminal-browser-tabs.tsx`
  - 已有 `overflow-x-auto`、隐藏 scrollbar、76px minimum、220px maximum、group marker、MCP activity、关闭、新建和 `SortableTabs`。
  - 原始“overflow hidden 且无 minimum”的不可操作回归已经不在当前代码中。
- `frontend/src/components/ui/sortable-tabs.tsx`
  - 已有 dnd-kit PointerSensor、horizontal sorting、DragOverlay；项目、session、Browser 三处共用。
- `frontend/src/features/terminal/preview-store.ts`
  - 已有 create/select/close/reorder/update；关闭 active tab 时选择相邻 tab，关闭最后一个时创建 New Tab。
- `frontend/src/components/terminal/use-terminal-browser-controller.ts`
  - 已把 Electron 的 create/update/activate/close 事件同步到 Zustand，并在 UI 关闭时调用 `terminalBrowserCloseTab`。
- `electron/src/terminal-browser-view.ts`
  - `terminalBrowserEntries` 管理 WebContentsView；`terminal-browser-tabs.json` 的 `tabs[]` 顺序天然可以承载恢复顺序；恢复会保留输入数组顺序。
- `frontend/src/e2e/terminal-browser-tabs-harness.tsx`
  - 已有轻量 Browser tab DOM harness，可扩展后由 `$playwright-cli` 做真实 React 渲染验证。

### 3.2 与目标的差异

| 维度        | 当前行为                               | 目标行为                                                     |
| ----------- | -------------------------------------- | ------------------------------------------------------------ |
| 宽度        | 所有 tab 同一 76～220px 规则           | 180px preferred；active 80px、inactive 44px minimum          |
| overflow    | 整个 tabbar 横向滚动，New Tab 也会滚走 | 只有 tab viewport 滚动，Overview/New Tab 固定                |
| 降级        | title/MCP/close 一直参与布局           | 按 95px/63px 阈值隐藏 MCP 文本、title、inactive close        |
| active 入视 | 无主动定位                             | 所有导致 active/尺寸变化的事件后直接计算 viewport scrollLeft |
| 全量入口    | 无                                     | 固定 Overview/Search，可搜索、选择、关闭全部 tab             |
| 连续关闭    | 关闭后立即重新分配宽度                 | mouse leave 或 touch timer 前冻结剩余宽度                    |
| 键盘        | 只有 click                             | roving focus + Left/Right/Home/End                           |
| 排序恢复    | 只修改 Renderer store                  | Renderer 乐观重排，Electron 校验并持久化顺序                 |

关键判断：自适应 UI 能力是真的缺失；tab 数据、关闭语义、拖拽基础和持久化文件已经存在。Electron 不需要新存储格式，但需要补“Renderer 顺序 → 主进程顺序”的桥接。

## 4. 产品行为与规则

### 4.1 宽度分配

宽度以真实 tab viewport 的 `clientWidth` 为输入，不读取 sidecar store 的预估宽度。设 tab 数为 `n`，间距为 4px：

1. `180 * n + gapTotal <= viewportWidth`：每个 tab 180px，不拉伸填满剩余空间。
2. 等分宽度仍 `>= 80px`：所有 tab 等宽。
3. 等分低于 80px，但 `80 + 44 * (n - 1) + gapTotal <= viewportWidth`：active 固定 80px，inactive 等分剩余空间。
4. minimum 总和超过 viewport：active 80px、inactive 44px，track 产生横向 overflow。

ResizeObserver 只监听 tab viewport；宽度计算结果用 tab id 映射，避免 reorder 后按旧 index 套错宽度。

### 4.2 三档信息密度

- `> 95px`：group marker、favicon/loading、title、完整 MCP badge、close。
- `64～95px`：保留 title；MCP badge 降为 5px 状态点；inactive close 只在 hover/focus-within 出现且不改变 tab 宽度。
- `44～63px`：inactive 只保留 group marker + favicon/loading，隐藏 title、MCP 文本和 close；active 不会进入这一档，因为 active minimum 为 80px。
- active close 始终可见；所有 inactive tab 均可在 Overview 中关闭。

### 4.3 active 自动入视

在 `activeTabId`、tab 顺序、tab 数量、viewport 宽度或冻结状态变化后，于下一帧读取 active slot 的 `offsetLeft/offsetWidth`：

- active 在 viewport 左侧：`scrollLeft = tabLeft`。
- active 在 viewport 右侧：`scrollLeft = tabRight - clientWidth`。
- 已完整可见：不滚动。

初始化、关闭和 resize 使用即时滚动；用户主动选择/键盘切换可使用平滑滚动。不要依赖 `scrollIntoView`，避免它滚动错误祖先或受 CSS `scroll-behavior` 影响。

### 4.4 连续关闭冻结

- close 的 `pointerdown` 先测量每个 slot 的实际像素宽度，再调用现有关闭动作。
- 删除被关闭 tab 后，剩余 tab 按 id 使用测量值；若新 active 原宽度不足 80px，提高到 80px。
- `pointerType=mouse`：pointer 离开整个 tab bar 后解除冻结并重新计算。
- `pointerType=touch|pen`：1.8 秒后解除；新关闭操作重置 timer。
- sidecar resize、拖拽 reorder、Overview 选择或外部 Electron tab replace 会立即解除旧冻结，避免把过期宽度套给新布局。

### 4.5 Overview/Search

- 固定按钮 aria-label 为 `Search all browser tabs`，显示当前 tab 数 badge。
- 使用现有 Radix `Popover` 和项目 `Input`，不引入新依赖。
- 输入 aria-label 为 `Search browser tabs`；按 `browserTabLabel`、URL、完整 browserGroupId 和可见 group label 做 trim + case-insensitive substring 过滤，保持原 tab 顺序。
- 行级选择按钮激活 tab 并关闭 Popover；独立 close 按钮只关闭该 tab，列表继续展示剩余结果。
- 无结果显示 `No matching tabs`；Escape 由 Popover 关闭并把焦点还给 trigger。

### 4.6 键盘与拖拽

- active tab `tabIndex=0`，其余 `tabIndex=-1`。
- Left/Right 循环选择相邻 tab；Home/End 选择首尾；选择后 focus 对应 tab 并自动入视。
- 保留 dnd-kit 8px activation distance 和水平限制；tab 的显式像素宽度放在现有 renderTab 返回的最外层元素上，`SortableTabs` 通用 API 无需修改。
- DragOverlay 使用同一宽度；drop 后清除关闭冻结，active tab 不变。

## 5. Electron 顺序合约

### 5.1 新增 Renderer bridge

```ts
window.electronAPI.terminalBrowserReorderTabs(
  orderedTabIds: string[],
): Promise<void>
```

- IPC channel：`terminal-browser:reorder-tabs`。
- 输入必须是当前 BrowserWindow 全部 live tab id 的无重复全排列。
- 主进程按 sender 定位 BrowserWindow；长度、类型、重复 id、缺失 id、跨窗口 id 任一不合法时 reject `Invalid terminal browser tab order`，不修改运行时顺序或持久化文件。
- 成功后更新该窗口的显式 tab order，并触发已有 150ms debounce 保存；`terminal-browser-tabs.json` 保持 `version: 1`，不新增字段，数组顺序即恢复顺序。

### 5.2 主进程顺序源

在 `electron/src/terminal-browser-view.ts` 增加 window-scoped order map 和三个窄 helper：

- reconcile：保留仍存活的已有 id，按创建顺序追加漏记的 live id，删除已关闭 id。
- insert：普通/AI tab 追加；page-open tab 若有 opener，插到 opener 右侧。
- remove：close/window close 时清理。

`getTerminalBrowserTabsForWindow()` 和 `getTerminalBrowserTabRecords()` 都必须按同一 order map 遍历，避免 UI 列表、IPC list 和磁盘顺序产生三个真相源。restore 使用持久化 `tabs[]` 顺序注册，因此无需数据迁移。

### 5.3 Renderer 失败恢复

Controller 在 drop 后：

1. 依据当前 `tabs` 计算 `orderedTabIds`。
2. 调用现有 Zustand action 乐观更新。
3. Electron 下 fire-and-forget 调用 reorder IPC；Web fallback 只保留内存顺序。
4. IPC reject 时调用现有 `syncElectronTabs()`，用主进程列表覆盖 Renderer，不能保留半成功顺序。

handler 使用 `useMemoizedFn`，不引入 `useCallback`。

## 6. 文件改动范围

### 新建

- `frontend/src/components/terminal/terminal-browser-tab-overview.tsx`
  - Overview Popover、搜索过滤、行级选择/关闭和无结果状态。
- `frontend/src/components/terminal/terminal-browser-tab-utils.ts`
  - `browserTabLabel`、group color/label、宽度 token 与纯宽度计算；供 tabs、overview、Electron snapshot model 共用。
- `docs/testing/terminal-browser-adaptive-tabs-test-cases.md`
  - 本计划的可追踪验收合约。

### 修改

- `frontend/src/components/terminal/terminal-browser-tabs.tsx`
  - 拆分固定 actions 与 scroll viewport；接入 ResizeObserver、宽度映射、density、active 入视、close freeze、keyboard 和 Overview。
- `frontend/src/components/terminal/terminal-browser-model.ts`
  - 将 `browserTabLabel` import 改到纯 utils；不改变 snapshot 字段。
- `frontend/src/components/terminal/terminal-browser-tool.tsx`
  - 接入 controller 提供的持久化 reorder handler；其它 props 不变。
- `frontend/src/components/terminal/use-terminal-browser-controller.ts`
  - 包装乐观 reorder + Electron IPC + reject resync。
- `frontend/src/e2e/terminal-browser-tabs-harness.tsx`
  - 改为有状态 harness，支持设置宽度、active、MCP/loading 和记录 select/close/create/reorder，供 `$playwright-cli` 取证。
- `electron/src/terminal-browser-view.ts`
  - window-scoped tab order、IPC validation、list/persistence/restore 同序。
- `electron/src/preload.ts`
  - 暴露 `terminalBrowserReorderTabs`。
- `frontend/src/App.tsx`
  - 补齐 `window.electronAPI` 类型。
- `docs/architecture/terminal-code-preview.md`
  - 将 adaptive tab 行为、Overview 和 Electron 顺序持久化写入当前事实。
- `docs/README.md`
  - 索引配套测试用例。
- `docs/prototypes/terminal-browser-adaptive-tabs/README.md`
  - 写入用户确认、计划路径和冻结时间。

### 明确不修改

- `frontend/src/components/ui/sortable-tabs.tsx`：当前 API 足够，宽度放在 Browser renderTab 最外层；避免影响项目/session tab。
- `frontend/src/features/terminal/preview-store.ts`：现有 close/select/reorder 状态语义足够，不新增 layout-only 全局状态。
- backend、`packages/shared`、App 和 CDP Proxy 文件。

## 7. 实施步骤

### 步骤 1：提取 tab 展示纯函数并建立真实宽度模型

- 新建 `terminal-browser-tab-utils.ts`，迁移 label/group helpers，加入 180/80/44/4 token 和按 viewport 计算 id→width 的纯函数。
- `terminal-browser-tabs.tsx` 用 ResizeObserver 获取 viewport `clientWidth`，按 id 设置最外层 tab 宽度。
- 将 New Tab 从滚动区域移到固定 actions；暂不加 Overview。

验证：

- `$playwright-cli` harness 检查 320/480/800 × 1/3/6/10/20 共 15 个组合。
- 每组断言 tab 数一致、无 sibling overlap、min/max 正确、actions 完整可见。

### 步骤 2：完成 density、Overview 和键盘导航

- 接入 loading、MCP full/dot、icon-only inactive、active close 和 inactive hover/focus close。
- 新建 Overview Popover，接入搜索/选择/关闭。
- 增加 roving tabindex 与 Left/Right/Home/End。

验证：

- 用 title/URL/group 三类 query 搜索；无结果、选择、关闭分别取 snapshot。
- 键盘操作后 active、focus 和 scroll position 同步。

### 步骤 3：完成 active 入视和连续关闭冻结

- 使用 viewport/slot refs 直接计算 scrollLeft。
- pointerdown 测量宽度；mouse leave 与 touch/pen timer 解冻。
- resize、replace、reorder 时清理过期冻结。

验证：

- 20 tabs 激活首/中/尾均完整可见。
- 800px + 6 tabs 连续关闭：剩余 tab 在 pointerleave 前保持原宽度，离开后才扩张。
- 320px resize 后无重叠、active 仍可见。

### 步骤 4：接通 Electron reorder 持久化

- 主进程建立唯一 window-scoped order source，并让 list/persistence/restore 共用。
- 添加 IPC/preload/type；controller 乐观更新并在 reject 时 resync。
- page-open tab 插到 opener 右侧，普通/AI tab 追加。

验证：

- 真实 Electron 拖拽 5 个合法 URL tab，确认 UI、`terminalBrowserListTabs()` 和 `terminal-browser-tabs.json` 顺序一致；重启后仍一致。
- 构造重复/缺失/跨窗口 id，IPC reject 且磁盘内容不变。
- 模拟 drop 与外部 close 竞态，Renderer 最终收敛到 Electron live list。

### 步骤 5：更新 harness 与活文档

- 扩展现有 E2E harness，不新增 unit/Vitest 文件。
- 更新 `terminal-code-preview.md`、测试索引和原型冻结记录。
- 保留原型作为历史决策资产，不把 helper 写入产品文档。

验证：文档描述与最终代码、IPC 名称、width token 和恢复限制一致；`git diff --check` 通过。

### 步骤 6：执行完整验收

严格按 `docs/testing/terminal-browser-adaptive-tabs-test-cases.md`：

1. 先跑 typecheck/lint/diff 门禁，任一失败即停。
2. 用 `$playwright-cli` 执行 React harness 与真实页面用例并保存 DOM/screenshot 证据。
3. 用 `$computer-use` 启动/重启 Electron、操作桌面窗口；页面级检查仍由 `$playwright-cli` 完成。
4. 失败时记录 case ID、实际宽度/scrollLeft/active id/ordered ids，不用静态阅读代替行为证据。

## 8. 验收标准

- [x] `docs/testing/terminal-browser-adaptive-tabs-test-cases.md` 全部必跑用例通过。
- [x] 15 个 width × tab-count 组合无 overlap，active 完整可见，fixed actions 不被滚走。
- [x] 三档 density、MCP/loading、Overview/Search、键盘、拖拽、新建、关闭均有真实浏览器证据。
- [x] mouse/touch 连续关闭冻结符合时序，且 resize/reorder 不保留过期宽度。
- [x] 真实 Electron 中 UI/list/persisted file/restart 四处顺序一致。
- [x] page-open 仍插在 opener 右侧；CDP create/close/activate 和 MCP activity 无回归。
- [x] `pnpm --filter ./frontend typecheck`、`pnpm --filter ./frontend lint`、`pnpm --filter ./electron typecheck`、`pnpm --filter ./electron lint`、`git diff --check` 全部通过。

## 9. 风险、兼容与回退

### 高风险点

- **关闭冻结引用过期 DOM**：宽度只按 tab id 保存；tabs replace/reorder/resize 立即清理，timer 在 unmount 清除。
- **DnD 与横向 scroll 冲突**：保留 8px activation distance，只有 viewport 滚动；验收同时覆盖拖动和滚动。
- **Renderer/Electron 顺序分叉**：主进程校验全排列并作为持久化权威；IPC 失败强制 list resync。
- **page-open 插入语义回退**：主进程和 Renderer 都按 opener 右侧插入，测试单独守护。
- **可访问性回退**：tab/close 必须是独立按钮；Overview 不嵌套 button；roving focus 和 Escape 返回焦点必须取证。

本改动不处理敏感数据、鉴权或公网接口，不存在数据删除迁移。持久化 schema 仍为 version 1；旧文件按数组原顺序恢复，回滚不需要转换文件。

### 回退方式

- UI 可整体回退到当前 76～220px scroll strip，Electron tab/session 不受影响。
- reorder IPC/order map 可独立移除；`terminal-browser-tabs.json` 仍是合法 version 1。
- 不删除或重写用户持久化文件，不用 `git reset --hard` 或磁盘清理作为回退手段。
