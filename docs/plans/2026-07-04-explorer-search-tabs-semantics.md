# Explorer Search Tabs 语义对齐方案

## 当前现状

- 前端入口在 `frontend/src/components/terminal/terminal-preview-quick-search.tsx` 和 `use-terminal-preview-quick-search.ts`。
- 三个 tab 分别调用三个后端接口：
  - `Files` -> `GET /preview/files/search`
  - `Content` -> `GET /preview/content/search`
  - `Folders` -> `GET /preview/folders/search`
- 后端实现集中在 `backend/src/terminal/preview-search.ts` 与 `backend/src/terminal/preview-content-search.ts`。
- `Content` 已经是明确的正文搜索：通过 `rg --json` 在候选文件内容里查 query。
- `Folders` 已经是明确的目录路径搜索：从候选文件路径反推出目录集合，再对目录路径排序。
- `Files` 当前语义不够干净：它返回文件，但评分同时使用 basename、完整 relative path、以及路径里的每个 segment。这会让目录名命中把文件带出来，用户会感觉 `Files` 在搜目录。

## 目标语义

保留三个 tab，但每个 tab 必须有独立、稳定、可解释的含义。

### Files

用途：快速打开文件。

搜索范围：

- 主搜索字段：文件名 basename，例如 `terminal-preview.tsx`。
- 辅助搜索字段：完整相对路径 relative path，例如 `frontend/src/components/terminal/terminal-preview.tsx`。
- 不把单独的父目录 segment 当成独立命中来源。也就是说，query 只命中目录名时，不应该批量返回目录下所有文件。

用户可见规则：

- 输入文件名、后缀、文件名片段时，命中文件。
- 输入带 `/` 的路径片段时，可以按相对路径命中文件。
- 空 query 保持现有行为：展示 changed files。
- `Files` 不搜索文件内容。

### Content

用途：在文件正文中查文本，并打开到具体行列。

搜索范围：

- 只搜索文件内容。
- 结果必须展示文件名、目录、命中行摘要、行列号。
- 不因为文件名或目录名匹配而返回结果。

用户可见规则：

- query 为空时不展示正文结果。
- 选择结果打开文件并定位到命中行列。
- 结果过多时保留 truncated 提示。

### Folders

用途：定位目录并在 Explorer tree 里 reveal。

搜索范围：

- 只搜索目录路径。
- 目录集合仍可从候选文件路径反推，不需要额外遍历目录树。
- 不返回文件。

用户可见规则：

- 输入目录名或路径片段时，命中目录。
- 选择结果后展开并选中对应目录。
- query 为空时不展示目录结果。

## 推荐实现

推荐保留三个 tab，但收紧 `Files` 的底层匹配逻辑。

1. 修改 `backend/src/terminal/preview-search.ts` 的 file ranking。
   - `Files` 的评分只比较 basename 和完整 relative path。
   - 移除或限制 `segmentScore` 对 file 搜索的影响。
   - 对不带 `/` 的 query，优先 basename；relative path 只能作为弱辅助，不能因为父目录 segment 单独命中而返回文件。
   - 对带 `/` 的 query，允许按 relative path 搜索。

2. 保持 `Folders` 使用现有 `rankFolder`。
   - 目录搜索需要 segment/path 匹配，这是它的职责。
   - 不把这套目录 ranking 复用给 `Files`。

3. UI 文案要和语义一致。
   - `Files` 标题：`Go to file`
   - `Files` placeholder：`Search files by name or path...`
   - `Content` placeholder：`Search file content...`
   - `Folders` placeholder：`Search folders by path...`

4. 补充 E2E 覆盖，防止语义回退。
   - 在 fixture 中放置一个目录名包含 query、但文件名和内容都不包含 query 的文件。
   - 在 `Files` tab 搜该 query，不应出现这个文件。
   - 在 `Folders` tab 搜同一个 query，应出现对应目录。
   - 在 `Content` tab 搜正文 needle，只出现正文命中。

## 非目标

- 不把三个 tab 合并成一个统一搜索入口。
- 不让 `Files` 搜正文内容。
- 不让 `Content` 搜文件名或目录名。
- 不改变候选文件过滤、安全排除、git changed files 的现有边界。
- 不新增非 E2E 单测。

## 验收标准

- `Files` 搜文件名能打开文件。
- `Files` 搜纯目录名不会把该目录下所有文件都列出来。
- `Files` 搜包含 `/` 的路径片段可以命中对应文件路径。
- `Content` 只返回正文命中，并能定位到行列。
- `Folders` 只返回目录，并能 reveal 到 Explorer tree。
- 快捷键保持：
  - `Cmd/Ctrl+P` 打开 `Files`
  - `Cmd/Ctrl+Shift+F` 打开 `Content`

## 验证方式

- `pnpm --filter ./backend typecheck`
- `pnpm --filter ./backend lint`
- `pnpm --filter ./frontend typecheck`
- `pnpm --filter ./frontend lint`
- `pnpm --filter ./frontend test -- terminal-preview.spec.ts`
- 浏览器验收使用 `$playwright-cli` 打开 `http://localhost:5175/`，验证三个 tab 的结果类型与上述语义一致。
