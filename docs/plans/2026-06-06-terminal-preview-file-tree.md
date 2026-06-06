# Terminal Preview 文件树计划 (v5)

## 目标

file mode 左栏新增 Explorer tab，提供纯懒加载目录树浏览。Open tab 保留现有 TerminalOpenFileCommand 不变。第一阶段不做任何搜索（文件搜索和目录搜索都留在 Open tab）。

## 已确认决策

| 决策                   | 选择                                                            |
| ---------------------- | --------------------------------------------------------------- |
| 树方案                 | `react-complex-tree` ControlledTreeEnvironment + onMissingItems |
| 左栏 tab               | Explorer（新，默认，纯树无搜索） / Open（现有原样保留）         |
| 左栏宽度               | 240px                                                           |
| 过滤重目录             | node_modules/.git/dist/build/.next/.turbo/coverage 等           |
| Explorer 搜索          | 第一阶段不做，搜索留在 Open tab                                 |
| Reveal                 | 打开文件后 Explorer 自动展开到该文件                            |
| 不删除 OpenFileCommand | 保持所有现有能力不回归                                          |

## 当前代码事实

- 右侧 Preview 入口：`frontend/src/components/terminal/terminal-preview-panel.tsx`，内容区在 `terminal-preview-panel-content.tsx`。
- `mode === "file"` 当前左栏是 `TerminalOpenFileCommand`，宽度 `180px`，负责 cmdk 搜索和 changed files 空查询。
- 文件读取在 `backend/src/terminal/preview.ts`，通过 `resolvePreviewPath(...)` 做项目路径边界校验。
- 搜索在 `backend/src/terminal/preview-search.ts` + `preview-search-candidates.ts`，候选文件通过 `rg --files` + 短 TTL cache。
- Preview 路由在 `backend/src/routes/terminal-preview-routes.ts`。
- 共享协议在 `packages/shared/src/terminal-protocol.ts`。
- 前端服务封装在 `frontend/src/services/terminal.ts`。
- 前端已有 `cmdk`、`lucide-react`、`zustand`、`@monaco-editor/react`，无树组件。

## 方案设计：react-complex-tree + 后端按需目录 API

### 为什么选 react-complex-tree

1. **懒加载天然契合**：`onMissingItems` 在用户展开目录时触发，请求后端 children，合并进 items map 即可渲染。
2. **键盘导航和 ARIA 开箱即用**：Arrow/Home/End、focus 管理、screenreader live region。
3. **轻量内存**：只有被展开的目录 children 存在于 items map 中。
4. **UI 可定制**：`renderItem`/`renderItemArrow` 完全自定义 JSX，匹配 Tailwind/Radix 风格。
5. **无重量级依赖**：core 约 30KB gzipped，peer dep 仅 React。

### 数据模型

```ts
interface FileTreeData {
  basename: string;
  relativePath: string;
  kind: "file" | "directory";
  sizeBytes?: number;
  mtimeMs?: number;
}

// items map:
// - key = relative path (如 "src/components/foo.tsx")
// - root key = "root" (虚拟根节点)
// - 目录: isFolder=true, children=子条目 key 数组
// - 文件: isFolder=false, children=undefined
```

### 事件模型

| react-complex-tree 回调           | 绑定行为                                                 |
| --------------------------------- | -------------------------------------------------------- |
| `onExpandItem` / `onCollapseItem` | 更新 expandedItems + 触发懒加载                          |
| `onFocusItem`                     | 只更新焦点高亮（键盘导航不打开文件）                     |
| `onSelectItems`                   | 只更新选中态（不打开文件）                               |
| `onPrimaryAction`                 | 文件 → confirmDiscardDraft → openFilePath；目录 → toggle |
| renderItem 自定义 onClick         | 文件 → 同 onPrimaryAction；目录 → toggle                 |

关键约束：

- **永远不在 onSelectItems/onFocusItem 中打开文件**
- 所有打开文件统一经过 confirmDiscardDraft 保护
- 单击文件 = 打开，单击目录 = 展开/折叠，键盘↑↓ = 移焦点不打开，Enter = 打开/toggle

### 懒加载流程

1. 进入 file mode → 请求根目录 children → 初始化 items map。
2. 展开目录 A → 检查 children 是否已在 items map → 若无，请求 `GET /preview/directory?path=A` → 合并 items。
3. 重复展开直接从 items map 读取。
4. rename/delete 后清除对应父目录 children 并重新请求。

## 后端设计

### 新共享类型

`packages/shared/src/terminal-protocol.ts` 新增：

```ts
export type TerminalPreviewTreeEntryKind = "directory" | "file";

export interface TerminalPreviewTreeEntry {
  kind: TerminalPreviewTreeEntryKind;
  path: string;
  basename: string;
  dirname: string;
  hasChildren?: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface TerminalPreviewDirectoryResponse {
  kind: "directory";
  projectId: string;
  projectPath: string;
  path: string;
  absolutePath: string;
  entries: TerminalPreviewTreeEntry[];
  limit: number;
  truncated: boolean;
}
```

### 新目录 API

```
GET /api/terminal/project/:id/preview/directory?path=<relative>&limit=<number>
```

规则：

- `path` 省略或空 = 项目根目录
- `limit` 默认 500，允许 1..1000
- 只返回一层 children，不递归
- 路径必须在 project path 内，不能越界
- 文件 path → 400，目录不存在 → 404，无 project path → 409
- 排序：目录优先、文件其次；同类 `basename.localeCompare(...)` 排序
- 默认过滤：node_modules、.git、dist、build、coverage、.next、.turbo、playwright-report、test-results、.DS_Store、Thumbs.db、敏感 .env/secret 文件
- `hasChildren` 对目录返回 true
- 超 limit 时 `truncated: true`

### 后端文件

- 新建 `backend/src/terminal/preview-directory.ts` — listPreviewDirectory
- 修改 `backend/src/routes/terminal-preview-routes.ts` — 新增 directory 路由
- 新增前端 service `listTerminalProjectPreviewDirectory(...)` in `frontend/src/services/terminal.ts`

## 前端设计

### 新增依赖

```
pnpm add react-complex-tree --filter ./frontend
```

### 组件结构

```
terminal-file-explorer.tsx        ← Explorer tab 容器（纯树，无搜索框）
├── terminal-file-tree.tsx        ← ControlledTreeEnvironment + Tree
├── terminal-file-tree-item.tsx   ← renderItem (icon + name + loading + 右键菜单)
└── use-terminal-file-tree.ts     ← items map、viewState、懒加载、revealFile
```

### 修改现有组件

- `terminal-preview-panel-content.tsx`：file mode 左栏顶部加 tab bar（Explorer / Open），下方条件渲染；宽度 180px → 240px
- `preview-store.ts`：增加 `fileExplorerTab: "explorer" | "open"`、`expandedFileTreePaths`、`selectedExplorerPath`
- `use-terminal-preview-panel-data.ts`：接入 directory service、rename/delete 刷新树、打开文件时 revealFile

### 不修改

- `terminal-open-file-command.tsx` — 完全保留作为 Open tab

### Tab 行为

| Tab      | 内容                                                                   | 默认                    |
| -------- | ---------------------------------------------------------------------- | ----------------------- |
| Explorer | 纯懒加载目录树                                                         | 进入 file mode 默认激活 |
| Open     | 现有 TerminalOpenFileCommand（cmdk 搜索、changed files、绝对路径打开） | 手动切换                |

### Explorer Tab 行为

| 操作                       | 结果                           |
| -------------------------- | ------------------------------ |
| 进入 file mode             | 默认激活，加载根目录           |
| 单击文件                   | confirmDiscardDraft → 右侧打开 |
| 单击目录                   | 展开/折叠（首次触发 API）      |
| 键盘↑↓                     | 移动焦点，不打开               |
| Enter                      | 文件→打开，目录→toggle         |
| 右键文件                   | Rename / Delete                |
| rename/delete 成功         | 刷新父目录                     |
| 从 Open tab 打开文件后切回 | 树自动 Reveal                  |

### Reveal 流程

1. 任一途径打开文件 → 记录 lastOpenedFilePath
2. Explorer tab 可见 → revealFile → expandSubsequently 逐级展开 → 选中
3. Explorer tab 不可见 → 切回时 Reveal

### UI 细节

- 行高 28px，缩进 16px/层
- lucide icon：Folder/FolderOpen、File/FileText、ChevronRight/ChevronDown
- 目录加载中：箭头替换为 spinner
- 目录加载失败：显示 error + retry
- 截断目录：底部 `Only first N entries shown.`

## 缓存与性能

- 后端不缓存（一层 readdir 成本低）
- 前端 items map = 缓存（已加载目录不重复请求）
- rename/delete 后清除相关父目录 children
- 项目 path 变化清空整个 items map
- 每个目录最多 500 项（默认），最大 1000

## 非目标

- 不实现文件搜索（留在 Open tab）
- 不实现目录搜索
- 不实现文件内容搜索
- 不实现全量 workspace index
- 不实现拖拽、移动、复制、新建文件/目录
- 不读取或缓存整个 monorepo 文件树
- 不新增前端 Vitest 单测

## 风险与缓解

| 风险                          | 缓解                                      |
| ----------------------------- | ----------------------------------------- |
| react-complex-tree 样式不匹配 | renderItem 完全自定义，不用默认 CSS       |
| 体积 ~30KB                    | React.lazy 懒加载，仅 file mode 时 import |
| 大目录 >500 条 DOM 过多       | limit + truncated 提示                    |
| onMissingItems 并发           | inflight dedup                            |
| 库弃维                        | 核心用法简单，可 fork 或退回自建          |

## 实施步骤

### 任务 1：共享协议与后端目录 API

- 新增 TerminalPreviewTreeEntry、TerminalPreviewDirectoryResponse 类型
- 新建 listPreviewDirectory（一层 readdir + 过滤 + 排序 + limit）
- 新增路由 GET /preview/directory
- 新增前端 service wrapper

验证：

```bash
pnpm --filter ./backend exec vitest run src/routes/terminal.test.ts
pnpm --filter ./backend typecheck
pnpm --filter ./packages/shared typecheck
```

### 任务 2：前端 react-complex-tree 集成

- pnpm add react-complex-tree
- 新建 use-terminal-file-tree.ts（items map、viewState、懒加载、revealFile）
- 新建 terminal-file-tree-item.tsx（renderItem + 自定义 onClick）
- 新建 terminal-file-tree.tsx（ControlledTreeEnvironment）
- 新建 terminal-file-explorer.tsx（Explorer tab 容器）

验证：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
```

### 任务 3：左栏 tab bar + 宽度 + store

- terminal-preview-panel-content.tsx 加 tab bar（Explorer / Open）
- 宽度 180→240
- preview-store.ts 增加 fileExplorerTab、expandedFileTreePaths、selectedExplorerPath
- use-terminal-preview-panel-data.ts 接入 directory service

验证：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
```

### 任务 4：Reveal + rename/delete 树一致性

- 打开文件后调用 revealFile
- rename/delete 成功后刷新父目录 children
- 项目 path 变化清空 items map

验证：

```bash
pnpm --filter ./frontend typecheck
```

### 任务 5：E2E + 手工回归

- Playwright E2E：展开目录、打开文件、Reveal、截断提示
- 确认已有 terminal-preview E2E 不回归（Open tab 行为不变）

手工回归：

- Explorer：根目录 → 展开多层 → 单击文件 → Reveal → 键盘导航 → Enter → 右键 Rename/Delete → 未保存切文件弹确认
- Open tab：空查询 changed files → 搜索 → 绝对路径只读打开 → 行为不变

## 验收标准

- 进入 file mode 默认显示 Explorer tab 根目录树
- 展开目录只触发一层 children 请求
- 文件打开经过 confirmDiscardDraft 保护
- 键盘↑↓不触发文件打开
- Open tab 所有现有行为不回归
- 打开文件后 Explorer 自动 Reveal
- 大目录截断提示
- react-complex-tree 键盘导航可用
- 不做任何搜索
- 不新增前端单测
