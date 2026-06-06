# Terminal Preview 文件树计划复审

评审对象：`docs/plans/2026-06-06-terminal-preview-file-tree.md`

评审模式：强力模式。该方案涉及前后端、共享协议、新 HTTP API、新前端依赖、文件系统枚举、路径安全与 E2E 覆盖。

复审说明：已重新读取当前计划文本和当前实现。当前计划仍保留目录搜索从文件候选派生、空搜索显示 tree、tree cache 放在新 hook 内等关键决策，因此部分上轮风险仍成立。

## 架构 / 策略发现

### P1 目录搜索仍建立在文件候选集上，不能满足目录搜索目标

- 当前决策：任务 2 仍要求“从文件候选路径派生目录候选集”，再把目录和文件统一 fuzzy scoring。
- 为什么它在系统层面可能是错的：文件候选集不是目录索引。由文件路径反推目录会漏掉空目录，也会漏掉只包含被过滤文件、被 gitignore 文件或尚未进入文件候选缓存的目录。用户目标是“搜索文件名/文件路径和目录路径”，验收标准也是“目录名搜索可定位并展开目录”；这需要目录实体本身作为候选，而不是文件搜索的副产物。
- 具体证据：
  - 计划目标要求目录路径搜索：`docs/plans/2026-06-06-terminal-preview-file-tree.md:7-10`
  - 计划任务 2 明确从文件候选派生目录候选：`docs/plans/2026-06-06-terminal-preview-file-tree.md:276-286`
  - 现有 fallback 收集器遇到目录只入栈，不把目录加入结果：`backend/src/terminal/preview-search-candidates.ts:206-240`
  - 现有 `rg --files` 归一化后也是文件列表：`backend/src/terminal/preview-search-candidates.ts:247-320`
  - 现有搜索只对 `collectCachedSearchCandidateFiles(...)` 返回路径做 `rankFile(...)`：`backend/src/terminal/preview-search.ts:214-223`
- 更好的候选方案：
  - 推荐方案：新增 bounded directory candidate source，例如 `collectCachedSearchCandidateEntries` 返回 `{ kind, path }`，目录候选由受限 BFS 或 `fd --type d` + Node fallback 产生，复用同一套 exclude predicate。
  - 更简单方案：第一阶段删除目录名搜索目标，只做树浏览 + 文件名搜索，把目录搜索作为第二阶段单独设计。
  - 使用现有工具链方案：保留当前 `rg --files` 做文件候选，同时新增可选 `fd` 目录候选；未安装 `fd` 时走 Node BFS fallback。
- 迁移/过渡风险说明：目录候选会增加缓存和过滤规则维护成本；但它能把“目录搜索”从“文件搜索副产物”里拆出来，避免后续出现大量边界补丁。

### P2 tree cache owner 仍不清晰，rename/delete 后状态一致性没有可靠契约

- 当前决策：计划把 `items map`、viewState、懒加载逻辑放入 `use-terminal-file-tree.ts`，同时让 `use-terminal-preview-panel-data.ts` 接入 directory service，并要求 rename/delete 后清除父目录 cache。
- 为什么它在系统层面可能是错的：当前 rename/delete 成功路径在 `TerminalPreviewPanel` 中完成，成功后只更新右侧文件预览、store selected path、文件搜索和 changes。计划没有定义 mutation handler 如何触达 `use-terminal-file-tree.ts` 内部的 items map，也没有定义事件或版本号契约。实施者很容易把失效逻辑分散在两个 hook 里，导致右侧文件已重命名/删除，左侧树还显示旧节点。
- 具体证据：
  - 计划组件结构把 items map 放在 `use-terminal-file-tree.ts`：`docs/plans/2026-06-06-terminal-preview-file-tree.md:177-190`
  - 计划缓存章节要求 rename/delete 清父目录 children：`docs/plans/2026-06-06-terminal-preview-file-tree.md:226-233`
  - 任务 4 同时点名 `use-terminal-file-tree.ts` 和 `use-terminal-preview-panel-data.ts`，但没有定义通信契约：`docs/plans/2026-06-06-terminal-preview-file-tree.md:321-335`
  - 当前 rename 成功只更新 preview/file search/changes：`frontend/src/components/terminal/terminal-preview-panel.tsx:180-216`
  - 当前 delete 成功只清空右侧选择并刷新 search/changes：`frontend/src/components/terminal/terminal-preview-panel.tsx:262-306`
  - 当前 store 还没有 tree state owner：`frontend/src/features/terminal/preview-store.ts:40-51`
- 更好的候选方案：
  - 推荐方案：让 `TerminalFileExplorer` 成为 tree cache owner，并暴露明确的 `invalidateExplorerPaths({ oldPath, nextPath })` 或 `treeVersion` contract 给 mutation flow。
  - 更简单方案：rename/delete 成功后 bump `treeVersion`，重新加载 root 和已展开路径；先牺牲局部缓存，保证状态正确。
  - 使用现有平台/工具链方案：暂不引入 watcher/file event bus，只复用现有 mutation 成功回调；未来如果做完整 IDE 能力，再考虑文件系统事件。
- 迁移/过渡风险说明：提升 owner 会增加一层 props/callback；整树 reload 会多发请求，但第一版的正确性收益更高。

### P2 空搜索态仍会替换掉现有 changed files 入口

- 当前决策：计划规定搜索框为空时显示 tree，搜索框非空时显示搜索结果列表。
- 为什么它在系统层面可能是错的：现有 file mode 空查询不是空白状态，而是 changed files 快速入口。计划在“当前代码事实”里识别了这一点，但后续设计和验收没有把 changed files 迁移到 tree 或新 UI。实施后会删除一个现有工作流：进入 Files 后直接打开已修改文件。
- 具体证据：
  - 计划确认当前左栏负责 changed files 空查询展示：`docs/plans/2026-06-06-terminal-preview-file-tree.md:21-29`
  - 计划搜索集成规定空搜索显示 tree：`docs/plans/2026-06-06-terminal-preview-file-tree.md:88-93`
  - 当前 `TerminalOpenFileCommand` 空 query 显示 `Changed files` / `Loading changes`：`frontend/src/components/terminal/terminal-open-file-command.tsx:64-90`
  - 当前 file mode 入口直接挂载 `TerminalOpenFileCommand`：`frontend/src/components/terminal/terminal-preview-panel-content.tsx:304-319`
- 更好的候选方案：
  - 推荐方案：tree 上方保留 compact changed files section，或在 tree 根部插入虚拟 `Changed Files` group。
  - 更简单方案：左栏做 `Explorer` / `Changes` 两个 tab，先保留旧列表行为，tree 作为新增视图。
  - 使用现有工具链方案：继续复用现有 `getPreviewGitChanges` / empty search 逻辑，不新增后端能力。
- 迁移/过渡风险说明：虚拟 changed files 节点需要处理与真实路径节点的 key 冲突；tab 方案最保守，但多一个切换控件。

### P3 第三方树依赖可以接受，但计划仍缺少最小替代方案对比

- 当前决策：直接采用 `react-complex-tree`。
- 为什么它在系统层面可能是错的：第一版明确不做拖拽、移动、复制、新建和前端单测，实际需要的是 lazy expand、select/open、基础键盘导航。`react-complex-tree` 可以解决 ARIA/键盘问题，但也引入未使用能力和长期迁移风险；计划目前没有量化“用现有组件自建最小树”与引包的成本差。
- 具体证据：
  - 计划固定选择 `react-complex-tree`：`docs/plans/2026-06-06-terminal-preview-file-tree.md:12-19`
  - 计划非目标排除多个高级文件树能力：`docs/plans/2026-06-06-terminal-preview-file-tree.md:235-241`
  - 前端已有 `cmdk`、Radix、dnd-kit、lucide、zustand：`frontend/package.json:15-51`
  - 当前 npm 元数据：`react-complex-tree` 版本 `2.6.1`，`time.modified` 为 `2025-10-08T00:11:53.590Z`，peer dependency 为 `react >=16.0.0`。
- 更好的候选方案：
  - 推荐方案：实施前补一个 0.5 天 spike，对比 `react-complex-tree`、Headless Tree 和自建最小 lazy tree 的 bundle、API、键盘行为、代码量。
  - 更简单方案：第一版自建无拖拽树，只实现 expand/open/select 和必要 ARIA；真实用户需要更多键盘能力后再引包。
  - 使用平台/工具链方案：优先复用项目现有 UI primitives，不引入新的树库，减少依赖生命周期风险。
- 迁移/过渡风险说明：自建方案可能欠缺完整 ARIA；直接引包可能后续被 successor library 或 API 迁移牵制。

## 代码 / 实现发现

### P1 根目录空 path 与现有路径解析函数冲突，目录 API 需要明确共享安全 resolver

- 为什么这是风险：计划要求 directory API 的 `path` 可省略或为空表示项目根目录；但现有 `resolvePreviewPath(...)` 对空字符串直接抛 400。如果实现者为了 root listing 另写一套路径解析，很容易漏掉 realpath、`~` 拒绝、项目边界校验和 symlink 处理；如果直接复用现有函数，根目录 listing 又不可用。
- 具体文件 + 行号：
  - 计划规定空 path 表示根目录：`docs/plans/2026-06-06-terminal-preview-file-tree.md:140-158`
  - 现有 `resolvePreviewPath(...)` 空字符串抛 400：`backend/src/terminal/preview-paths.ts:51-67`
  - 同一函数负责 realpath 和 project 内边界校验：`backend/src/terminal/preview-paths.ts:69-100`
- 可执行修复方向：计划里明确新增 `resolvePreviewDirectoryPath(projectPath, requestedPath?: string)`：空 path 走 `realpath(projectPath)`，非空 path 复用同一套 project-boundary 检查；测试覆盖空 path、`..`、绝对路径、`~`、symlink、文件 path、缺失目录。

### P2 目录 API 验证仍缺少专用后端单测

- 为什么这是风险：新增目录枚举 API 的核心风险不在 typecheck，而在安全路径、过滤、排序、limit/truncated、single-level only 和错误语义。计划任务 1 只列 route 测试和 typecheck，没有要求 `preview-directory.test.ts`；E2E 也无法覆盖足够多的路径安全边界。
- 具体文件 + 行号：
  - 任务 1 验证只列 `terminal.test.ts`、backend typecheck、shared typecheck：`docs/plans/2026-06-06-terminal-preview-file-tree.md:255-274`
  - 当前已有 preview read/search/mutate 专用测试，但没有 directory 专用测试：`backend/src/terminal/preview-file-search.test.ts:37-256`
  - 当前 route 搜索测试覆盖的是 `/preview/files/search`：`backend/src/routes/terminal.test.ts:1923-1988`
- 可执行修复方向：计划中加入 `backend/src/terminal/preview-directory.test.ts`，覆盖 root listing、只返回一层、过滤规则、排序、limit/truncated、文件 path 400、缺失目录 404、缺 project path 409、越界 403、`~` 400、symlink 边界；route 层再补 1-2 个 contract 用例。

### P2 复用 `TerminalOpenFileCommand` 时目录结果会继承文件 Rename/Delete 行为

- 为什么这是风险：计划只给搜索 item 增加可选 `entryKind`，并要求复用现有 `TerminalOpenFileCommand` 列表 UI。当前该组件对所有 item 都展示 Rename/Delete 菜单，回调也是文件 rename/delete。目录命中项如果直接复用，会出现错误操作入口，触发后端目录拒绝或误导用户。
- 具体文件 + 行号：
  - 计划要求复用现有列表 UI：`docs/plans/2026-06-06-terminal-preview-file-tree.md:88-93`
  - 计划只新增可选 `entryKind`：`docs/plans/2026-06-06-terminal-preview-file-tree.md:126-137`
  - 当前每个搜索 item 都挂 Rename/Delete：`frontend/src/components/terminal/terminal-open-file-command.tsx:127-141`
  - 当前后端文件 mutation 只接受 regular file，目录会被拒绝：`backend/src/terminal/preview.ts:195-210`
- 可执行修复方向：不要直接复用 `TerminalOpenFileCommand` 作为目录搜索结果列表；拆出 `TerminalFileSearchResults` 或给结果项按 `entryKind` 分支。目录项只支持展开/选中，不显示 Rename/Delete；文件项才保留现有菜单。

## 剩余风险 / 测试缺口

- 需要 Playwright 覆盖：展开目录只请求当前目录一层、目录搜索结果展开路径、changed files 入口仍可用、目录项不出现文件操作菜单。
- 需要验证 `react-complex-tree` 与 React 19、Vite lazy import、项目 Tailwind 样式的实际兼容性。
- 需要明确过滤规则抽取后的 public helper 边界，避免 search candidate 与 directory listing 两套规则继续漂移。

## 推荐结论

不建议按当前计划直接实现。至少先修订以下内容：

1. 目录搜索不能从文件候选集派生，或第一版明确删除目录搜索目标。
2. 明确 tree cache owner，以及 rename/delete/save/refresh 后的失效 contract。
3. 保留或迁移 changed files 空搜索入口。
4. 为 directory API 增加专用后端测试与路径 resolver 设计。

本次复审未发现需要修改源码；只建议继续修订计划。
