# Mobile Terminal Detail Tabs 实施计划

日期：2026-06-10

## 目标

在 App 端终端详情页增加底部 `Chat / Changes / Files` 三个 tabs，让手机端可以在同一个 terminal session 里完成：

- `Chat`：继续查看终端输出并输入命令或问题。
- `Changes`：按移动端代码审阅方式查看当前 project 的 git changes、单文件 diff，并把“解释/修复”类问题发送到 Chat。
- `Files`：按移动端文件浏览方式搜索、浏览、预览当前 project 文件，并从文件上下文发起 Chat 问题。

最终布局必须是：

```text
Header
Active tab content
Composer / context composer
Bottom tabs
```

`Composer` 必须在底部 tabs 上方；bottom tabs 是页面最底部导航，负责在 `Chat / Changes / Files` 之间切换。

参考草图：

- `artifacts/mobile-terminal-tabs-overview-sketch-revised.png`
- `artifacts/mobile-terminal-tabs-changes-files-sketch-revised.png`

## 当前代码事实

- App 终端详情页由 `app/src/pages/AppTerminalPage.tsx` 负责，当前结构是 header、terminal body、`TerminalCommandComposer` 三段布局。
- 当前 CSS 在 `app/src/main.css` 中用 `.terminal-page-shell { grid-template-rows: auto minmax(0, 1fr) auto; }` 固定三行，需要扩展为 header、content、composer/error、tabs 的布局。
- `TerminalCommandComposer` 在 `app/src/components/TerminalCommandComposer.tsx` 中，当前发送逻辑会先发送输入文本，再发送换行；Stop 状态由调用方传入。
- App 终端连接由 `app/src/hooks/use-app-terminal-connection.ts` 负责。它已经通过 `getTerminalSession()` 获取 `TerminalSessionStatusResponse`，但当前暴露给页面的 `metadata` 不包含 `projectId`。
- App service 当前在 `app/src/services/terminal.ts` 中只封装了 mobile overview、session、state、ws-ticket、input、interrupt、clipboard-image；尚未封装 preview files/changes API。
- 后端已有可复用 preview API，不需要新增后端接口：
  - `GET /api/terminal/project/:id/preview/git-changes`
  - `GET /api/terminal/project/:id/preview/file-diff?path=&kind=`
  - `GET /api/terminal/project/:id/preview/directory?path=&limit=`
  - `GET /api/terminal/project/:id/preview/files/search?q=&limit=`
  - `GET /api/terminal/project/:id/preview/file?path=`
  - `GET /api/terminal/project/:id/preview/asset?path=`
- 共享协议 `packages/shared/src/terminal-protocol.ts` 已有 `TerminalPreviewGitChangesResponse`、`TerminalPreviewFileDiffResponse`、`TerminalPreviewDirectoryResponse`、`TerminalPreviewFileResponse` 等类型。
- Web 侧 preview 是桌面 sidecar：`frontend/src/components/terminal/terminal-preview-panel-content.tsx`、`terminal-preview-change-tree.tsx`、`terminal-file-explorer.tsx`。App 端不能直接搬 Web 的分栏、Monaco、`react-complex-tree` 或文件编辑交互。

## 范围

### 本计划包含

- App 端 terminal detail 增加底部 tabs 和 tab 状态。
- App 端新增 preview API service 封装。
- App 端新增移动端 `Changes` 和 `Files` UI。
- 复用当前 terminal state 模型：`TerminalState.state === "agent_running"` 控制 Stop。
- `Changes/Files` 中的上下文输入发送到当前 terminal，并切回 `Chat`。
- 对无 project path、无 changes、文件过大、二进制文件、接口 401/404/500 做可见状态。

### 本计划不包含

- 不新增后端 preview 接口。
- 不实现 App 端文件保存、删除、重命名。
- 不引入 Monaco、`react-complex-tree` 或 Web sidecar 到 App。
- 不新增 App `src/` 下的单元测试文件。
- 不实现行级评论持久化或 PR/MR 审阅状态同步。
- 不实现真正的 AI 总结 API；`Explain`、`Ask to fix` 通过当前 terminal 输入构造 prompt。

## 用户可见行为

### Chat tab

- 默认进入 `Chat`。
- 保持当前终端输出、刷新、图片输入、Stop/Send 行为。
- 切到 `Changes` 或 `Files` 时，terminal 连接不能断开，输出仍应持续写入 renderer；切回 `Chat` 后可继续查看最新输出。
- Chat composer placeholder 保持 `Type a command...`。

### Changes tab

- 顶部显示 changes summary：总变更数、`All / Staged / Working` filter。
- 文件列表使用单列移动端卡片，不使用桌面树分栏。
- 文件卡片显示：
  - 状态 badge：`M`、`A`、`D`、`R`、`U`。
  - 文件路径，按目录弱化、文件名突出。
  - `Viewed` 本地勾选状态。
- 点击文件后在同一 tab 内显示单文件 diff：
  - 顶部保留返回文件列表入口。
  - 显示文件名、change kind、状态 badge。
  - `Diff / Preview` segmented control：`Preview` 仅在 markdown、svg、image 等可预览类型有意义；普通文本默认只展示 `Diff`。
  - 主操作为 `Explain` 和 `Ask to fix`。
  - 路径复制等低频操作只放在 overflow 菜单，不作为主按钮。
- context composer placeholder：
  - 未选中文件：`Ask about these changes...`
  - 已选中文件：`Ask about this diff...`
- 提交 context composer 后：
  - 构造包含用户问题、project name、文件路径、change kind、diff 摘要的 prompt。
  - 调用现有 `sendTerminalInput()` 向当前 terminal 发送 prompt 和换行。
  - 切回 `Chat` tab。

### Files tab

- 顶部显示 `Search files` 输入框。
- 未搜索时显示 breadcrumb 和单列目录列表：
  - `..` parent row。
  - folder row 使用 chevron。
  - file row 显示扩展名/语言 badge。
  - 如果文件出现在 git changes 中，显示状态 badge。
- 搜索时调用 preview file search API，展示搜索结果单列列表。
- 点击文件后打开页面内 preview drawer；drawer 必须在 context composer 和 bottom tabs 上方。
- 文件 preview drawer 显示：
  - 文件名、相对路径、`readonly`、大小。
  - 主操作 `Ask about file`。
  - 如果该文件在 changes 中，显示 `Show changes`。
  - overflow 中放 `Copy path`。
  - 文本文件展示 monospace 只读预览；图片走 asset 预览；二进制或过大文件展示不可预览状态。
- context composer placeholder：
  - 未选中文件：`Ask about project files...`
  - 已选中文件：`Ask about this file...`
- 提交 context composer 后：
  - 构造包含用户问题、project name、文件路径、文件内容摘要的 prompt。
  - 调用现有 `sendTerminalInput()` 向当前 terminal 发送 prompt 和换行。
  - 切回 `Chat` tab。

## 文件变更计划

### 1. 扩展 App terminal metadata

文件：`app/src/hooks/use-app-terminal-connection.ts`

修改点：

- 给 `TerminalMetadata` 增加 `projectId: string`。
- `toTerminalMetadata()` 从 `TerminalSessionStatusResponse.projectId` 填充。
- websocket `metadata` 消息没有 projectId 时，保留 current metadata 的 `projectId`；如果 current 为 null，使用空字符串占位并让页面 fallback 到 `initialSession?.projectId`。

验收：

- `AppTerminalPage` 可以稳定得到 `activeProjectId = metadata?.projectId || initialSession?.projectId || null`。
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
- `Chat` 内容区渲染 `TerminalRenderer`；非 Chat tab 时不要断开 websocket。
- 当前 renderer 可以被 CSS 隐藏，但不要因 tab 切换销毁连接状态。
- 统一 context submit：
  - Chat 直接发送用户文本。
  - Changes/Files 构造上下文 prompt 后发送，并切回 Chat。
- `TerminalCommandComposer` 可以先复用为 Chat composer；Changes/Files 可新增轻量 context composer，避免图片按钮出现在非 Chat tab。

验收：

- 切换 tabs 不会触发 terminal websocket 断开。
- `Chat` 输入和 Stop 行为与现有一致。
- composer 位于 bottom tabs 上方。

### 4. 新增底部 tab bar 组件

建议文件：`app/src/components/TerminalDetailTabBar.tsx`

职责：

- 渲染 `Chat / Changes / Files`。
- 最底部安全区适配。
- `Changes` 显示变更数量 badge。
- 只处理 UI 和 `onTabChange`，不读 API。

CSS：

- 在 `app/src/main.css` 中新增 `.terminal-detail-tabs`、`.terminal-detail-tab` 等类。
- `.terminal-page-shell` 改成四行布局，例如：

```css
grid-template-rows: auto minmax(0, 1fr) auto auto;
```

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
- `MobileDiffView` 做手机单列 diff：
  - 小文件使用行级 LCS 生成 hunks。
  - 超过 800 行或 LCS 成本过高时，fallback 为 old/new 分块对比，避免卡顿。
  - 连续未变行超过 6 行时折叠为 `... unchanged lines`。
- `Explain` prompt：

```text
Explain this change in <path> (<kind>):
<bounded diff context>
```

- `Ask to fix` prompt：

```text
Review this change and suggest or apply fixes if needed: <path> (<kind>)
<bounded diff context>
```

约束：

- `bounded diff context` 控制在 6000 字符以内。
- 如果没有 `projectId` 或 project path，显示空状态，不发请求。
- 不实现行级评论持久化。

### 6. 新增 Files tab

建议文件：

- `app/src/components/TerminalFilesTab.tsx`
- `app/src/components/TerminalFilePreviewDrawer.tsx`
- `app/src/lib/terminal-file-format.ts`

职责：

- 根据 `projectId` 调用 `listTerminalProjectPreviewDirectory()`。
- 搜索框有 150-250ms debounce，调用 `searchTerminalProjectPreviewFiles()`。
- breadcrumb 基于当前相对目录生成，点击上级目录可跳转。
- 文件列表按目录优先、文件其次排序；使用后端返回顺序也可以，但必须保证 parent row 在顶部。
- 复用 changes 数据给 modified badge：
  - 可由 `AppTerminalPage` 或 `TerminalFilesTab` 拉取 `getTerminalProjectPreviewGitChanges()`。
  - 不要求实时 websocket；手动 refresh 即可。
- 点击文件调用 `getTerminalProjectPreviewFile()`；图片调用 `getTerminalProjectPreviewAsset()`。
- preview drawer 主操作：
  - `Ask about file`：把当前文件摘要作为 prompt context。
  - `Show changes`：如果文件在 changes 中，切到 `Changes` tab 并选中对应文件。
- 文件内容 context 控制在 6000 字符以内。

约束：

- 首版只读。
- 不显示编辑器保存状态。
- 不复用 Web 的 `react-complex-tree`。

### 7. Context composer

建议文件：`app/src/components/TerminalContextComposer.tsx`

职责：

- 用于 `Changes` 和 `Files` tab。
- 不显示图片按钮。
- 左侧可显示小图标或当前上下文 label。
- submit 后调用 `onSubmit(question)`，由父组件构造 prompt 并发送。
- pending 状态禁用 send。

验收：

- keyboard 弹起时 composer 不遮挡 bottom tabs。
- 空输入不能发送。
- 发送失败显示在现有 `.terminal-composer-error` 或独立 error row 中。

## 错误处理

- 401：调用 `onAuthExpired()`。
- 404：
  - session 404 保持当前“终端不存在或已被删除”。
  - project/file 404 在对应 tab 内显示 `Project not found` 或 `File not found`。
- 413/415：文件过大或二进制不可预览时显示只读空状态。
- preview 请求失败：tab 内显示错误和 `Retry`。
- project path 为空：`Changes` 和 `Files` 显示 `Set a project path to use Changes and Files`，不提供编辑 project 的入口；App 当前没有 project 编辑流程，避免引入额外范围。

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
- bottom tabs 在最底部，composer 在 tabs 上方。
- Chat 输入命令后，终端收到命令并更新输出。
- agent running 时 send 按钮切换为 Stop；Stop 仍通过 `/interrupt` 生效。
- 切到 `Changes` 后 terminal 不断线，切回 Chat 后仍能看到最新输出。
- Changes 能加载当前 project git changes。
- Changes filter 能在 All/Staged/Working 间切换。
- 点击 changed file 能看到移动端单列 diff。
- `Explain` 和 `Ask to fix` 会切回 Chat，并发送带上下文的 prompt。
- 切到 `Files` 后能浏览根目录。
- breadcrumb 能进入和返回目录。
- Search 能展示文件结果。
- 点击文本文件能打开 preview drawer。
- modified 文件能通过 `Show changes` 切到 Changes 并选中对应文件。
- Files context composer 能切回 Chat 并发送带文件上下文的 prompt。

移动端验证：

```bash
pnpm app:ios:local
```

重点检查：

- iPhone 竖屏安全区下，bottom tabs 不被 home indicator 遮挡。
- keyboard 弹起时 context composer 可见。
- diff 和 file preview 可滚动，header、composer、tabs 不发生重叠。
- 长路径、长文件名、长单词不会溢出容器。

## 风险与控制

- 隐藏 terminal renderer 时尺寸可能变化：切回 Chat 后调用 `rendererRef.current?.refresh()` 或在 active tab 变化时触发 refresh。
- 手机端 diff 算法可能卡顿：限制 LCS 输入规模，超限 fallback。
- prompt context 可能过长：统一截断到 6000 字符，并在 prompt 中标记内容已截断。
- preview API 是 project 维度，不是 session 维度：必须用 session 的 `projectId`；当 session 没有 project 或 project path 为空时显示空状态。
- 文件 preview 和 changes 都可能频繁请求：对搜索 debounce，对 refresh 使用显式按钮，不做实时轮询。

## 验收标准

- 代码层面：App typecheck 和 build 通过。
- 行为层面：`Chat / Changes / Files` 三个 tabs 可切换，composer 在 bottom tabs 上方。
- 数据层面：Changes/Files 均通过已有 project preview API 工作，不新增后端接口。
- 交互层面：Changes 主操作是审阅、解释、修复；Files 主操作是浏览、预览、询问文件；路径复制不是主操作。
- 稳定性：tab 切换不重启 terminal session，不丢 websocket 输出。
- 边界：无 project path、无 changes、文件过大、二进制文件、接口失败都有可见状态。
