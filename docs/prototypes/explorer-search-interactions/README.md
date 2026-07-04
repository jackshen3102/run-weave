# Explorer 快捷浮层搜索原型

面向 Runweave Terminal 右侧 `Preview > Explorer` 的可运行 HTML 交互原型。当前版本只保留 `Cmd+P / Cmd+Shift+F` 风格快捷浮层，不再展示其它方案。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/explorer-search-interactions
```

打开：

```text
http://127.0.0.1:6188/
```

原型会在每次页面加载时给 `app.js` 和 `mock-state.json` 自动追加版本号，普通刷新会绕开旧静态资源缓存。

## 文件

- `index.html`：静态页面壳层、项目一致的 slate 侧栏样式和挂载点。
- `app.js`：快捷浮层状态流转、模式切换、键盘事件和结果选择。
- `mock-state.json`：模拟项目、Explorer 树、文件搜索结果、内容搜索结果和文件预览。
- `prototype-preview.png`：浏览器验证后保存的页面截图。

## 原型简报

- 目标：把 Explorer 搜索收敛为一个贴近当前 Runweave Preview 侧栏、但在整个页面居中呼出的快捷浮层，而不是独立设计稿。
- 用户动作：打开快捷搜索、输入查询、在 Files / Content / Folders 之间切换、点击结果、使用 `Cmd+P` / `Cmd+Shift+F` / `Esc`。
- 主要用户：在 Runweave 终端项目中频繁定位文件、目录和内容的开发者。
- 影响的产品界面或模块：`TerminalPreviewPanelShell`、`TerminalFileExplorer`、`TerminalOpenFileCommand`、`TerminalPreviewFileView`、`useTerminalPreviewPanelData`。
- 关键流程：当前项目打开 Explorer -> 用户呼出快捷浮层 -> 默认文件搜索 -> 可切到内容或目录搜索 -> 选择结果后关闭浮层并更新选中文件。
- 重要状态：浮层打开/关闭、搜索模式、查询值、选中路径、无结果、内容搜索行号、快捷键提示。
- 非目标：不连接真实后端 API，不证明内容搜索协议、`rg --json`、目录搜索或取消任务已经存在。

## 当前代码依据

- `frontend/src/components/terminal/terminal-preview-panel-shell.tsx`：侧栏背景、工具 tab、Preview mode tab、header 行为来源。
- `frontend/src/components/terminal/terminal-file-tree-item.tsx`：Explorer 树行高、选中态、聚焦态、缩进和图标密度来源。
- `frontend/src/components/terminal/terminal-open-file-command.tsx`：当前 `Open` 模式已经使用 `cmdk`，快捷浮层结果行复用这个心智。
- `frontend/src/components/terminal/terminal-preview-file-view.tsx`：Explorer 左侧 240px + 文件预览区域的布局来源。

## 验证点

- 首屏只展示快捷浮层方案，不再出现其它方案入口。
- UI 看起来像当前 Runweave Preview 侧栏，而不是独立产品页。
- `Cmd+P` 打开 Files 模式。
- `Cmd+Shift+F` 打开 Content 模式。
- `Esc` 关闭浮层。
- 点击结果后浮层关闭，Explorer 只展开并选中目标路径，不保留搜索高亮样式。
- 三种搜索模式共用同一套结果行样式，只通过左侧图标、内容密度和右侧 badge 区分：Files 显示 file + Git 状态，Content 显示 text + line:column + 命中片段，Folders 显示 folder + DIR。
- 修改 `app.js` 或 `mock-state.json` 后，普通刷新能看到最新内容。

## 功能分类

### 产品核心功能

| 元素 / 行为                    | 最终产品是否需要 | 产品价值                               | 备注                             |
| ------------------------------ | ---------------- | -------------------------------------- | -------------------------------- |
| 快捷浮层入口                   | 是               | 不离开 Explorer 就能快速定位文件和内容 | 入口可来自按钮和快捷键           |
| Files / Content / Folders 模式 | 是               | 覆盖文件、内容、目录三个主搜索意图     | 内容/目录后端能力需实现          |
| cmdk 风格结果列表              | 是               | 复用当前 `Open` 面板心智               | 产品实现应优先复用或扩展现有组件 |
| 点击结果打开文件               | 是               | 搜索到预览闭环                         | 内容结果需要携带行列信息         |
| Esc 关闭、快捷键打开           | 是               | 符合 command palette 使用习惯          | 需避免与终端输入快捷键冲突       |

### 原型辅助功能

| 元素 / 行为      | 辅助验证什么              | 为什么不进入产品                      | 备注     |
| ---------------- | ------------------------- | ------------------------------------- | -------- |
| 模拟终端区域     | 帮助观察 Preview 侧栏比例 | 产品中已有真实 terminal surface       | 原型专用 |
| 模拟文件预览内容 | 展示选择结果后的视觉闭环  | 真实内容由 preview API 和 Monaco 渲染 | 原型专用 |
| Mock 搜索结果    | 演示交互状态              | 真实结果来自后端搜索接口              | 原型专用 |

## 调整记录

| 轮次 | 调整内容                                                      | 原因                                                      | 结果                                                       |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | 创建 6 种 Explorer 搜索交互原型                               | 用户要求每一种方案都出一个原型                            | 已废弃多方案对比                                           |
| 2    | 将快捷浮层设为默认方案，并强化为 VS Code command palette 风格 | 用户反馈喜欢 `Cmd+P / Cmd+Shift+F` 风格                   | 快捷浮层成为收敛方向                                       |
| 3    | 为 `app.js` 和 `mock-state.json` 增加自动 cache buster        | 刷新页面时可能仍看到旧原型代码                            | 每次页面加载都会请求带时间戳的资源                         |
| 4    | 移除其它方案，只保留快捷浮层，并按当前项目组件和样式重做 UI   | 用户要求不能脱离当前项目实现和约束                        | 原型对齐 Preview sidecar、Explorer tree、Open command 现状 |
| 5    | 将快捷浮层从右侧面板内居中改为整个页面居中                    | 用户确认搜索弹窗应是页面级浮层                            | 浮层改为 fixed 全页面覆盖，仍由 Explorer 入口触发          |
| 6    | 去掉确认搜索后的 Explorer 命中高亮                            | 搜索确认后应回到真实文件树 reveal/select 样式             | 搜索高亮只保留在浮层结果里                                 |
| 7    | 统一三种模式的结果行样式，并用图标、内容密度、badge 区分类型  | 用户确认 Files / Content / Folders 不需要三套完全不同样式 | Files、Content、Folders 保持同一 row 结构                  |

## 冻结记录

- 最终采用的交互：倾向快捷浮层，尚未冻结。
- 放弃的方向：双入口、前缀命令、内联过滤、虚拟目录、终端命令桥已从当前原型移除。
- 产品核心功能清单是否已确认：未确认。
- 原型辅助功能清单是否已确认：未确认。
- 最终截图：`prototype-preview.png`
- 冻结时间：未冻结。

## 边界

- 这个原型不连接真实后端 API。
- 这个原型不导入生产源码。
- 这个原型不能证明产品协议、存储、索引、`rg`/`fd` 或运行时支持已经存在。
- 原型代码不能直接照搬进生产代码；产品实现必须回到当前 React/Tailwind/cmdk 组件。
- 原型辅助功能默认不进入实施计划，除非在冻结记录中明确转为产品需求。

## 实施计划衔接

- 原型表达的产品行为：Explorer 下可以用快捷浮层完成文件、目录和内容搜索，选择结果后定位到文件预览。
- 需要进入产品实现的核心功能：快捷键入口、浮层 UI、模式切换、结果列表、选择结果、加载/空态、行列信息。
- 不进入产品实现的原型辅助功能：模拟终端区域、模拟文件内容、mock 结果。
- 需要检查的现有代码：`TerminalOpenFileCommand` 是否能抽出为浮层复用，`useTerminalPreviewPanelData` 是否能承载 content/folder search state。
- 可能涉及的协议或数据结构：内容搜索结果、目录搜索结果、match ranges、line/column、搜索状态、取消旧搜索。
- 可能涉及的前端落点：Preview sidecar shell、Explorer body、Open command component、preview store。
- 可能涉及的后端或运行时落点：`preview-search.ts`、`preview-search-candidates.ts`、新增内容搜索 API 或任务式搜索。
- 验收方式：Playwright 打开原型和产品页面，验证快捷键、输入、模式切换、结果点击、关闭与空态。
