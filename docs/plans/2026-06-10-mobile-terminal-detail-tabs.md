# Mobile Terminal Detail Tabs 实施计划

日期：2026-06-10

## 目标

在 App 端终端详情页增加底部 `Chat / Changes / Files` 三个 tabs，把 Web 端已有的 project preview 能力收敛成移动端只读入口：

- `Chat`：保持现有终端输出、命令输入、图片输入和 Stop 行为。
- `Changes`：查看当前 project 的 git changes 列表和单文件 diff。
- `Files`：搜索、浏览、只读预览当前 project 文件。

本期不做任何超出 Web 版本的移动端专属能力。尤其不做从 `Changes` 或 `Files` 直接发起对话、解释变更、请求修复、生成 prompt、行级评论等额外功能。

最终布局：

```text
Header
Active tab content
Chat composer (only when Chat tab is active)
Bottom tabs
```

`Bottom tabs` 始终是页面最底部导航。`Chat` tab 的 composer 保持在 bottom tabs 上方；`Changes` 和 `Files` 不显示额外 composer。

参考草图：

- `docs/plans/assets/mobile-terminal-tabs-overview-sketch-revised.png`
- `docs/plans/assets/mobile-terminal-tabs-changes-files-sketch-revised.png`

## 当前代码事实

- App 终端详情页由 `app/src/pages/AppTerminalPage.tsx` 负责，当前结构是 header、terminal body、`TerminalCommandComposer`。
- 当前 CSS 在 `app/src/main.css` 中用 `.terminal-page-shell { grid-template-rows: auto minmax(0, 1fr) auto; }` 固定三行，需要扩展为 header、content、composer、tabs。
- `TerminalCommandComposer` 位于 `app/src/components/TerminalCommandComposer.tsx`，已经覆盖命令输入、图片输入和 Stop。
- App 终端连接由 `app/src/hooks/use-app-terminal-connection.ts` 负责。它已经通过 `getTerminalSession()` 获取 `TerminalSessionStatusResponse`，但当前暴露给页面的 `metadata` 不包含 `projectId`。
- App service `app/src/services/terminal.ts` 当前只封装 mobile overview、session、state、ws-ticket、input、interrupt、clipboard-image；尚未封装 preview files/changes API。
- 后端已有可复用 preview API，不需要新增后端接口：
  - `GET /api/terminal/project/:id/preview/git-changes`
  - `GET /api/terminal/project/:id/preview/file-diff?path=&kind=`
  - `GET /api/terminal/project/:id/preview/directory?path=&limit=`
  - `GET /api/terminal/project/:id/preview/files/search?q=&limit=`
  - `GET /api/terminal/project/:id/preview/file?path=`
  - `GET /api/terminal/project/:id/preview/asset?path=`
- 共享协议 `packages/shared/src/terminal-protocol.ts` 已有 `TerminalPreviewGitChangesResponse`、`TerminalPreviewFileDiffResponse`、`TerminalPreviewDirectoryResponse`、`TerminalPreviewFileResponse` 等类型。
- Web 侧 preview 是桌面 sidecar：`frontend/src/components/terminal/terminal-preview-panel-content.tsx`、`terminal-preview-change-tree.tsx`、`terminal-preview-file-view.tsx`。App 端只复用数据契约和交互边界，不搬 Web 的桌面分栏、Monaco、`react-complex-tree` 或编辑交互。

## 范围

### 本计划包含

- App 端 terminal detail 增加底部 tabs 和 tab 状态。
- App 端新增 preview API service 封装。
- App 端新增移动端 `Changes` 和 `Files` 只读 UI。
- 复用当前 terminal state 模型：`TerminalState.state === "agent_running"` 控制 Stop。
- 对无 project path、无 changes、文件过大、二进制文件、接口 401/404/500 做可见状态。

### 本计划不包含

- 不新增后端 preview 接口。
- 不实现 App 端文件保存、删除、重命名。
- 不引入 Monaco、`react-complex-tree` 或 Web sidecar 到 App。
- 不新增 App `src/` 下的单元测试文件。
- 不实现从 `Changes` / `Files` 发起 Chat 输入、解释变更、请求修复、文件问答或自动 prompt 构造。
- 不实现行级评论持久化、PR/MR 审阅状态同步、AI 总结 API。
- 不实现 project path 编辑入口；App 当前没有 project 编辑流程。

## 用户可见行为

### Chat tab

- 默认进入 `Chat`。
- 保持当前终端输出、刷新、图片输入、Stop/Send 行为。
- Chat composer placeholder 继续保持现有文案。
- 切到 `Changes` 或 `Files` 时，terminal websocket 不能断开；切回 `Chat` 后能继续看到最新输出。

### Changes tab

- 顶部显示 changes summary：总变更数、`All / Staged / Working` filter、手动 refresh。
- 文件列表使用单列移动端列表，不使用桌面树分栏。
- 文件行显示：
  - 状态 badge：`M`、`A`、`D`、`R`、`U`。
  - 文件路径，目录弱化、文件名突出。
  - staged / working 分组信息。
- 点击文件后在同一 tab 内显示单文件 diff：
  - 顶部保留返回文件列表入口。
  - 显示文件名、change kind、状态 badge。
  - 提供 `Diff / Preview` segmented control；`Preview` 仅用于 markdown、svg、image 等已有 preview 类型，普通文本默认展示 `Diff`。
  - 只提供只读浏览、刷新和复制路径等基础操作。
- 没有 changes 时显示空状态。
- 没有 project path 时显示 `Set a project path to use Changes and Files`，不提供编辑入口。

### Files tab

- 顶部显示 `Search files` 输入框和手动 refresh。
- 未搜索时显示 breadcrumb 和单列目录列表：
  - `..` parent row。
  - folder row 使用 chevron。
  - file row 显示扩展名/语言 badge。
  - 如果文件出现在 git changes 中，显示状态 badge。
- 搜索时调用 preview file search API，展示单列搜索结果。
- 点击文件后打开页面内只读 preview drawer；drawer 必须在 bottom tabs 上方，不遮挡导航。
- 文件 preview drawer 显示：
  - 文件名、相对路径、`readonly`、大小。
  - 文本文件展示 monospace 只读预览。
  - markdown、svg、image 走已有 preview 能力。
  - 二进制或过大文件展示不可预览状态。
  - 如果该文件在 changes 中，可提供 `Show changes`，切到 `Changes` tab 并选中对应文件。
  - overflow 中可放 `Copy path`。

## 文件变更计划

### 1. 扩展 App terminal metadata

文件：`app/src/hooks/use-app-terminal-connection.ts`

修改点：

- 给 `TerminalMetadata` 增加 `projectId: string | null`。
- `toTerminalMetadata()` 从 `TerminalSessionStatusResponse.projectId` 填充。
- websocket `metadata` 消息没有 projectId 时，保留 current metadata 的 `projectId`；如果 current 为 null，使用 `null`。

验收：

- `AppTerminalPage` 可以稳定得到 `activeProjectId = metadata?.projectId ?? initialSession?.projectId ?? null`。
- 401、404、连接重试行为不变。

### 2. 新增 App preview service

文件：`app/src/services/terminal.ts`

新增函数：

- `getTerminalProjectPreviewGitChanges(apiBase, accessToken, projectId)`
- `getTerminalProjectPreviewFileDiff(apiBase, accessToken, projectId, params)`
- `listTerminalProjectPreviewDirectory(apiBase, accessToken, projectId, params)`
- `searchTerminalProjectPreviewFiles(apiBase, accessToken, projectId, params)`
- `getTerminalProjectPreviewFile(apiBase, accessToken, projectId, filePath)`
- `getTerminalProjectPreviewAsset(apiBase, accessToken, projectId, filePath)`

约束：

- 请求路径和 Web service 保持一致。
- 401 继续由页面捕获后调用 `onAuthExpired()`。
- 不新增 save/delete/rename 封装。

### 3. 拆出 terminal detail tabs 状态和布局

文件：`app/src/pages/AppTerminalPage.tsx`

新增类型：

```ts
type AppTerminalDetailTab = "chat" | "changes" | "files";
```

修改点：

- 增加 `activeTab` state，默认 `"chat"`。
- 保持 `useAppTerminalConnection()` 始终挂载。
- `Chat` 内容区渲染 `TerminalRenderer`；非 Chat tab 时 renderer 可以被 CSS 隐藏，但不要销毁 terminal 连接状态。
- 仅 `Chat` tab 渲染 `TerminalCommandComposer`。
- `Changes` / `Files` tab 不调用 `sendTerminalInput()`，不构造 prompt。

验收：

- 切换 tabs 不触发 terminal websocket 断开。
- `Chat` 输入、图片输入和 Stop 行为与现有一致。
- Chat composer 位于 bottom tabs 上方；Changes/Files 不出现额外 composer。

### 4. 新增底部 tab bar 组件

建议文件：`app/src/components/TerminalDetailTabBar.tsx`

职责：

- 渲染 `Chat / Changes / Files`。
- 最底部安全区适配。
- `Changes` 可显示变更数量 badge。
- 只处理 UI 和 `onTabChange`，不读 API。

CSS：

- 在 `app/src/main.css` 中新增 `.terminal-detail-tabs`、`.terminal-detail-tab` 等类。
- `.terminal-page-shell` 改成四行布局，例如：

```css
grid-template-rows: auto minmax(0, 1fr) auto auto;
```

- 当非 Chat tab 不渲染 composer 时，content 行占满剩余高度，tabs 仍贴底。

### 5. 新增 Changes tab

建议文件：

- `app/src/components/TerminalChangesTab.tsx`
- `app/src/components/MobileDiffView.tsx`
- `app/src/lib/mobile-diff.ts`

职责：

- 根据 `projectId` 调用 `getTerminalProjectPreviewGitChanges()`。
- 支持 `All / Staged / Working` filter。
- 本地维护 `viewedChangeKeys: Set<string>`，key 格式为 `${kind}:${path}`。
- 选择文件后调用 `getTerminalProjectPreviewFileDiff()`。
- `MobileDiffView` 做手机单列只读 diff：
  - 小文件使用行级 LCS 生成 hunks。
  - 超过 800 行或 LCS 成本过高时，fallback 为 old/new 分块对比，避免卡顿。
  - 连续未变行超过 6 行时折叠为 `... unchanged lines`。
- preview 模式只覆盖 Web 已有的 markdown、svg、image 预览边界；其它类型展示 diff 或不可预览状态。

约束：

- 如果没有 `projectId` 或 project path，显示空状态，不发请求。
- 不实现解释、修复、发送到 Chat、行级评论持久化。

### 6. 新增 Files tab

建议文件：

- `app/src/components/TerminalFilesTab.tsx`
- `app/src/components/TerminalFilePreviewDrawer.tsx`
- `app/src/lib/terminal-file-format.ts`

职责：

- 根据 `projectId` 调用 `listTerminalProjectPreviewDirectory()`。
- 搜索框有 150-250ms debounce，调用 `searchTerminalProjectPreviewFiles()`。
- breadcrumb 基于当前相对目录生成，点击上级目录可跳转。
- 文件列表按目录优先、文件其次排序；使用后端返回顺序也可以，但 parent row 必须在顶部。
- 复用 changes 数据给 modified badge：
  - 可由 `AppTerminalPage` 或 `TerminalFilesTab` 拉取 `getTerminalProjectPreviewGitChanges()`。
  - 不要求实时 websocket；手动 refresh 即可。
- 点击文件调用 `getTerminalProjectPreviewFile()`；图片调用 `getTerminalProjectPreviewAsset()`。
- preview drawer 只提供只读浏览、`Show changes`、`Copy path`。

约束：

- 首版只读。
- 不显示编辑器保存状态。
- 不复用 Web 的 `react-complex-tree`。
- 不提供文件问答、发送到 Chat、prompt 构造。

## 错误处理

- 401：调用 `onAuthExpired()`。
- 404：
  - session 404 保持当前“终端不存在或已被删除”。
  - project/file 404 在对应 tab 内显示 `Project not found` 或 `File not found`。
- 413/415：文件过大或二进制不可预览时显示只读空状态。
- preview 请求失败：tab 内显示错误和 `Retry`。
- project path 为空：`Changes` 和 `Files` 显示 `Set a project path to use Changes and Files`，不提供编辑 project 的入口。

## 验证计划

### 自动验证

执行：

```bash
pnpm --filter @runweave/app typecheck
pnpm app:build
```

预期：

- 两个命令 exit code 为 0。
- 无 TypeScript 类型错误。
- App build 产物成功生成。

不新增：

- 不新增 `app/src/**/*.test.ts`
- 不新增 `app/src/**/*.test.tsx`
- 不新增前端 Vitest 覆盖配置

### 手工验证

启动：

```bash
pnpm app:dev
```

使用 App terminal detail 验证：

- 进入 terminal detail 默认在 `Chat`。
- bottom tabs 在最底部，Chat composer 在 tabs 上方。
- Chat 输入命令后，终端收到命令并更新输出。
- agent running 时 send 按钮切换为 Stop；Stop 仍通过 `/interrupt` 生效。
- 切到 `Changes` 后 terminal 不断线，切回 Chat 后仍能看到最新输出。
- Changes 能加载当前 project git changes。
- Changes filter 能在 All/Staged/Working 间切换。
- 点击 changed file 能看到移动端单列 diff。
- Diff/Preview 只展示只读内容，不出现解释、修复、发送到 Chat 的入口。
- 切到 `Files` 后能浏览根目录。
- breadcrumb 能进入和返回目录。
- Search 能展示文件结果。
- 点击文本文件能打开只读 preview drawer。
- modified 文件能通过 `Show changes` 切到 Changes 并选中对应文件。
- Files 不出现文件问答、发送到 Chat 或编辑保存入口。

移动端验证：

```bash
pnpm app:ios:local
```

重点检查：

- iPhone 竖屏安全区下，bottom tabs 不被 home indicator 遮挡。
- keyboard 弹起时 Chat composer 可见，不遮挡 bottom tabs。
- diff 和 file preview 可滚动，header、composer、tabs 不发生重叠。
- 长路径、长文件名、长单词不会溢出容器。

## 风险与控制

- 隐藏 terminal renderer 时尺寸可能变化：切回 Chat 后调用 `rendererRef.current?.refresh()` 或在 active tab 变化时触发 refresh。
- 手机端 diff 算法可能卡顿：限制 LCS 输入规模，超限 fallback。
- preview API 是 project 维度，不是 session 维度：必须用 session 的 `projectId`；当 session 没有 project 或 project path 为空时显示空状态。
- 文件 preview 和 changes 都可能频繁请求：对搜索 debounce，对 refresh 使用显式按钮，不做实时轮询。

## 验收标准

- 代码层面：App typecheck 和 build 通过。
- 行为层面：`Chat / Changes / Files` 三个 tabs 可切换；Chat composer 在 bottom tabs 上方。
- 数据层面：Changes/Files 均通过已有 project preview API 工作，不新增后端接口。
- 交互层面：Changes 只做变更列表和 diff/preview；Files 只做搜索、浏览和只读预览。
- 稳定性：tab 切换不重启 terminal session，不丢 websocket 输出。
- 边界：无 project path、无 changes、文件过大、二进制文件、接口失败都有可见状态。
