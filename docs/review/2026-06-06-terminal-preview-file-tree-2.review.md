# Terminal Preview 文件树评审

## 评审范围

- 本地未提交变更：终端 Preview 文件树、目录 API、共享协议、前端树组件、`react-complex-tree` 依赖与 lockfile。
- 评审模式：`review-only`，未修改被评审源码、配置、测试或产品文档。

## 架构 / 策略发现

### P1 - Explorer 被建成顶层 mode，破坏了“file mode 左栏 tab”的核心决策

- 当前决策：计划明确要求在 `file mode` 左栏新增 Explorer/Open tab，进入 file mode 默认 Explorer，并保持 Open tab 现有能力不回归；见 `docs/plans/2026-06-06-terminal-preview-file-tree.md:5`、`:12`、`:153`、`:161`-`:179`。
- 系统层面风险：实现把 `explorer` 加进 `TerminalPreviewMode`，并在顶层 Preview tasks 中和 `file`、`changes` 并列；见 `frontend/src/features/terminal/preview-store.ts:9`、`frontend/src/components/terminal/terminal-preview-panel-shell.tsx:247`-`:266`。这改变了用户心智和状态边界：Explorer 不再是 file mode 的左栏，而是另一个 mode。
- 具体行为风险：Explorer 中点击文件走共用 `openFilePath`，它会把 mode 强制写成 `"file"`；见 `frontend/src/components/terminal/terminal-preview-panel-actions.ts:99`-`:107`。因此用户从 Explorer 打开文件后树会消失，退回 Open 面板。与此同时，文件加载 effect 只在 `mode === "file"` 时运行；见 `frontend/src/components/terminal/use-terminal-preview-panel-data.ts:354`-`:366`，导致 `mode === "explorer"` 下右侧文件预览只能依赖旧状态。
- 更好的候选方案：
  - 推荐：回到计划设计，把 Explorer/Open 做成 `mode === "file"` 内部的左栏 tab，`fileExplorerTab` 只决定左栏内容；打开文件只更新 `selectedFilePath`，不离开 file mode。
  - 可选但不推荐：保留顶层 `explorer` mode，但必须让 `openFilePath` 能保留当前 mode，并把加载、保存、markdown/svg view controls、refresh、copy path 全部扩展到 explorer mode。这个方案会扩大模式分支和重复状态，不如左栏 tab 简单。
- 迁移/过渡风险：从当前实现迁回左栏 tab 需要收敛 `TerminalPreviewMode`、移动 Shell 顶层 tab、让 `TerminalPreviewPanelContent` 在 file mode 内按 `fileExplorerTab` 条件渲染。风险主要是 UI 状态回归，建议以 E2E 覆盖 Explorer/Open 切换和打开文件。

### P2 - lockfile 被大面积重写，真实依赖变更被格式噪声淹没

- 当前决策：新增 `react-complex-tree` 依赖；`frontend/package.json:44` 增加一行，`pnpm-lock.yaml:232`-`:234` 增加对应依赖。但 `git diff --numstat -- pnpm-lock.yaml` 显示 `4333` 行新增、`8155` 行删除，且文件从双引号/展开对象整体变为单引号/紧凑对象格式；见 `pnpm-lock.yaml:1`-`:8`。
- 系统层面风险：这会让评审、冲突处理、依赖审计和后续 cherry-pick 都变差。实际只需要审 `react-complex-tree`，但 lockfile 噪声让团队无法快速确认是否夹带了解析器版本或 peer 依赖变化。
- 更好的候选方案：
  - 推荐：用仓库期望的 pnpm 版本重新生成 lockfile，确保 diff 只包含新包及其必要 transitive 条目。
  - 可选：如果树能力第一阶段只需要懒加载、展开/折叠和单击打开，可用现有 React + lucide + button/list 结构做最小 disclosure tree，暂不引入第三方树库；交付更快、依赖风险更低，但要自己承担键盘/ARIA 完整性。
- 迁移/过渡风险：重生成 lockfile 需要确认 pnpm 版本一致；如果改为自建树，需要删除新依赖并用 E2E 覆盖键盘导航，否则会牺牲计划里对可访问性的诉求。

## 代码 / 实现发现

### P1 - `pnpm typecheck` 当前失败，新增 Explorer SVG 分支传错 prop

- 为什么是风险：工作区类型检查无法通过，变更不能进入质量门禁。
- 证据：`TerminalSvgPreview` 只接受 `content` prop，见 `frontend/src/components/terminal/terminal-svg-preview.tsx:4`-`:8`；新增 Explorer 分支传入的是 `svgContent`，见 `frontend/src/components/terminal/terminal-preview-panel-content.tsx:277`-`:292`。
- 命令验证：`pnpm typecheck` 失败，报错为 `terminal-preview-panel-content.tsx(291,33): Property 'svgContent' does not exist on type 'TerminalSvgPreviewProps'. Did you mean 'content'?`
- 修复方向：把 Explorer 分支和既有 file 分支统一，传 `content={editorContent}`；同时减少两段几乎相同的 file preview 渲染逻辑，避免同类错漏再次出现。

### P2 - rename/delete 后树缓存不会刷新，已加载目录会显示陈旧文件

- 为什么是风险：计划要求 rename/delete 成功后刷新父目录；见 `docs/plans/2026-06-06-terminal-preview-file-tree.md:197`-`:200`、`:266`-`:270`。当前树 hook 暴露了 `invalidateDirectory`，但没有任何调用方；见 `frontend/src/components/terminal/use-terminal-file-tree.ts:236`-`:270` 和 `rg invalidateDirectory` 结果。
- 证据：rename 成功后只刷新 Open 搜索和 changes，见 `frontend/src/components/terminal/terminal-preview-panel.tsx:207`-`:217`；delete 成功后同样只刷新搜索和 changes，见 `frontend/src/components/terminal/terminal-preview-panel.tsx:291`-`:304`。
- 修复方向：把树缓存状态提升到 `TerminalPreviewPanel` 或 store，rename/delete 后按旧路径和新路径的父目录调用 invalidation；或者在 Explorer 可见时清空并重新加载 root。前者体验好，后者实现简单但会丢展开状态。

### P2 - 截断目录信息从后端返回后没有任何前端呈现

- 为什么是风险：后端 limit 默认 500、最大 1000，超过会返回 `truncated: true`；见 `backend/src/terminal/preview-directory.ts:112`-`:123` 和 `packages/shared/src/terminal-protocol.ts:63`-`:71`。前端没有消费 `truncated`，用户会误以为目录完整，可能打不开排在 limit 后面的文件。
- 证据：`rg truncated frontend/src/components/terminal frontend/src/features/terminal` 无命中。
- 修复方向：在 `mergeDirectoryResponse` 时为被截断目录记录元信息，并在树底部或目录尾部显示 `Only first N entries shown.`；或者先把 default limit 提高并明确不可完整浏览，但这仍然需要 UI 提示。

### P3 - `fileExplorerTab` 状态已接入但没有被实际使用

- 为什么是风险：状态和 props 已存在，但 UI 没有 tab bar，后续维护者会以为 Explorer/Open sub-tab 已完成，实际没有。
- 证据：`fileExplorerTab` 在 store 和 data hook 中存在，见 `frontend/src/features/terminal/preview-store.ts:14`、`:52`、`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:79`；传到 content 后只被解构，没有渲染分支，见 `frontend/src/components/terminal/terminal-preview-panel-content.tsx:133`、`:167`。`onFileExplorerTabChange` 同样只传递不消费，见 `frontend/src/components/terminal/terminal-preview-panel.tsx:466`-`:470`。
- 修复方向：按计划在 file mode 左栏顶部真正渲染 Explorer/Open tab；如果决定保留顶层 Explorer mode，则删除 `fileExplorerTab` 及相关 props，避免死状态。

### P3 - 目录 loading 状态没有接入，承诺的 spinner 不会显示

- 为什么是风险：计划要求目录加载中箭头替换为 spinner；见 `docs/plans/2026-06-06-terminal-preview-file-tree.md:187`-`:193`。当前 `loadingDirs` 是一个从未更新的 `Set`，`isLoading` 永远为 false。
- 证据：`TerminalFileTree` 创建 `loadingDirs` 但没有 setter，也没有在展开/loadDirectory 前后写入，见 `frontend/src/components/terminal/terminal-file-tree.tsx:39`-`:71`；`TerminalFileTreeItem` 只读取该 Set，见 `frontend/src/components/terminal/terminal-file-tree-item.tsx:33`-`:37`。
- 修复方向：把 loadingDirs 放到 `useTerminalFileTree`，在 `loadDirectory` 的 inflight 生命周期里更新；或删除未实现的 spinner 逻辑，避免虚假状态。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：失败，失败点为新增 Explorer SVG 分支 prop 名错误。

## 剩余风险 / 测试缺口

- 未运行 lint 和 E2E，因为 typecheck 已经失败。
- 目录 API 没有看到针对越界、符号链接、limit/truncated、敏感文件过滤的后端测试证据；若保留该 API，建议至少补路由级验证或 E2E 场景。
- 前端按项目路径变化清空树、从 Open 打开后 reveal、rename/delete 后刷新父目录这三项验收标准尚未从当前代码中闭环。
