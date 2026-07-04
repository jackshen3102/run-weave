# Explorer Quick Search 测试 Case

## 范围

验证 Terminal 右侧 `Preview > Explorer` 的页面级快捷浮层搜索。覆盖 Files、Content、Folders 三种模式、选择结果后的 Explorer reveal/select 行为、内容命中行列定位、敏感文件排除和快捷键焦点规则。

## 测试数据

创建临时 Git 项目，至少包含：

- `docs/architecture/terminal-code-preview.md`：文件名搜索目标，内容包含 `Preview content`。
- `src/search/quick-target.ts`：内容搜索目标，内容包含 `export const quickSearchNeedle = "quick-search-target";`。
- `src/search/nested/child.ts`：文件夹搜索和多层展开目标。
- `assets/preview-sample.png`：非文本文件，用于确认搜索结果不会错误打开 mock 内容。
- `.env.local`：敏感文件，包含 `quick-search-target`，不应出现在内容或文件搜索结果。
- `.env.production.local`：敏感文件，不应出现在结果。
- `SECRET.txt`：大小写敏感排除样例，不应出现在结果。
- `node_modules/hidden/index.js`、`dist/hidden.js`：排除目录样例，不应出现在结果。
- `.env.example`：安全模板文件，可出现在文件搜索结果，但敏感内容搜索 Case 不依赖它。

## 自动化 E2E Case

### Case 1: Explorer 入口与页面级浮层

步骤：

1. 启动 `pnpm dev`。
2. 创建临时项目和 terminal session，打开 `/terminal/<session-id>`。
3. 进入 `Preview > Explorer`。
4. 用 `getByRole("button", { name: "Search project files" })` 定位并点击入口。
5. 读取浮层 bounding box 和 viewport 尺寸。

断言：

- 入口按钮可定位。
- 浮层可见。
- 浮层中心接近 viewport 中心，而不是 Explorer sidebar 或 Preview 面板中心。

### Case 2: Files 模式搜索与选择

步骤：

1. 从 Explorer 点击入口，默认进入 Files 模式。
2. 输入 `terminal preview`。
3. 点击 `terminal-code-preview.md` 结果。

断言：

- 结果行包含文件名、目录和统一行样式。
- 浮层关闭。
- 当前 Preview mode 为 Explorer。
- Explorer 展开 `docs/architecture` 并选中 `terminal-code-preview.md`。
- 右侧预览打开该文件。

### Case 3: Content 模式搜索与行列定位

步骤：

1. 使用 `Cmd/Ctrl+Shift+F` 打开 Content 模式。
2. 输入 `quick-search-target`。
3. 点击 `quick-target.ts` 内容结果。

断言：

- 结果行包含文件名、路径、命中片段和 `line:column` badge。
- 浮层关闭。
- 当前 Preview mode 为 Explorer。
- Explorer 展开 `src/search` 并选中 `quick-target.ts`。
- Monaco source view 打开该文件并定位到命中行附近。

### Case 4: Folders 模式搜索与目录聚焦

步骤：

1. 打开快捷浮层并切到 Folders。
2. 输入 `nested`。
3. 点击 `nested` 目录结果。

断言：

- 结果行包含目录名、父路径和 `DIR` badge。
- 浮层关闭。
- Explorer 展开并聚焦 `src/search/nested`。
- 右侧文件预览不变成目录错误或 mock 内容。

### Case 5: 从不同当前 mode 选择后强制回 Explorer

步骤：

1. 当前 mode 为 Changes 时打开快捷浮层，选择 Files 结果。
2. 当前 mode 为 Open/File 时打开快捷浮层，选择 Files 结果。
3. 当前 mode 为 Explorer 时打开快捷浮层，选择 Files 结果。

断言：

- 三次选择后最终都处于 Explorer mode。
- Explorer 都执行真实展开、选中和文件预览。
- 不停留在 `file` mode。

### Case 6: 敏感文件与排除目录

步骤：

1. Files 模式输入 `.env`、`secret`、`hidden`。
2. Content 模式输入 `quick-search-target`。

断言：

- `.env.local`、`.env.production.local`、`SECRET.txt` 不出现在结果。
- `node_modules/hidden/index.js`、`dist/hidden.js` 不出现在结果。
- Content 结果只包含允许搜索的普通文件。

### Case 7: 快捷键与焦点规则

步骤：

1. Preview 空白区域聚焦时按 `Cmd/Ctrl+P`。
2. Preview 空白区域聚焦时按 `Cmd/Ctrl+Shift+F`。
3. 让 terminal emulator 获得焦点后按相同快捷键。
4. 让 Monaco 获得焦点后按 `Cmd/Ctrl+P`，再按 `Cmd/Ctrl+S`。
5. 让普通输入框获得焦点后按 `Cmd/Ctrl+P`。

断言：

- Preview 空白区域快捷键打开对应模式。
- terminal、Monaco、普通输入框聚焦时不会打开快捷浮层。
- `Cmd/Ctrl+S` 保存逻辑不受影响。
- 浮层内 `Esc` 关闭，`Enter` 打开当前高亮结果。

## 手工浏览器验收

使用 `$playwright-cli` 执行以下最小现场验收：

1. `playwright-cli open http://127.0.0.1:<port>/terminal/<session-id>`。
2. 通过 snapshot 定位 `Search project files`。
3. 点击入口，截图或 eval 浮层 bounding box。
4. 分别验证 Files、Content、Folders 三种模式的可见结果和选择行为。
5. 验证敏感文件不出现在结果。

## 命令验证

实现完成后执行：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./backend lint
pnpm --filter ./frontend lint
pnpm --filter ./frontend test -- terminal-preview.spec.ts
git diff --check
```
