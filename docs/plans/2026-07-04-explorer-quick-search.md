# Explorer 快捷浮层搜索实施计划

## 目标

在 Terminal 右侧 `Preview > Explorer` 中加入页面级快捷浮层搜索，让用户可以用同一个入口搜索当前项目的文件、文件内容和文件夹，并在选择结果后回到真实 Explorer 树的展开、选中和文件预览状态。

本计划基于当前原型 `docs/prototypes/explorer-search-interactions/` 和现有生产代码。原型只作为交互与视觉参考；最终实现必须回到当前 React、Tailwind、`cmdk`、Preview API 和 Explorer tree 的代码约束内完成。

## 非目标

- 不实现原型早期的多方案对比、双入口、前缀命令、内联过滤、虚拟目录或终端命令桥。
- 不把原型里的模拟终端区域、模拟文件内容、mock 搜索结果、cache-buster 逻辑带入产品代码。
- 不重做 Terminal Preview 的整体布局、Changes/File/Open 模式，除非为快捷浮层接入必须改动。
- 不新增单测或 Vitest 测试；本仓库约束下 UI 行为只补 Playwright E2E。
- 不做长期全文索引服务。首期内容搜索走受限的即时 `rg` 搜索，并用超时、limit 和排除规则控制成本。
- 不改变敏感文件排除策略，不搜索 `.env.local`、secret 文件、`node_modules`、`dist` 等现有排除范围。

## 需要从原型带入产品的内容

1. 页面级居中 Dialog
   - 使用现有 `frontend/src/components/ui/dialog.tsx` 的 `Dialog` / `DialogContent` 承载快捷浮层。
   - 通过 `DialogContent` 的 `className` 控制宽高和 slate 风格，确保内容居中在整个页面，而不是右侧 Preview 面板内。

2. 三种搜索模式
   - `Files`：搜索文件路径，默认模式，复用现有 Open file 的文件搜索心智。
   - `Content`：搜索文件内容，结果展示文件、路径、命中片段和 `line:column`。
   - `Folders`：搜索目录路径，结果展示目录名、路径和 `DIR` 标识。

3. 统一结果行样式
   - 三种模式共用同一套结果行结构。
   - 差异只体现在左侧图标、信息密度和右侧 badge：`file + Git 状态`、`text + line:column`、`folder + DIR`。

4. 快捷键和基础交互
   - `Cmd/Ctrl+P` 打开 `Files` 模式。
   - `Cmd/Ctrl+Shift+F` 打开 `Content` 模式。
   - `Esc` 关闭浮层。
   - `Enter` 打开当前高亮结果。
   - 鼠标点击结果也执行打开。

5. 选择结果后的真实产品行为
   - 浮层关闭。
   - Explorer 树只执行真实 `reveal/select`，不保留搜索命中高亮。
   - 文件结果打开文件并预览。
   - 内容结果打开文件，并尽量定位到命中行列；如果 Monaco 当前能力不足，需要补一个明确的 line target 流程。
   - 文件夹结果展开并聚焦目录，不能变成打开 mock 文件。

## 原型中不进入产品的内容

- 模拟 terminal 主区域：产品里已有真实 terminal surface。
- 模拟 Preview 文件内容：产品里由 `readPreviewFile`、Monaco、Markdown/Image/SVG preview 渲染。
- `mock-state.json` 数据结构：产品协议需要定义在 `packages/shared`。
- 原型静态资源 cache-buster：只服务 HTML 原型刷新，不进入生产构建。
- 原型里的截图、说明 tab、辅助文案：不进入应用 UI。

## 当前代码现状

- `frontend/src/components/terminal/terminal-preview-panel-shell.tsx`
  - 已提供 Preview 右侧面板壳、工具 tab、Preview mode tab 和 header 风格。
- `frontend/src/components/terminal/terminal-preview-file-view.tsx`
  - `explorer` 模式渲染 `TerminalFileExplorer`。
  - `file` 模式渲染 `TerminalOpenFileCommand`。
  - 当前布局是左侧 240px 文件区加右侧文件预览。
  - 当前 Explorer sidebar 没有搜索头部或按钮，本需求需要在这里新增入口。
- `frontend/src/components/terminal/terminal-open-file-command.tsx`
  - 已使用 `cmdk`，`shouldFilter={false}`，后端负责搜索。
  - 结果行已经有 basename、dirname、Git 状态 badge 和选中态。
  - 快捷浮层应优先复用或抽出这里的结果行风格，不另起一套视觉语言。
- `frontend/src/components/terminal/use-terminal-preview-panel-data.ts`
  - 只有 `mode === "file"` 时触发 `searchTerminalProjectPreviewFiles(...)`。
  - 现有搜索状态为 `searchItems/searchLoading/searchError`，绑定 Open 模式，不适合直接承载三模式浮层。
- `frontend/src/components/terminal/use-terminal-file-tree.ts`
  - 已有 `revealFile(relativePath)`，会加载父目录、展开路径、选中并聚焦文件。
  - 首期文件选择应复用该流程，不在 tree 上增加搜索高亮。
- `frontend/src/components/terminal/terminal-file-tree.tsx`
  - `react-complex-tree` 的 `canSearch={false}`，当前不能依赖内置 tree search。
- `frontend/src/components/terminal/use-terminal-preview-panel-keyboard-effects.ts`
  - 当前只有 expanded 下 `Esc`、文件保存 `Cmd/Ctrl+S` 和 beforeunload。
  - 快捷搜索需要在这里或新的专用 hook 中补键盘入口，并处理焦点冲突。
- `frontend/src/services/terminal-preview.ts`
  - 当前只有 `searchTerminalProjectPreviewFiles(...)` 对接 `/preview/files/search`。
- `backend/src/routes/terminal-preview-routes.ts`
  - 当前只有 `GET /project/:id/preview/files/search` 文件搜索路由。
- `backend/src/terminal/preview-search.ts`
  - 文件搜索已实现：空查询返回 Git changed files，非空查询基于候选文件做 fuzzy rank。
- `backend/src/terminal/preview-search-candidates.ts`
  - 候选文件已有 `rg --files`、fallback 遍历、15 秒 TTL 缓存、敏感文件排除、目录排除和 20,000 文件上限。
- `packages/shared/src/terminal-protocol.ts`
  - 当前只有 `TerminalPreviewFileSearchItem` 和 `TerminalPreviewFileSearchResponse`。
  - 内容搜索和文件夹搜索需要新增共享协议。

## 交互设计

### 入口

- 当前产品没有现成 Search 按钮；需要新增一个明确入口。
- 入口位置：在 `TerminalPreviewFileView` 的 Explorer sidebar 顶部新增一行窄 header。
  - 左侧显示 `Project Files`。
  - 右侧新增原生 `<button type="button">` icon button，使用 lucide `Search` 图标。
  - 按钮 `aria-label="Search project files"`，Playwright 使用 `getByRole("button", { name: "Search project files" })` 定位。
  - 点击该按钮打开 quick search Dialog，默认进入 `Files`。
- 不把入口塞到 `TerminalPreviewPanelShell` 的 Preview task bar 右侧；该 task bar 属于 Changes/Open/Explorer mode 切换，搜索入口应随 Explorer sidebar 出现。
- 页面级快捷键：
  - `Cmd/Ctrl+P`：打开浮层并切到 `Files`。
  - `Cmd/Ctrl+Shift+F`：打开浮层并切到 `Content`。
- 快捷键只在 Terminal 页面内生效；浮层打开时优先处理自身快捷键。
- 为避免抢终端输入，未打开浮层时需要做焦点判断：
  - 如果当前焦点在 terminal emulator、Monaco 编辑器或普通输入框内，不拦截快捷键。
  - 如果焦点在 Preview 面板、Preview header 或页面空白区域，可以拦截。

### 浮层布局

- 用现有 `Dialog` 组件作为容器，不新增 modal primitive。
- `DialogContent` 负责页面级居中和尺寸控制：
  - 宽度按 viewport 自适应，例如 `min(960px, calc(100vw - 48px))`。
  - 高度按结果内容控制，上限例如 `min(720px, calc(100vh - 80px))`。
- Dialog 内部结构：`Files / Content / Folders` tab、单行输入框、结果列表、加载态、空态、错误态、短快捷键提示。

### 结果样式

- 提取或复用 `TerminalOpenFileCommand` 的结果行基础样式：
  - basename 主行：`font-medium text-slate-100/200`。
  - dirname 次行：`text-xs text-slate-500`。
  - hover / aria-selected / selected 状态沿用现有 slate 颜色。
- `Files`：
  - 左侧 `File` icon。
  - 右侧显示 Git status 首字母 badge，如果存在。
- `Content`：
  - 左侧 `Text` icon。
  - 主行显示文件名。
  - 次行显示路径。
  - 额外一行显示命中片段，命中文字用轻量高亮。
  - 右侧显示 `line:column`。
- `Folders`：
  - 左侧 `Folder` icon，颜色沿用 Explorer 文件夹 amber。
  - 主行显示目录名。
  - 次行显示父路径。
  - 右侧显示 `DIR`。

### 选择行为

- 文件结果：
  - 不直接调用现有 `openFilePath(path)`，因为它会在非 Explorer mode 下打开到 `file` mode。
  - 新增 quick search 专用动作，例如 `openQuickSearchFileResult(path, lineTarget?)`。
  - 该动作必须先执行 `confirmDiscardDraft()`；通过后调用 `openFile(projectId, path, "explorer")`，强制进入 Explorer。
  - Explorer 挂载后必须通过 `fileTree.revealFile(path)` 展开父目录、选中并聚焦文件。
  - 无论浮层从 Changes、Open/File 还是 Explorer 当前 mode 打开，选择文件结果后的目标 mode 都是 `explorer`。
- 内容结果：
  - 复用 `openQuickSearchFileResult(path, { line, column })`，同样强制进入 Explorer。
  - 记录 `{ path, line, column }` pending target。
  - 文件加载完成后让 Monaco reveal 到目标行列并短暂高亮命中行。
  - 如果目标文件是 Markdown/Image/SVG preview 模式，首期至少打开文件；行列定位只对 Monaco source view 生效。
- 文件夹结果：
  - 新增 `revealDirectory(relativePath)` 或扩展 `revealFile`，加载父目录、展开并聚焦目录。
  - 不打开右侧文件预览。
  - Explorer 树不保留搜索高亮。

## 数据与 API 设计

### 共享类型

在 `packages/shared/src/terminal-protocol.ts` 新增窄范围类型，保留现有文件搜索协议不破坏 Open 模式：

```ts
export type TerminalPreviewQuickSearchMode = "files" | "content" | "folders";

export interface TerminalPreviewFolderSearchItem {
  path: string;
  basename: string;
  dirname: string;
  score: number;
}

export interface TerminalPreviewContentSearchItem {
  path: string;
  basename: string;
  dirname: string;
  line: number;
  column: number;
  lineText: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface TerminalPreviewFolderSearchResponse {
  kind: "folder-search";
  projectId: string;
  projectPath: string;
  query: string;
  items: TerminalPreviewFolderSearchItem[];
  truncated: boolean;
}

export interface TerminalPreviewContentSearchResponse {
  kind: "content-search";
  projectId: string;
  projectPath: string;
  query: string;
  items: TerminalPreviewContentSearchItem[];
  truncated: boolean;
}
```

### 后端路由

保持现有文件搜索路由不变，新增两个低耦合路由：

- `GET /api/terminal/project/:id/preview/folders/search?q=&limit=`
- `GET /api/terminal/project/:id/preview/content/search?q=&limit=`

选择独立路由而不是单个 `mode=` 路由，是为了降低现有 Open file API 的回归风险，也方便分别调优内容搜索与目录搜索。

### 文件夹搜索

- 基于 `collectCachedSearchCandidateFiles(projectId, projectPath)` 得到文件候选。
- 从候选文件派生目录集合，包括每一层父目录。
- 复用 `preview-search.ts` 的 fuzzy rank 思路，或先抽出 `rankPathCandidate(query, relativePath)`。
- limit 默认 50，最大 100。
- 空查询返回顶层常用目录或空列表；首期建议空查询返回空列表，避免误导。
- 使用现有候选缓存和排除规则，不额外扫描敏感目录。

### 内容搜索

- 使用 `execFile("rg", args, { cwd: projectPath, timeout, maxBuffer })`，禁止 shell 拼接。
- 建议参数：
  - `--json`
  - `--line-number`
  - `--column`
  - `--smart-case`
  - `--no-config`
  - `--no-require-git`
  - `--max-count 5`
  - `--max-filesize 1M`
  - 复用 `EXCLUDED_DIRECTORIES`、`EXCLUDED_FILE_BASENAMES`、`EXCLUDED_FILE_SUFFIXES`、敏感 glob。
- 查询为空时返回空结果，不做全文扫描。
- `rg` exit code 1 视为无结果。
- 超时、buffer 超限或 `rg` 不存在时返回结构化错误，由前端显示轻量错误态。
- 结果按 `rg` 顺序收集到 limit，上限默认 50、最大 100。
- 每个结果只返回必要片段，不返回整文件内容。

## 前端实现方案

### 组件与 hook

新增：

- `frontend/src/components/terminal/terminal-preview-quick-search.tsx`
  - 使用 `Dialog` 承载快捷浮层，负责 tabs、输入框、结果列表、键盘选择和关闭。
- `frontend/src/components/terminal/use-terminal-preview-quick-search.ts`
  - 负责 open/mode/query/results/loading/error、debounce、请求竞态忽略。
- 可选新增 `frontend/src/components/terminal/terminal-preview-search-result-row.tsx`
  - 抽出 `TerminalOpenFileCommand` 与快捷浮层共用的结果行基础结构。

改动：

- `TerminalPreviewPanelContent` 或 `TerminalPreviewPanel`
  - 在 Preview tool 可用时挂载 quick search Dialog。
  - 把 `projectId/apiBase/token/activeProject/fileTree/openQuickSearchFileResult` 等必要能力传入。
- `TerminalPreviewFileView`
  - 只在 `mode === "explorer"` 时给 sidebar 增加 `Project Files` header 和 `Search project files` icon button。
  - header 使用原生 `<button type="button">`，不要用固定布局里的 Ionic/Button Web Component。
- `use-terminal-preview-panel-keyboard-effects.ts`
  - 增加快捷搜索入口，或拆出专用 hook，保持 `Cmd/Ctrl+S` 逻辑不被污染。
- `terminal-preview-panel-actions.ts`
  - 保留现有 `openFilePath` 给 Open/File 与 Explorer 点击使用。
  - 新增 quick search 专用选择动作，例如 `openQuickSearchFileResult(path, lineTarget?)`，复用 discard draft 检查和 markdown scroll reset，但固定调用 `openFile(projectId, path, "explorer")`，不能复用 `openFilePath` 的 mode 推断。

### 状态边界

- Quick search 的 `open/mode/query/results` 首期放在本地 hook，不写入 `preview-store`。
- 只有用户选择结果后，才提交到现有 preview store：选中文件、Preview mode、pending line target。
- `TerminalOpenFileCommand` 继续使用 `openFileQuery`，不被快捷浮层查询污染。
- 请求需要 debounce，输入变化时取消或忽略旧结果，避免慢请求覆盖新结果。

### 行列定位

当前 `TerminalMonacoViewer` 有 line reference copy 能力，但没有搜索结果定位 API。需要新增一个窄能力：

- 在 preview data 或本地状态中保存 `pendingLineTarget`。
- `TerminalMonacoViewer` 新增可选 prop，例如 `initialRevealPosition?: { line: number; column: number }`。
- 文件内容加载完成且 Monaco ready 后执行 reveal，并短暂装饰命中行。
- 目标消费后清空，避免用户后续切文件时重复跳转。

## 文件范围

- `packages/shared/src/terminal-protocol.ts`
  - 新增 folder/content search 协议类型。
- `backend/src/routes/terminal-preview-routes.ts`
  - 新增 folders/content search query schema 与路由。
- `backend/src/terminal/preview-search.ts`
  - 抽出可复用 path rank helper。
  - 新增 `searchPreviewFolders`。
- `backend/src/terminal/preview-content-search.ts`
  - 新增内容搜索实现，解析 `rg --json`。
- `backend/src/terminal/preview-search-candidates.ts`
  - 导出必要排除规则或新增构建 `rg` exclude args 的 helper，避免复制敏感排除逻辑。
- `backend/src/terminal/preview.ts`
  - re-export 新搜索能力。
- `frontend/src/services/terminal-preview.ts`
  - 新增 `searchTerminalProjectPreviewFolders` 和 `searchTerminalProjectPreviewContent`。
- `frontend/src/components/terminal/terminal-preview-quick-search.tsx`
  - 新增浮层组件。
- `frontend/src/components/terminal/use-terminal-preview-quick-search.ts`
  - 新增搜索状态 hook。
- `frontend/src/components/terminal/terminal-preview-panel.tsx`
  - 挂载浮层并连接选择行为。
- `frontend/src/components/terminal/terminal-preview-file-view.tsx`
  - 在 Explorer sidebar 顶部新增 `Project Files` header 和 `Search project files` icon button。
  - 接入快捷浮层入口。
- `frontend/src/components/terminal/use-terminal-preview-panel-keyboard-effects.ts`
  - 增加快捷键入口或调用新 hook。
- `frontend/src/components/terminal/use-terminal-file-tree.ts`
  - 新增 `revealDirectory`。
- `frontend/src/components/terminal/terminal-monaco-viewer.tsx`
  - 新增内容搜索结果行列 reveal 能力。
- `frontend/tests/terminal-preview.spec.ts`
  - 追加 Playwright E2E 覆盖快捷浮层。

## 实施步骤

1. 后端协议与搜索能力
   - 新增 shared 类型。
   - 后端增加 folder/content search 路由。
   - 文件夹搜索复用候选缓存。
   - 内容搜索使用受限 `rg --json`。
   - 验证：直接请求新 API，确认 limit、空查询、无结果、敏感排除、超时错误形态。

2. 前端服务与 quick search hook
   - 新增两个 service 方法。
   - 新增 hook 统一处理 mode/query/debounce/loading/error。
   - 文件模式复用现有 file search API。
   - 验证：用 Playwright 或临时页面操作确认切 tab 不串结果，慢请求不会覆盖新查询。

3. 浮层 UI
   - 新增 `TerminalPreviewQuickSearch`。
   - 在 `TerminalPreviewFileView` 的 Explorer sidebar 顶部新增 `Search project files` icon button 入口。
   - 抽取或复用 Open command 的结果行样式。
   - 实现 Files/Content/Folders 的图标、badge、片段和空态。
   - 验证：`getByRole("button", { name: "Search project files" })` 可定位入口；浮层页面级居中，不跟随右侧面板宽度偏移。

4. 选择与 Explorer/Preview 联动
   - 新增 `openQuickSearchFileResult(path, lineTarget?)`，选择文件和内容结果时强制 `openFile(projectId, path, "explorer")`。
   - 文件结果通过 `fileTree.revealFile(path)` 展开父目录、选中并聚焦文件。
   - 文件夹结果新增并调用 `revealDirectory`。
   - 内容结果复用 quick search 专用动作打开文件，并传递 line target。
   - 验证：分别从 Changes、Open/File、Explorer 当前 mode 打开浮层并选择文件/内容结果，最终都进入 Explorer；Explorer 只有真实选中态，没有搜索高亮残留。

5. 快捷键与焦点规则
   - 接入 `Cmd/Ctrl+P`、`Cmd/Ctrl+Shift+F`、`Esc`、`Enter`。
   - 不在 terminal emulator、Monaco、普通输入框获得焦点时抢快捷键。
   - 验证：Preview 内快捷键可用，编辑器保存 `Cmd/Ctrl+S` 不受影响。

6. E2E 与收尾
   - 在 `terminal-preview.spec.ts` 追加用例。
   - 清理多余导出、重复样式和死状态。
   - 更新相关 README 或原型冻结记录，如实现与原型有取舍。

## 验收标准

1. 在 Terminal Preview 的 Explorer sidebar 顶部可以看到 `Search project files` icon button，且 Playwright 可通过 `getByRole("button", { name: "Search project files" })` 定位。
2. 点击 `Search project files` 后，浮层出现在整个页面中心，而不是右侧面板中心。
3. `Cmd/Ctrl+P` 可以打开 Files 搜索；`Cmd/Ctrl+Shift+F` 可以打开 Content 搜索；`Esc` 关闭。
4. `Files` 输入文件名后展示文件结果，结果行包含文件名、目录和可选 Git 状态 badge。
5. `Content` 输入正文关键词后展示内容结果，结果行包含文件名、路径、命中片段和 `line:column`。
6. `Folders` 输入目录名后展示目录结果，结果行包含目录名、父路径和 `DIR` badge。
7. 三种模式结果行保持同一视觉结构，只通过 icon、badge 和内容密度区分。
8. 选择文件结果后浮层关闭，Explorer 展开父目录并选中该文件，右侧预览打开文件。
9. 从 Changes、Open/File 或 Explorer 任一当前 mode 打开浮层，选择文件结果后都必须进入 Explorer，而不是停留在 `file` mode。
10. 选择内容结果后浮层关闭，必须进入 Explorer 并打开文件；若是 Monaco source view，定位到命中行列。
11. 选择文件夹结果后浮层关闭，Explorer 展开并聚焦目录，不改变右侧文件预览为 mock 内容。
12. Explorer 树中不出现搜索高亮残留。
13. 大项目下搜索不会阻塞页面；后端 limit、timeout 和排除规则生效。
14. 敏感文件、排除目录和二进制/超大文件不会出现在搜索结果里。

## 验证方式

命令验证：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./backend lint
pnpm --filter ./frontend lint
git diff --check
```

浏览器验收必须使用 `$playwright-cli`：

1. 启动本地 `pnpm dev`。
2. 通过 Playwright 创建一个临时项目，包含：
   - 多层目录；
   - 可被文件名搜索命中的文件；
   - 可被正文搜索命中的文本；
   - 一个应被排除的敏感文件。
3. 打开 `/terminal/<session-id>`，进入 Preview Explorer。
4. 使用 `getByRole("button", { name: "Search project files" })` 定位并点击入口，断言浮层 bounding box 中心接近 viewport 中心。
5. 使用 `Cmd/Ctrl+P`、`Cmd/Ctrl+Shift+F`、tab 切换分别验证三种模式。
6. 分别在当前 mode 为 Changes、Open/File、Explorer 时打开浮层并选择 Files 结果，断言最终 tab/mode 是 Explorer，且 Explorer reveal/select 正确。
7. 分别在当前 mode 为 Changes、Open/File、Explorer 时打开浮层并选择 Content 结果，断言最终 tab/mode 是 Explorer，文件打开且 Monaco source view 定位正确。
8. 点击 Folders 结果，断言浮层关闭，Explorer 展开并聚焦目录。
9. 验证 terminal/Monaco/input 聚焦时快捷键不会误抢。

## 风险点

- 内容搜索性能：`rg --json` 在大仓库里仍可能较重，必须设置 timeout、maxBuffer、limit 和文件大小上限。
- 快捷键冲突：`Cmd+P` 在浏览器里默认是打印，在 terminal/editor 焦点下也可能有用户预期，需要严格控制拦截范围。
- 行列定位：当前 Monaco viewer 没有现成 reveal API，需要新增小能力并处理异步加载。
- 搜索结果竞态：用户快速输入或切换模式时，旧请求可能晚返回，需要忽略旧响应。
- 敏感文件泄露：内容搜索必须复用现有排除规则，不能只依赖 `rg` 默认 `.gitignore`。
- 文件夹搜索完整性：从文件候选派生目录意味着空目录不会出现。首期可以接受；若后续要搜索空目录，需要单独目录遍历能力。
- UI 复用边界：抽取 `TerminalOpenFileCommand` 行样式时要保持窄改动，避免影响现有 Open file 行为。
