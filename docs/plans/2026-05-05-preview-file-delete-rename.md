# Preview 文件删除与重命名计划

## 背景

当前 Preview 已经是 project-scoped：

- 前端入口在 `frontend/src/components/terminal/terminal-preview-panel.tsx`，状态按 `projectId` 存在 `frontend/src/features/terminal/preview-store.ts`。
- 文件打开、保存、asset、git changes/diff 的前端 API 在 `frontend/src/services/terminal.ts`。
- 后端 Preview API 注册在 `backend/src/routes/terminal-preview-routes.ts`，具体文件路径解析、读写、搜索、git diff 在 `backend/src/terminal/preview.ts`。
- 共享协议类型在 `packages/shared/src/terminal-protocol.ts`。
- Preview E2E 在 `frontend/tests/terminal-preview.spec.ts`，前端正式自动化验证只加 Playwright E2E，不新增前端单测。

现有能力只覆盖读取、保存、搜索、asset、git changes/diff。删除和重命名还没有后端接口、共享类型、service 方法或 UI 操作入口。

## 目标

在当前项目路径内支持 Preview 文件删除与重命名：

- 删除当前 Preview 选中的项目内文件。
- 重命名当前 Preview 选中的项目内文件。
- 操作成功后刷新 Preview 搜索缓存和 changes 列表。
- 操作成功后前端更新选中态，避免继续指向已经不存在的旧路径。

## 非目标

- 不支持删除或重命名目录。
- 不支持批量删除/批量重命名。
- 不支持对 `base: "filesystem"` 的项目外绝对路径做删除/重命名。
- 不自动执行 `git add`、`git mv`、stage/unstage。
- 不新增前端 Vitest/unit test。

## 推荐方案

新增 project-scoped 的专用 mutate API，复用 `resolvePreviewPath` 的安全边界：

- `DELETE /api/terminal/project/:id/preview/file`
  - body: `{ path: string; expectedMtimeMs?: number }`
  - 只允许项目内 regular file。
  - 如果传入 `expectedMtimeMs` 且文件 mtime 不一致，返回 409。
  - 成功返回 `{ kind: "file-delete", projectId, path, absolutePath }`。
- `PATCH /api/terminal/project/:id/preview/file/path`
  - body: `{ path: string; nextPath: string; expectedMtimeMs?: number }`
  - 源路径和目标路径都必须在项目内。
  - 源必须是 regular file，目标不能已存在，目标父目录必须存在。
  - 如果传入 `expectedMtimeMs` 且源文件 mtime 不一致，返回 409。
  - 成功返回 `TerminalPreviewFileResponse`，让前端直接打开重命名后的文件。

理由：当前 `PUT /preview/file` 已经是内容保存语义，删除/重命名属于文件路径 mutate，独立 API 比复用 save payload 更清晰，也能把破坏性行为的校验集中在后端。

## 实施步骤

1. 后端文件操作 helper
   - 修改 `backend/src/terminal/preview.ts`。
   - 新增 `deletePreviewFile` 和 `renamePreviewFile`。
   - 复用 `ensureProjectPath`、`resolvePreviewPath`、`clearPreviewFileSearchCache`。
   - 删除使用 `unlink`；重命名使用 `rename`。
   - 校验：
     - `path` 和 `nextPath` 不能为空。
     - 拒绝 `~`。
     - 拒绝项目外路径。
     - 拒绝目录和非 regular file。
     - 重命名目标已存在返回 409。
     - 重命名目标父目录不存在或不是目录返回 400。

2. API 路由和协议类型
   - 修改 `packages/shared/src/terminal-protocol.ts`：
     - 新增 `TerminalPreviewDeleteFileRequest/Response`。
     - 新增 `TerminalPreviewRenameFileRequest`。
   - 修改 `backend/src/routes/terminal-preview-routes.ts`：
     - 新增 `DELETE /project/:id/preview/file`。
     - 新增 `PATCH /project/:id/preview/file/path`。
     - 用 zod 校验 body。
   - 修改 `frontend/src/services/terminal.ts`：
     - 新增 `deleteTerminalProjectPreviewFile`。
     - 新增 `renameTerminalProjectPreviewFile`。

3. 前端交互入口
   - 修改 `frontend/src/components/terminal/terminal-open-file-command.tsx`：
     - 对 Files 列表里的每个 `Command.Item` 增加右键菜单。
     - 菜单项包括 `Rename` 和 `Delete`。
     - 右键菜单操作目标是被右键的文件项，不依赖当前是否已选中。
   - 修改 `frontend/src/components/terminal/terminal-preview-panel-content.tsx`：
     - 对 Changes 树里的文件节点增加右键菜单。
     - 菜单项包括 `Rename` 和 `Delete`。
     - 目录节点不提供删除/重命名入口。
     - 对项目外 readonly 文件不提供删除/重命名入口；当前 Changes 树都是项目内相对路径，Files 模式打开 absolute outside file 时不显示右键文件项。
   - 修改 `frontend/src/components/terminal/terminal-preview-panel-shell.tsx`：
     - 不在右上角 Preview 工具区新增删除/重命名按钮。
     - 保持右上角只承担全局面板操作：展开、保存、刷新、复制路径、关闭。
   - 修改 `frontend/src/components/terminal/terminal-preview-panel.tsx`：
     - 维护删除确认、重命名输入、pending/error 状态。
     - 对 dirty 文件先复用 `confirmDiscardDraft()`，避免未保存内容被删除/重命名。
     - 删除成功：
       - 清空当前 `filePreview/editorContent/loadedContent/loadedMtimeMs`。
       - 清空当前项目的 `selectedFilePath`。
       - 如果在 changes 模式，清空 `selectedChangePath/selectedChangeKind/fileDiff` 后重新 `loadChanges()`。
     - 重命名成功：
       - 更新当前项目 `selectedFilePath` 为响应里的新 `path`。
       - 使用返回的 `TerminalPreviewFileResponse` 填充编辑器状态。
       - 重新加载 changes。

4. Dialog 组件
   - 删除确认优先复用 `frontend/src/components/ui/alert-dialog.tsx`，文案明确 “This deletes the file from disk. This cannot be undone.”
   - 重命名使用现有 Radix Dialog 风格或新增一个局部小对话框，输入默认填当前相对路径。
   - 右键菜单优先复用 `frontend/src/components/ui/context-menu.tsx`，与项目 tab 的右键操作保持一致。
   - 不使用 `window.prompt`，因为现有项目已经有 Radix dialog/context menu 组件，且需要展示错误和 pending 状态。

5. 测试与验证
   - 后端：
     - 在 `backend/src/terminal/preview-save.test.ts` 或新增 `backend/src/terminal/preview-mutate.test.ts` 覆盖 helper。
     - 在 `backend/src/routes/terminal.test.ts` 覆盖两个路由。
     - 用例：
       - 删除项目内文件成功。
       - 删除目录失败。
       - 删除项目外路径失败。
       - mtime 冲突返回 409。
       - 重命名成功并返回新路径内容。
       - 重命名到已存在路径返回 409。
       - 重命名到不存在父目录返回 400。
       - 重命名项目外路径失败。
   - 前端 E2E：
     - 在 `frontend/tests/terminal-preview.spec.ts` 新增或扩展 Preview 用例。
     - 验证 Files 列表中文件项右键重命名 `README.md -> docs/renamed.md`，列表/预览显示新路径，磁盘旧文件不存在新文件存在。
     - 验证 Files 列表中文件项右键删除重命名后的文件，Preview 清空选择，磁盘文件不存在。
     - 验证 Changes 树中文件项右键菜单可打开删除/重命名流程；目录节点不出现这些操作。
   - 命令：
     - `pnpm typecheck`
     - `pnpm lint`
     - `pnpm --filter ./backend exec vitest run src/terminal/preview-mutate.test.ts src/routes/terminal.test.ts`
     - `pnpm --filter ./frontend exec playwright test terminal-preview.spec.ts -g "terminal preview renames and deletes files"`

## 风险与处理

- 数据丢失风险：删除必须二次确认；对已加载文件传 `expectedMtimeMs`，避免删除用户打开后被外部修改的文件。
- 路径逃逸风险：所有实际路径必须走 `resolvePreviewPath`，不在前端拼绝对路径后直接信任。
- 搜索缓存风险：删除/重命名成功后必须 `clearPreviewFileSearchCache(projectId)`。
- Preview 状态漂移：删除/重命名后必须同步清理或替换 `selectedFilePath`、`selectedChangePath`、`filePreview`、`fileDiff`。
- 项目外只读文件：当前代码允许打开项目外绝对路径但标记 readonly；删除/重命名必须拒绝这类文件。

## 验收标准

- 用户能从 Preview 当前文件执行重命名，成功后看到新路径和原文件内容。
- 用户能从 Preview 当前文件执行删除，成功后文件从磁盘消失且 Preview 不再显示旧内容。
- 对项目外绝对路径、目录、已存在目标路径、mtime 冲突都有明确错误。
- changes/file 两种模式不会因为删除或重命名后继续引用旧路径而报错或空转。
- `pnpm typecheck`、`pnpm lint`、目标后端测试和目标 E2E 通过。
