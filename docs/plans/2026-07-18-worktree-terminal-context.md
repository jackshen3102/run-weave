# Worktree Terminal Context 实施计划

> 状态：待实施
> 粒度：L2（跨 shared、backend、frontend、Agent Team 与持久化）
> 交互基准：`docs/prototypes/worktree-terminal-context/`
> 配套用例：`docs/testing/terminal/worktree-terminal-context-test-cases.md`

## 目标

在现有 Terminal 的 Project 下增加一层 Worktree 上下文。Project 仍由顶部标签切换；Project 下方左侧是可折叠的 Worktree 列表，右侧是该 Worktree 的完整 Terminal 区域（Terminal tabs、Terminal 与 Preview）。

切换 Worktree 必须一次性切换以下上下文：

- 当前 Terminal 列表与恢复的 Terminal；
- 新建 Terminal 的启动目录；
- Preview 的 Files、Explorer、Changes、Diff 与文件写操作根目录；
- 从当前 Terminal 发起的 Agent Team 项目根目录。

## 已冻结的产品规则

1. Worktree 列表是平铺列表，不是树。
2. 第一项是当前 Project 根目录对应的主节点。它由 `isPrimary` 明确标识，始终存在、始终排第一、不可取消固定，也没有删除入口。
3. 其他节点只发现 `<project.path>/.worktree/` 下被 Git 登记的 Worktree，不展示同一 Git 仓库位于其他目录的 Worktree。
4. Worktree 由磁盘与 Git 自动发现、自动消失；产品不提供新增、删除或 `...` 菜单。
5. 每项只显示两行：第一行是 Worktree 名称，第二行是实际分支。名称来自相对 `.worktree` 的目录名，允许与分支名不同。
6. Worktree 列表不显示 diff 文件、变更数或 clean 状态。文件变更只在右侧 Preview 的 Changes 中出现。
7. 主节点之后，用户固定的 Worktree 优先；未固定项按所属 Terminal 最近活跃时间倒序排列，再按名称稳定排序。
8. Worktree 栏可以折叠为窄栏，并保留原位置的展开按钮；折叠偏好在同一浏览器中持久化。
9. 切换 Project 时恢复该 Project 上次选择的 Worktree；切换 Worktree 时恢复该 Worktree 上次选择的 Terminal 和 Preview 文件。
10. 已从磁盘移除但仍有存活 Terminal 的 Worktree 暂时保留为 `missing` 节点，只允许访问已有 Terminal；最后一个 Terminal 关闭后自动消失。

## 非目标

- 不在 Runweave 内执行 `git worktree add/remove/prune/repair`。
- 不提供 Worktree 重命名、拖拽排序、手动刷新或删除前 commit 流程。
- 不在左侧列表展示 ahead/behind、dirty count、文件 diff 或提交入口。
- 不改变现有 Project 的新增、编辑、删除语义；“主节点不可删除”不等于禁止用户移除 Project 注册。
- 首期不为 Ionic App 增加 Worktree rail；移动监看模式继续使用现有紧凑布局，并落在 Project 主节点。
- 不照搬原型的静态数据或样式代码；原型只定义布局和交互结果。

## 当前代码与差异

| 领域                   | 当前事实                                                                                                | 需要补齐                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Project / Session 合约 | `packages/shared/src/terminal/project.ts` 只有 Project；`session.ts` 只有 `projectId` 与 `cwd`          | 新增 Worktree 合约；Session 记录稳定的 `worktreeId` 与创建时 Worktree 根目录                 |
| 后端存储               | `backend/src/terminal/store.ts`、`manager-records.ts` 按 Project 保存 Session                           | Project 保存固定 Worktree ID 顺序；Session 保存可选 Worktree 归属，兼容旧数据                |
| Session 创建           | `terminal-session-route-helpers.ts` 从 Project path、继承 Session 或显式 cwd 解析目录                   | 新 UI 传 `worktreeId`；后端验证归属并使用 Worktree root，继承链保持同一 Worktree             |
| Preview                | `terminal-preview-routes.ts` 全部以 `project.path` 为根；缓存键只含 `projectId`                         | API、缓存、前端 query/store 全部加入 Worktree 上下文，避免跨 Worktree 串文件                 |
| Terminal UI            | `terminal-workspace-shell.tsx` 依次渲染 Project header、Session tabs、Stage                             | Project header 下改为“Worktree rail + 右侧完整 Terminal 区域”两个平级列                      |
| 选择状态               | `workspace-store.ts` 只有一个 `activeProjectId` / `activeSessionId`；recent selection 只按 Project 保存 | 增加 `activeWorktreeId`，按 Project 记 Worktree、按 Worktree 记 Terminal，并提供原子选择动作 |
| Agent Team             | `service-support.ts` 与 `agent-team-paths.ts` 优先使用 Project path                                     | 新 Session 优先使用其 Worktree root；旧 Session 保持 Project path 回退                       |

## 目标模型

```text
Project
├─ Primary Worktree（project.path，永久第一）
└─ Discovered Worktree（project.path/.worktree/**）
   └─ Terminal Session（归属于一个 Worktree）
      ├─ Terminal / Panels
      ├─ Preview context
      └─ Agent Team context
```

### Worktree 标识与发现

- 新增 `packages/shared/src/terminal/worktree.ts`。
- `worktreeId` 由 `SHA-256(projectId + "\0" + canonicalPath)` 的固定前缀生成；分支切换不会改变 ID，路径改变视为新 Worktree。
- 主节点直接来自 Project，不依赖 `git worktree list` 是否包含它；`isPrimary=true`、`pinned=true`、`pinOrder=-1`。
- 其他节点使用 `git -C <project.path> worktree list --porcelain -z` 解析，并用 `realpath + path.relative` 只保留 `.worktree` 根内的路径，不能用字符串前缀判断目录包含关系。
- `name` 使用相对 `.worktree` 的路径；`branch` 去掉 `refs/heads/`。detached HEAD 显示 `detached @ <shortHead>`，非 Git 或路径不可用时返回明确 availability，不伪造 `main`。
- 前端仅对当前 Project 查询，页面可见时每 3 秒刷新一次，并在窗口重新聚焦时立即刷新。一次刷新只执行 Worktree 列表命令，不计算 dirty count。

建议合约：

```ts
export type TerminalWorktreeAvailability =
  | "available"
  | "path_unavailable"
  | "missing";

export interface TerminalWorktreeListItem {
  worktreeId: string;
  projectId: string;
  name: string;
  branch: string | null;
  head: string | null;
  path: string | null;
  isPrimary: boolean;
  pinned: boolean;
  pinOrder: number | null;
  availability: TerminalWorktreeAvailability;
}
```

### Session 归属

- `CreateTerminalSessionRequest` 增加可选 `worktreeId`。
- `TerminalSessionListItem`、status/history 所需 Session payload 增加可选 `worktreeId` 与 `worktreePath`；持久化字段保持可选，旧数据无需批量重写。
- 解析优先级：显式 `worktreeId` → 被继承 Session 的 Worktree → 显式 cwd 所在的已发现 Worktree → 主节点。
- 新 UI 创建 Terminal 时必须传当前 `worktreeId`，后端以 Worktree root 为默认 cwd。若同时传 cwd，cwd 必须位于该 Worktree 内，否则返回 400。
- 旧客户端未传 `worktreeId` 且 cwd 位于 Project 外时继续允许创建，记录为空并在 Web 中兼容归入主节点；新 UI 不产生这种 Session。
- 外部移除 Worktree 后，后端根据仍存活 Session 的 `worktreeId/worktreePath` 合成 `missing` 节点。该节点不能新建 Terminal，也不能打开 Preview；已有 Terminal 仍可访问。

### 固定与排序

- `PersistedTerminalProjectRecord` 增加 `pinnedWorktreeIds?: string[]`，数组顺序就是固定顺序。
- 主节点不写入该数组；响应层强制其永久固定。
- UI 排序固定为：主节点 → 固定节点（按 `pinOrder`）→ 非固定节点（按该 Worktree 最大 `session.lastActivityAt` 倒序，再按 name）。
- 固定操作采用乐观更新；请求失败回滚并复用现有 `requestError` 展示。

### Preview 上下文

- 现有 `/api/terminal/project/:id/preview/*` 路径保持不变，新增 `worktreeId` query 参数；省略时兼容主节点。
- 后端先解析并校验 Worktree，再把其 path 作为所有 search/read/save/delete/rename/directory/changes/diff/reset 的唯一根目录。
- Preview 响应新增 `worktreeId` 与 `worktreePath`；现有 `projectPath` 暂时保留为兼容字段，其值同解析后的根目录。
- 搜索候选缓存、TanStack Query key 与 Zustand Preview state 均按 `projectId + worktreeId` 隔离。
- 主节点的 Files/Explorer 搜索显式忽略 `.worktree/`，避免把其他 Worktree 的文件混入当前结果；Changes 列表也过滤 `.worktree/` 容器路径。

## API 合约

| 方法                    | 路径                                                     | 行为                                                     |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `GET`                   | `/api/terminal/project/:projectId/worktrees`             | 返回主节点、自动发现节点与必要的 missing 节点            |
| `PATCH`                 | `/api/terminal/project/:projectId/worktrees/:worktreeId` | 仅接受 `{ "pinned": boolean }`；对主节点取消固定返回 409 |
| `POST`                  | `/api/terminal/session`                                  | 接受可选 `worktreeId`，并按 Session 归属规则解析 cwd     |
| `GET/POST/PATCH/DELETE` | `/api/terminal/project/:id/preview/*?worktreeId=...`     | 在指定 Worktree 根内执行现有 Preview 操作                |

所有接口继续位于现有 `requireAuth` 之后。伪造其他 Project 的 Worktree ID 返回 404；Worktree 已缺失且操作要求可用目录时返回 409；路径逃逸继续返回 400/403，不能退回 Project path 执行。

## 实施任务

### 1. Shared 合约与向后兼容存储

修改：

- `packages/shared/src/terminal/worktree.ts`（新增）
- `packages/shared/src/terminal/session.ts`
- `packages/shared/src/terminal/preview.ts`
- `packages/shared/src/terminal-protocol.ts`
- `backend/src/terminal/store.ts`
- `backend/src/terminal/lowdb-store-base.ts`
- `backend/src/terminal/lowdb-store.ts`
- `backend/src/terminal/manager-records.ts`
- `backend/src/terminal/manager-base.ts`
- `backend/src/terminal/manager.ts`
- `backend/src/terminal/application/payloads.ts`

工作：

- 增加 Worktree 类型与导出。
- 为 Project 增加可选固定列表，为 Session 增加可选 Worktree 归属字段。
- 读取旧 LowDB 数据时默认空固定列表、空 Worktree 字段；写回时只增量补字段，不做一次性破坏性迁移。
- `toSessionListItem` 保持旧 Session 可序列化，新 Session 返回完整归属。

验证：`pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`。

### 2. Worktree 发现、固定 API 与 Session 创建

新增/修改：

- `backend/src/terminal/worktree-service.ts`（新增）
- `backend/src/routes/terminal-worktree-routes.ts`（新增）
- `backend/src/routes/terminal-session-route-helpers.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/bootstrap/runtime-services.ts`
- `backend/src/index.ts`
- `frontend/src/services/terminal.ts`
- `frontend/src/features/terminal/queries/terminal-query-keys.ts`
- `frontend/src/features/terminal/queries/terminal-workspace-queries.ts`

工作：

- 实现 Git porcelain `-z` 解析、真实路径边界校验、主节点合成与 missing 节点合成。
- 注册 list/pin API；固定数组更新通过现有 Store/Manager 串行持久化。
- Session 创建和继承接入 Worktree 校验与 cwd 解析；事件中现有 `session` payload 自然携带归属。
- 新增按当前 Project 启用的 Worktree query，3 秒轮询且窗口聚焦立即刷新；鉴权失败沿用 `onAuthExpired`。

验证：使用临时 Git 仓库创建“项目根 + `.worktree/name` + 仓库外 Worktree”，确认 API 只返回前两者，且名称与分支分别正确。

### 3. Preview 与 Agent Team 使用同一 Worktree root

修改：

- `backend/src/routes/terminal-preview-routes.ts`
- `backend/src/terminal/preview*.ts`
- `backend/src/terminal/preview-search-candidates.ts`
- `backend/src/terminal/preview-directory.ts`
- `backend/src/agent-team/service-support.ts`
- `backend/src/agent-team/service-export.ts`
- `backend/src/agent-team/storage/agent-team-paths.ts`
- 其他调用 `resolveProjectRoot(..., session.cwd)` 的 `backend/src/agent-team/service-*.ts`
- `frontend/src/services/terminal-preview.ts`
- `frontend/src/features/terminal/queries/terminal-preview-queries.ts`
- `frontend/src/features/terminal/queries/terminal-query-keys.ts`
- `frontend/src/features/terminal/preview-store-types.ts`
- `frontend/src/features/terminal/preview-store.ts`
- `frontend/src/components/terminal/terminal-preview-panel*.tsx`
- `frontend/src/components/terminal/use-terminal-preview-panel-data.ts`

工作：

- 提供一个后端统一的“Project + Worktree → 可用根目录”解析入口，所有 Preview 路由复用，禁止各路由自行回退。
- 把后端搜索缓存与前端 query/store 从 Project key 改为 Worktree context key。
- 切换 Worktree 后恢复其独立 Preview mode、selected path 与打开文件；请求迟到时不能覆盖新上下文。
- Agent Team 的验收文件、`.runweave/agent-team` 与 worker cwd 对新 Session 使用 `worktreePath`；旧 Session 继续沿用现有 Project path 行为。

验证：在两个 Worktree 放置同名但内容不同的文件，连续切换并读取/编辑/查看 Changes，确认响应、缓存和 UI 均不串根；从次级 Worktree 发起 Agent Team 时产物落在该 Worktree。

### 4. Workspace 原子选择与 Worktree rail

新增/修改：

- `frontend/src/components/terminal/terminal-worktree-rail.tsx`（新增）
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/terminal-workspace-content.tsx`
- `frontend/src/components/terminal/terminal-workspace-actions.ts`
- `frontend/src/components/terminal/terminal-workspace-effects.ts`
- `frontend/src/components/terminal/terminal-workspace-events.ts`
- `frontend/src/components/terminal/terminal-session-tab-strip.tsx`
- `frontend/src/features/terminal/workspace-store.ts`
- `frontend/src/features/terminal/recent-selection.ts`

工作：

- 在 `TerminalWorkspaceHeader` 下增加左右两列：左列 Worktree rail，右列包含原有 Session tab strip 与 `TerminalWorkspaceStage`。
- Rail 展开宽度与折叠宽度以原型为基准（约 236px / 36px）；折叠键保持原位置，偏好使用独立 localStorage key。
- 主节点渲染非交互的永久固定标记；其他节点使用明确 pin button，不出现 `...`、Add 或 Delete。
- 每个节点第一行 `name`、第二行 `branch/detached/unavailable`；不读取或展示 dirty count。
- 在 Zustand 中增加原子 `selectWorkspaceContext`，一次提交 Project、Worktree、Session，避免中间帧把旧 Session 配到新 Preview。
- recent selection 兼容读取旧结构，并新增 `worktreeIdByProjectId` 与 `sessionIdByWorktreeId`。
- Project/Worktree/Session 切换、创建/关闭 Session、terminal event catchup、initial session deep link 均通过同一选择函数收敛。
- desktop 显示 rail；mobile monitor 不渲染 rail，保持主节点兼容行为。

验证：连续执行 Project → Worktree → Terminal 切换，DOM 中 active 状态唯一，Terminal cwd 与 Preview root 始终属于同一 Worktree；刷新后恢复选择和折叠状态。

### 5. E2E、架构文档与索引

新增/修改：

- `frontend/tests/worktree-terminal-context.spec.ts`（新增 Playwright E2E，不新增 unit test）
- `docs/architecture/terminal-worktree-context.md`（新增）
- `docs/architecture/terminal-code-preview.md`
- `docs/architecture/terminal-state.md`
- `docs/testing/terminal/worktree-terminal-context-test-cases.md`
- `docs/README.md`

工作：

- E2E 在临时目录初始化真实 Git repo，并创建名称与分支不同的 `.worktree` fixture；不依赖开发者现有仓库。
- 覆盖主节点、自动发现/移除、固定排序、折叠、选择恢复、Session cwd、Preview 隔离与无新增/删除入口。
- 更新架构文档，把 Preview 的权威根从“Project path”改为“选中 Worktree path”，并记录旧 Session 回退。
- 使用配套用例文档完成真实浏览器与 API 验收。

## 兼容、回滚与风险

### 兼容

- 旧 LowDB 记录没有 Worktree 字段时按主节点展示，不要求离线迁移。
- 旧客户端不传 `worktreeId` 时保持原 Session 创建能力；新字段均为增量字段。
- Preview API 省略 `worktreeId` 时仍访问主节点，避免旧客户端立即失效。
- 现有 Project 删除、Terminal WebSocket、Panel、TerminalState 与 Quick Input 协议不改变。

### 回滚

- 前端 rail 可独立回滚；后端新增的可选字段会被旧代码忽略。
- 不删除 `pinnedWorktreeIds` 或 Session Worktree 字段，避免回滚后再升级丢失用户偏好。
- 本功能不执行 Git 写操作，因此回滚不会改变用户 Worktree 或提交历史。

### 高风险点

- **跨 Worktree 写错文件**：所有 Preview 写路由必须先解析同一 Worktree context，不能只在读路由加参数。
- **异步串上下文**：query key 和 Preview store 若仍只用 Project ID，会出现旧响应覆盖新 Worktree；必须成组修改。
- **Git 仓库泄漏**：`git worktree list` 会返回同一 common git dir 的全部 Worktree；必须按 `.worktree` 真实路径过滤。
- **活动 Terminal 丢入口**：外部删除 Worktree 时不能直接隐藏仍运行的 Session；使用 missing 节点保留入口。
- **Agent Team 写回主 Project**：不能继续无条件优先 `project.path`，新 Session 必须使用持久化的 `worktreePath`。

## 验收标准

以下条件必须同时满足：

1. 主节点永远第一、不可取消固定、没有删除入口；其他节点可固定并在刷新/重启后保留。
2. Worktree 行只显示名称与分支，不显示 diff、变更数或 clean。
3. `.worktree` 内 Git Worktree 在 3 秒刷新窗口内自动增减；仓库外 Worktree 不进入列表。
4. Worktree 切换后，Session tabs、新建 Terminal cwd、Preview Files/Changes 与 Agent Team root 指向同一目录。
5. Project、Worktree、Terminal、Preview 与折叠选择在刷新和切换后按规则恢复，且不存在短暂串根。
6. 旧存储、旧 Session 与未传 `worktreeId` 的旧请求仍可使用主节点路径。
7. `pnpm typecheck`、`pnpm lint`、目标 E2E 与 `git diff --check` 全部通过。
8. 使用 `$toolkit:playwright-cli` 在真实浏览器完成 `docs/testing/terminal/worktree-terminal-context-test-cases.md` 中的 P0 Web 用例并保存 DOM/截图证据；静态检查不能替代该步骤。
