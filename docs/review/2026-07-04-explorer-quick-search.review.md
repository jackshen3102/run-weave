# Explorer 快捷浮层搜索计划评审

评审对象：`docs/plans/2026-07-04-explorer-quick-search.md`

结论：计划方向成立，但不建议直接进入实现。需要先补齐两个选择行为契约，否则实现很容易通过 API 和 UI 片段验证，却无法满足“搜索后回到真实 Explorer reveal/select 状态”的核心目标。

## 发现

- **P1 搜索结果选择缺少强制进入 Explorer 的动作契约**：计划要求快捷键打开搜索后，选择文件或内容结果要回到 Explorer 并展开/选中文件（计划 `docs/plans/2026-07-04-explorer-quick-search.md:132`、`docs/plans/2026-07-04-explorer-quick-search.md:320`、`docs/plans/2026-07-04-explorer-quick-search.md:344`）。但当前 `openFilePath` 会根据当前 mode 决定目标 mode，只有本来就在 `explorer` 时才保持 Explorer，否则进入 `file`（`frontend/src/components/terminal/terminal-preview-panel-actions.ts:119`）。而 Explorer 的 `revealFile` 是 Explorer 组件挂载后根据 `selectedFilePath` 触发的（`frontend/src/components/terminal/terminal-file-explorer.tsx:43`），当前 store 的 `openFile` 只是写入 `mode/selectedFilePath/path`（`frontend/src/features/terminal/preview-store.ts:251`）。如果浮层从 Changes/File 或快捷键入口打开，按计划“复用 openFilePath”会打开文件但不会回到 Explorer 树定位，直接违背验收 7/8。修复方向：计划中新增专用选择动作，例如 `openQuickSearchFileResult(path, lineTarget?)`，明确先 `confirmDiscardDraft()`，再 `openFile(projectId, path, "explorer")`，必要时调用/等待 `fileTree.revealFile(path)`，并覆盖从 Changes、Files、Explorer 三种当前 mode 选择结果的 E2E。

- **P1 文件夹结果没有定义与现有 file-only preview state 的隔离方式**：计划要求文件夹结果只展开并聚焦目录，不打开右侧文件预览（计划 `docs/plans/2026-07-04-explorer-quick-search.md:141`、`docs/plans/2026-07-04-explorer-quick-search.md:346`）。当前选中路径语义主要是文件路径：header/copy path 从 `selectedFilePath` 或 file preview 取值（`frontend/src/components/terminal/terminal-preview-panel-paths.ts:24`），`mode === "explorer"` 且有 `selectedFilePath` 时会触发文件读取（`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:374`），后端读取目录会返回 `Directories are not supported`（`backend/src/terminal/preview.ts:104`）。如果实现者把目录路径写入 `selectedFilePath`，会把右侧预览切成错误态；如果只改 tree 本地状态，又没有计划说明 header/copy/持久化是否变化，行为会不一致。修复方向：计划应明确目录搜索结果只写 tree-local `focusedItem/selectedItems/expandedItems`，不写 `selectedFilePath/path`，右侧保留当前文件预览或空态；如果需要在 header 展示目录，新增独立 `focusedDirectoryPath`，不要复用 file preview state。

- **P2 “Explorer 头部现有 Search 按钮”是假设，不是当前事实**：计划把入口写成“Explorer 头部现有 `Search` 按钮触发快捷浮层”（计划 `docs/plans/2026-07-04-explorer-quick-search.md:90`）。当前 Preview shell 只有任务 tab、项目名和保存状态（`frontend/src/components/terminal/terminal-preview-panel-shell.tsx:260`），Explorer 树组件没有头部入口，且 `react-complex-tree` 内置搜索被显式关闭（`frontend/src/components/terminal/terminal-file-tree.tsx:81`）。修复方向：计划需要明确新增按钮的真实位置与所属组件，例如在 `TerminalPreviewFileView` 的 Explorer sidebar 顶部加一个原生 icon button，或在 Preview task bar 右侧加按钮；同时补充 aria-label 和 Playwright 定位方式，避免实现时临时塞到不一致的 header 区域。

- **P2 内容搜索的安全验收需要从“一个敏感文件样例”扩成后端边界矩阵**：计划要求不改变敏感文件排除策略，并让内容搜索复用 `EXCLUDED_DIRECTORIES`、敏感 glob（计划 `docs/plans/2026-07-04-explorer-quick-search.md:15`、`docs/plans/2026-07-04-explorer-quick-search.md:211`、`docs/plans/2026-07-04-explorer-quick-search.md:384`）。当前文件搜索不仅给 `rg --files` 加 glob，还会对结果做后置过滤，包含 `.env.*.local`、大小写归一的 `secret`、目录段过滤（`backend/src/terminal/preview-search-candidates.ts:274`）。内容搜索如果只拼 `rg -g` 参数，容易漏掉大小写、不同 `.env` 变体或 fallback 行为。修复方向：计划里把 `buildRgSearchExclusionArgs` 与 `shouldIncludeSearchCandidate` 作为同一个后端 helper 明确列入实现，直接 API 验证至少覆盖 `.env.local`、`.env.production.local`、`SECRET.txt`、`node_modules/`、`dist/`、安全模板 `.env.example` 的预期行为。

## 更简单的替代方向

可以把首期拆成两个阶段：第一阶段只做页面级 Files/Folders 快捷浮层，完全复用现有文件候选缓存和 Explorer reveal，不引入 `rg --json` 内容搜索与 Monaco 行列定位；第二阶段再加 Content 搜索。这样能先交付“同一入口搜索文件/文件夹并回到 Explorer 树”的核心体验，风险主要集中在前端状态契约和 tree reveal，避免同时引入内容搜索性能、敏感内容泄露和 Monaco 异步定位三类风险。

如果坚持三模式一次性交付，至少先把上面的 P1 契约写进计划，再让实现按这些验收闭环。

## 检查范围

- 已阅读计划全文。
- 已核对当前 Preview/Explorer/Open file/Monaco/后端 preview 搜索与目录读取实现。
- 已执行只读命令：`git status --short`、`rg`、`nl -ba ... | sed ...`。
- 未执行浏览器验收；本次是计划评审，尚未进入实现或 E2E 阶段。
