# Worktree Terminal Context 实施计划

> 状态：待实施
> 粒度：L2（跨 shared、backend、frontend、App、Agent Team 与持久化）
> 交互基准：`docs/prototypes/worktree-terminal-context/`
> 配套用例：`docs/testing/terminal/worktree-terminal-context-test-cases.md`

## 决策摘要

Worktree 不作为 Project 之外的第二套业务身份，而是父 Project 下的子 Project。系统始终只向业务链路传一个当前生效的 `projectId`：

```text
effectiveProjectId = childProjectId ?? parentProjectId
```

- 顶部 Project tab、Project CRUD、默认 Project 和 Worktree 发现使用父 Project ID。
- Worktree 列表第一项就是父 Project 本身，不创建额外的主 Worktree ID。
- 其他 Worktree 使用父 Project ID 与 Worktree 名称确定性生成子 Project ID。
- Terminal、Preview、Agent Team、Activity、Quick Input、Prototype 等操作只使用 `effectiveProjectId`。
- `parentProjectId` 仅用于 UI 导航、归属、父级状态聚合和删除级联，不作为业务请求的第二个上下文参数。

这意味着本功能不新增 `worktreeId` 或 `worktreePath`，不改 Preview API 形状，也不改 Session 的持久化结构。

## 目标

在现有 Terminal 的父 Project 下增加一组可切换的 Project context：第一项是父 Project 根目录，后续项是 `<parent.path>/.worktree/` 下被 Git 登记的 Worktree 子 Project。

切换列表项后，以下能力必须同时使用该行的 `projectId`：

- 当前 Terminal 列表与恢复的 Terminal；
- 新建、继承 Terminal 的默认 cwd；
- Preview Files、Explorer、Changes、Diff 与文件写操作；
- Agent Team 计划、用例、run、outbox 和 worker cwd；
- Activity、Quick Input、Prototype 与 App Server project scope。

## 已冻结的产品规则

1. 顶部仍是父 Project tabs；父 Project 下方左侧是可折叠的 Worktree 平铺列表，右侧是完整 Terminal 区域。
2. 第一项是当前父 Project 根目录，`projectId === parentProjectId`，始终存在、始终第一、不可取消固定，也没有删除入口。
3. 其他项只发现 `<parent.path>/.worktree/<name>` 下被 Git 登记的直接子 Worktree；同一仓库位于其他目录的 Worktree 不展示。
4. Worktree 由磁盘与 Git 自动发现、自动消失；产品不提供新增、删除、重命名或 `...` 菜单。
5. 每项只显示两行：第一行是 Worktree 名称，第二行是实际分支；名称与分支允许不同。
6. 列表不显示 diff 文件、变更数、clean、ahead/behind 或提交入口。
7. 第一项之后，用户固定的子 Project 优先；未固定项按所属 Terminal 最近活跃时间倒序排列，再按名称稳定排序。
8. Worktree 栏可折叠为窄栏，折叠偏好在同一浏览器中持久化。
9. 切换父 Project 时恢复该父 Project 上次选中的生效 Project；切换列表项时恢复该生效 Project 上次选中的 Terminal 和 Preview 状态。
10. 外部移除但仍被存活 Terminal 引用的子 Project 暂时显示为 `missing`；已有 Terminal 可访问，所有需要目录的新操作被拒绝，最后一个 Terminal 关闭后节点消失。

## 非目标

- 不在 Runweave 内执行 `git worktree add/remove/prune/repair`。
- 不给业务接口同时传父 Project ID 与子 Project ID。
- 不增加 `worktreeId`、`worktreePath` 或 Preview 复合上下文字段。
- 不改变 Activity、Quick Input 的精确 Project scope；父 Project 不隐式汇总子 Project 数据。
- 不在首期为 Ionic App 增加 Worktree rail；App 只需正确分组并打开已有子 Project Terminal。
- 不照搬原型代码到产品；原型只冻结布局、文案和用户动作。

## 原型交接

- 原型目录：`docs/prototypes/worktree-terminal-context/`
- 启动命令：`python3 -m http.server 6188 --directory docs/prototypes/worktree-terminal-context`
- 最终截图：`docs/prototypes/worktree-terminal-context/prototype-preview.png`
- 最终交互：顶部父 Project tabs；左侧可折叠 Worktree 列表；右侧完整 Session tabs、Terminal 与 Preview。
- 产品核心功能：自动发现、父/子 Project 切换、主节点永久第一、子节点固定、列表折叠、Terminal/Preview 联动。
- 原型辅助功能：无可见辅助控件；静态 mock 数据不进入产品实现。
- 放弃方向：双层上下文条、扁平上下文 tabs、紧凑选择器、Terminal 自带上下文，以及独立 `worktreeId` 数据模型。

本轮数据模型调整不改变可见布局，所以现有截图继续作为视觉基准；原型内部 mock 已改为 `activeParentProjectId + activeProjectId`，其中后者是唯一生效 ID。

## 当前代码事实与差异

| 领域                                       | 当前事实                                                                        | 本次差异                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Project / Session                          | `TerminalSessionRecord` 和所有 Session payload 已只保存一个 `projectId`         | 让 `projectId` 可指向父 Project 或 Worktree 子 Project；Session 不加字段                      |
| Session 创建                               | `resolveTerminalCreateDefaults` 已通过 `getProject(projectId).path` 解析 cwd    | `getProject` 能解析可用子 Project；missing 子 Project 返回 409                                |
| Preview                                    | 路由、响应、缓存、TanStack Query 和 Zustand 均按 `projectId` 隔离               | API 与 store 形状不改；`:id` 直接传生效 Project ID                                            |
| Agent Team                                 | 路径解析已优先使用 `getProject(projectId).path`                                 | 可用子 Project 自动生效；run 恢复、recheck 等枚举改为全部 contexts；missing 禁止 cwd fallback |
| Activity / Quick Input                     | 已按 `projectId` 精确过滤                                                       | 不改 schema 与查询语义，子 Project 天然隔离                                                   |
| Workspace                                  | `activeProjectId` 同时驱动 Session、Preview、Agent Team；顶部 tabs 也直接使用它 | 保留其业务含义，新增仅供父级导航的 `activeParentProjectId`                                    |
| App Home                                   | 返回父 Projects 和所有 Sessions，App 按 `session.projectId` 直接分组            | 用共享 ID helper 把子 Session 分组到父 Project，打开时仍传子 ID                               |
| Work History / Prototype / Agent Team 恢复 | 多处只遍历 `listProjects()`                                                     | 需要显式遍历全部可用 Project contexts                                                         |
| Project 删除                               | 只删除 `session.projectId === parentProjectId` 的 Session                       | 删除父 Project 时级联所有子 Project Session                                                   |

## 目标模型

```text
Parent Project（现有 Project，顶部 tab）
├─ Primary context
│  ├─ projectId = parentProjectId
│  └─ path = parent.path
└─ Worktree child Project
   ├─ projectId = buildChildProjectId(parentProjectId, worktreeName)
   ├─ parentProjectId = parent.id
   ├─ path = parent.path/.worktree/worktreeName
   └─ Terminal Session
      ├─ session.projectId = childProjectId
      ├─ Preview projectId = childProjectId
      └─ Agent Team projectId = childProjectId
```

### 子 Project ID

格式固定为：

```text
wt:<base64url(utf8(parentProjectId))>:<base64url(utf8(normalizedWorktreeName))>
```

规则：

- `normalizedWorktreeName` 是 `.worktree` 下直接子目录名的 Unicode NFC 规范化结果。
- 父 ID 和名称分别编码，禁止未经编码的字符串拼接。
- 分支切换不改变 ID；Worktree 目录重命名产生新 ID。
- build/parse helper 放在 shared，backend、frontend 和 App 使用同一实现。
- parse 后必须重新 build 并完全相等，拒绝非规范编码、空名称和多余分隔段。
- ID 只提供身份，不授予文件访问权；backend 仍用 Git 登记结果、`realpath` 和 `path.relative` 验证目录归属。

### Project context 合约

新增 `packages/shared/src/terminal/project-context.ts`：

```ts
export type TerminalProjectContextAvailability =
  | "available"
  | "path_unavailable"
  | "missing";

export interface TerminalProjectContextListItem {
  projectId: string;
  parentProjectId: string;
  name: string;
  branch: string | null;
  head: string | null;
  path: string | null;
  isPrimary: boolean;
  pinned: boolean;
  pinOrder: number | null;
  availability: TerminalProjectContextAvailability;
}
```

主节点也用此响应类型，但它的 `projectId` 等于 `parentProjectId`。业务 Session、Preview、Agent Team 合约继续只含 `projectId`。

### Backend registry 语义

Terminal Manager 保留现有父 Project map，并新增子 Project context registry：

- `listProjects()`：只返回父 Project，语义和旧客户端保持不变。
- `getProject(projectId)`：返回父 Project 或 `available` 子 Project；供现有业务代码解析路径。
- `getProjectContext(projectId)`：返回父、available、path_unavailable 或 missing context；供 UI、错误分类和父子归属使用。
- `listProjectContexts(parentProjectId)`：返回一个父 Project 的主节点与子节点。
- `listAllProjectContexts()`：返回所有父 Project 与 `available` 子 Project，供 Agent Team 恢复、Work History、Prototype Gallery 等后台枚举；missing 只通过 `getProjectContext` 和单父列表读取。
- `resolveParentProjectId(projectId)`：父 ID 原样返回，规范子 ID 返回其父 ID，未知格式返回原值。

registry 不把子 Project 写进普通 `projects` 数组，避免污染 Project tabs、默认 Project、Project CRUD 和旧客户端。父 Project 记录只增加 `pinnedChildProjectIds?: string[]`。

### 发现与 missing 收敛

- backend 初始化父 Projects 与 Sessions 后，对每个有 path 的父 Project 执行一次 Worktree 发现。
- 使用 `git -C <parent.path> worktree list --porcelain -z`，只保留 realpath 位于 `<parent.path>/.worktree/` 直接子目录下的记录。
- 当前父 Project 的 contexts API 每 3 秒由前端刷新一次，窗口重新聚焦时立即刷新；一次刷新只读取 Worktree 列表，不计算 dirty count。
- 每次刷新先写入 Git 发现的子 Project，再根据现有 Session 中可解析的子 Project ID 合成 missing 节点。
- `getProject` 不把 missing 当成可操作 Project；Preview、Session create、Agent Team 等通过 `getProjectContext` 区分 malformed/not found 的 404 与 missing/unavailable 的 409。
- 禁止 missing 子 Project 静默回退父 Project path 或 Session 当前 cwd。

## API 合约

| 方法                   | 路径                                                              | 行为                                                                        |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET`                  | `/api/terminal/project/:parentProjectId/contexts`                 | 返回主节点、Git 发现的子 Project 与必要的 missing 节点                      |
| `PATCH`                | `/api/terminal/project/:parentProjectId/contexts/:childProjectId` | 仅接受 `{ "pinned": boolean }`；主节点或不属于父 Project 的 ID 返回 404/409 |
| `POST`                 | `/api/terminal/session`                                           | 继续使用现有 `projectId`；传子 ID 时 cwd 默认到 Worktree root               |
| Preview 全部方法       | `/api/terminal/project/:effectiveProjectId/preview/*`             | 路径不变，不新增 query；按生效 ID 解析唯一根目录                            |
| Agent Team             | 现有 `/api/agent-team/*`                                          | 请求和 run 继续只保存生效 `projectId`                                       |
| Activity / Quick Input | 现有接口                                                          | `projectId` 保持精确匹配，不隐式扩展父子集合                                |

所有新接口继续位于现有 `requireAuth` 之后。非法编码、跨父 Project ID 返回 404；已知但不可用的 context 返回 409；路径逃逸继续返回现有 400/403。

## Workspace 状态

Zustand 使用三个原子选择字段：

```ts
activeParentProjectId: string | null; // 顶部 tab 与父 Project CRUD
activeProjectId: string | null; // 唯一 effectiveProjectId
activeSessionId: string | null;
```

- `activeProjectId` 继续直接传给 Session 过滤、创建、Preview、Agent Team、Quick Input 和 Prototype。
- 切换父 Project：读取 `contextProjectIdByParentProjectId[parentId]`，无有效记录时选主节点，即父 ID。
- 切换 Worktree 行：原子更新父 ID、生效 ID 和该生效 ID 的首选 Session。
- recent selection 保留现有 `projectSessionIds`，其 key 改为明确的生效 Project ID；新增 `contextProjectIdByParentProjectId`。
- Preview store 已按 `projectId` 分桶，无需改结构；迟到请求由既有 query key 自然隔离。
- 顶部 Project tab 状态通过 shared `resolveParentProjectId(session.projectId)` 聚合子 Project Session。

## 跨模块兼容

### Session 与 Preview

- 旧 Session 的 `projectId` 是父 ID，天然落在主节点，无需迁移。
- 新 Session 的 `projectId` 可以是子 ID，LowDB 结构不变。
- Session inherit 沿用被继承 Session 的 `projectId`，因此自动留在同一 context。
- Preview response、缓存、query 和 Zustand key 不改；不同父/子 Project ID 天然隔离。
- 主节点 Files/Explorer 搜索继续排除 `.worktree/` 容器，避免把子 Project 文件混入父根结果。

### Agent Team

- `resolveProjectRoot` 和 `AgentTeamPaths` 继续从 `getProject(projectId).path` 取得可用子 Project root。
- 对可解析但 missing 的子 ID，统一返回 409，不能 fallback 到 cwd 或父 path。
- `AgentTeamRunStore.getRun`、startup/recheck watchdog、checkpoint 占用扫描和 Work History run 列表改用 `listAllProjectContexts()`。
- run、outbox、验收文件和 worker cwd 继续只记录生效 `projectId`。

### Activity、Quick Input 与 App Server

- Activity fact、查询、导出和删除继续按精确 `projectId`；父 ID 与子 ID 数据相互隔离。
- Project-scoped Quick Input 继续按精确 `projectId`；全局项仍对父、子 Project 可见。
- App Server ownership 对 available 子 Project 通过 `getProject` 判定；带 Terminal Session ID 的 missing Terminal 事件继续由 Session ownership 接收。

### App Home、Work History 与 Prototype

- App Home 仍返回父 Project 列表；App 使用 shared ID helper 将子 Session 分组到父 Project，打开 Terminal 后仍使用 Session 的子 ID。
- Work History 的 Agent Team run 枚举使用全部 available contexts；Terminal 标题通过 `getProjectContext(session.projectId)` 兼容 missing context。
- Prototype Gallery 扫描全部 available contexts；从子 Project 打开的 preview ticket 继续携带子 ID 并限定在 Worktree path。

### 父 Project 修改与删除

- 修改父 Project path 后清空其子 registry、相关 Preview cache，并重新发现；旧子 Session 暂时进入 missing，禁止目录操作。
- 删除父 Project 前解析其全部 context IDs，停止 runtime、unwatch/kill tmux 并删除所有对应 Sessions，再删除父 Project 和固定偏好。
- 删除事件的 `terminalSessionIds` 必须包含父、子全部 Session，避免其他消费者残留入口。

## 实施任务

### 1. Shared ID、Context 合约与兼容存储

新增/修改：

- `packages/shared/src/terminal/project-context.ts`（新增）
- `packages/shared/src/terminal/index.ts`
- `packages/shared/package.json`
- `backend/src/terminal/store.ts`
- `backend/src/terminal/manager-records.ts`
- `backend/src/terminal/lowdb-store-base.ts`
- `backend/src/terminal/lowdb-store.ts`

工作：

- 实现 child Project ID build/parse/resolve-parent helper 与 context payload。
- 为父 Project record 增加可选 `pinnedChildProjectIds`，旧数据默认空数组。
- 不给 Session、Preview、Agent Team 合约或存储增加 Worktree 字段。
- LowDB 读取与写入固定列表时保持旧记录兼容，不执行离线迁移。

验证：shared/backend typecheck；用临时 Node 脚本覆盖父 ID、Unicode 名称、非法编码、空名称和 round-trip，脚本不提交为单元测试。

### 2. Worktree 子 Project registry、发现与 API

新增/修改：

- `backend/src/terminal/worktree-project-registry.ts`（新增）
- `backend/src/routes/terminal-project-context-routes.ts`（新增）
- `backend/src/terminal/manager-base.ts`
- `backend/src/terminal/manager.ts`
- `backend/src/bootstrap/runtime-services.ts`
- `backend/src/routes/terminal.ts`
- `frontend/src/services/terminal.ts`
- `frontend/src/features/terminal/queries/terminal-query-keys.ts`
- `frontend/src/features/terminal/queries/terminal-workspace-queries.ts`

工作：

- 实现 Git porcelain `-z` 解析、direct-child realpath 边界校验、branch/detached 解析和 registry 更新。
- backend 启动时初始化全部父 Project；contexts GET 时刷新目标父 Project。
- 根据 Session 的子 Project ID 合成 missing 节点。
- 实现 list/pin API；pin 只持久化到父 Project 的 ID 数组，不执行 Git 写操作。
- 提供 `listProjects/getProject/getProjectContext/listProjectContexts/listAllProjectContexts` 的明确语义。

验证：临时 Git 仓库包含父根、合法 `.worktree/name`、普通同名目录和仓库外 Worktree；API 只返回父根与合法子 Project，ID 可解析回父 ID 与名称。

### 3. 让现有业务链路消费生效 Project ID

修改：

- `backend/src/routes/terminal-session-route-helpers.ts`
- `backend/src/routes/terminal-preview-routes.ts`
- `backend/src/agent-team/service-support.ts`
- `backend/src/agent-team/storage/agent-team-paths.ts`
- `backend/src/agent-team/storage/run-store.ts`
- `backend/src/agent-team/service-lifecycle.ts`
- `backend/src/agent-team/service-recheck.ts`
- `backend/src/work-history/work-history-service.ts`
- `backend/src/routes/terminal-prototype-gallery-routes.ts`
- `backend/src/routes/terminal-project-routes.ts`
- `backend/src/terminal/manager.ts`
- `backend/src/terminal/lowdb-store.ts`

工作：

- Session create/inherit 继续只传 `projectId`，available 子 ID 解析 Worktree cwd，missing 返回 409。
- Preview 所有路由复用同一个 context availability 解析入口；API、响应、缓存和前端 Preview 文件不增加字段。
- Agent Team 对 available 子 ID 使用 Worktree root，对 missing/非法子 ID 拒绝 fallback。
- Agent Team run 恢复、Work History 和 Prototype Gallery 枚举全部 available contexts。
- 父 Project 删除级联父、子全部 Session 与 runtime；父 path 修改触发 registry/cache 重建。

验证：两个 contexts 放置同名不同内容文件；分别创建 Session、读取/写入 Preview、发起 Agent Team、重启 backend 查询 run，确认所有产物只落在请求 `projectId` 对应根目录。

### 4. Workspace 原子选择与 Worktree rail

新增/修改：

- `frontend/src/components/terminal/terminal-worktree-rail.tsx`（新增）
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/terminal-workspace-content.tsx`
- `frontend/src/components/terminal/terminal-workspace-actions.ts`
- `frontend/src/components/terminal/terminal-workspace-effects.ts`
- `frontend/src/components/terminal/terminal-workspace-events.ts`
- `frontend/src/components/terminal/terminal-workspace-header.tsx`
- `frontend/src/components/terminal/terminal-project-tab-bar.tsx`
- `frontend/src/features/terminal/workspace-store.ts`
- `frontend/src/features/terminal/recent-selection.ts`

工作：

- 按原型将父 Project header 下方改为“Worktree rail + 右侧完整 Terminal 区域”。
- Rail 第一项使用父 ID；其他行直接携带子 Project ID，第一行名称、第二行分支。
- 主节点显示不可交互的永久固定标记；其他节点使用明确 pin button，不出现 `...`、Add 或 Delete。
- 增加 `activeParentProjectId`，保留 `activeProjectId` 作为唯一业务 ID；一个原子 action 同时提交父 ID、生效 ID 和 Session。
- contexts query 仅对当前父 Project 启用，3 秒轮询并在窗口聚焦时刷新。
- recent selection 增加 `contextProjectIdByParentProjectId`，复用现有 `projectSessionIds` 保存每个生效 ID 的 Terminal。
- 顶部 Project tab 状态聚合父、子 Session；父 Project 编辑/删除必须使用 `activeParentProjectId`。
- desktop 渲染 rail；App/mobile 不渲染 rail。

验证：父 Project → 子 Project → Terminal 连续切换后，DOM 中父 tab、Worktree 行、Session 各只有一个 active；右侧请求、cwd 和 Preview 始终使用同一 `activeProjectId`；刷新后恢复选择与折叠状态。

### 5. App 分组、文档、E2E 与真实浏览器验收

新增/修改：

- `app/src/lib/terminal-home-view-model.ts`
- `frontend/tests/worktree-terminal-context.spec.ts`（新增 Playwright E2E，不新增 unit test）
- `docs/architecture/terminal-worktree-context.md`（新增）
- `docs/architecture/terminal-code-preview.md`
- `docs/architecture/terminal-state.md`
- `docs/testing/terminal/worktree-terminal-context-test-cases.md`
- `docs/README.md`

工作：

- App Home 使用 shared helper 把子 Session 归入父 Project，但点击后仍携带子 `projectId`。
- E2E 使用临时 Git repo，创建名称与分支不同的 `.worktree` fixture，不依赖开发者现有仓库。
- 覆盖 ID 语义、发现/移除、固定、折叠、选择恢复、Session cwd、Preview 隔离、Agent Team 恢复、父 Project 删除级联、App 分组和精确 Activity/Quick Input scope。
- 架构文档记录父 Project / 子 Project / effective Project 三个术语，明确 Preview 与 Agent Team 不新增 Worktree 参数。
- 使用配套用例完成真实浏览器与 API 验收。

验证：执行必跑命令，并使用 `$toolkit:playwright-cli` 在真实 Runweave Web 页面完成所有 P0 Web 用例；App 分组使用 App 实际页面或对应可执行 view-model 验证取证。

## 验证命令与行为验收

实现完成后按顺序执行，任一失败即停：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/app typecheck
pnpm lint
pnpm --dir frontend test:e2e -- worktree-terminal-context.spec.ts
git diff --check
```

上述静态门禁不能替代行为验收。真实 Runweave 页面必须按仓库 Dev Session 规则启动，并使用 `$toolkit:playwright-cli` 附着正确 surface，完成 `docs/testing/terminal/worktree-terminal-context-test-cases.md` 中的 P0 Web 用例。

## 兼容、迁移与回滚

### 兼容与迁移

- 旧 `projects`、Sessions、Preview、Activity、Quick Input 和 Agent Team 数据无需迁移。
- 旧 Session 的父 `projectId` 就是主节点 ID；旧客户端继续只看到父 Project 并可操作主节点。
- 新增的唯一持久化字段是父 Project 的可选 `pinnedChildProjectIds`。
- Session、Preview 和 Agent Team 接口不增加必填字段，旧请求继续使用父 ID。

### 回滚

- UI rail 可以先隐藏，但 backend 的子 Project resolver 必须保留到所有子 Project Session 关闭或清理，避免旧页面无法解析存量 Session。
- 回滚不能删除 `pinnedChildProjectIds` 或把子 Session 改写为父 ID；这会改变文件与 Agent Team 根目录。
- 功能不执行 Git 写操作，回滚不改变 Worktree 或提交历史。

## 高风险点

- **子 ID 越权访问**：ID 可解码不等于路径可信，必须用 Git 登记与 realpath 归属再次授权。
- **父/子列表语义混淆**：`listProjects()` 不得返回子 Project；需要全部 contexts 的后台调用点必须显式改造。
- **missing 错误回退**：任何文件、Agent Team 或新建 Terminal 操作都不能从 missing 子 ID 退回父 path/cwd。
- **父 Project 删除不完整**：runtime、tmux、Session、Panel、Preview cache 和删除事件必须覆盖所有子 IDs。
- **异步选择串根**：父 tab、Worktree 行、Session 必须原子更新；业务组件只能读取 `activeProjectId`。
- **恢复扫描遗漏**：Agent Team getRun/recheck、Work History、Prototype Gallery 若仍只遍历父 Projects，会丢失子 Project 数据。

## 验收标准

以下条件必须同时满足：

1. 主节点 `projectId === parentProjectId`，永远第一、不可取消固定、没有删除入口。
2. 子 Project ID 由父 ID 与 Worktree 名称规范生成，分支变化不改 ID，非法/跨父 ID 不能访问目录。
3. 列表只显示名称和分支，不显示 diff、变更数或 clean。
4. `.worktree` 内 Git Worktree 自动增减；仓库外 Worktree 不进入列表。
5. 切换后 Session list、新建/继承 cwd、Preview、Agent Team、Activity、Quick Input 和 Prototype 使用同一个生效 `projectId`。
6. Preview API、Session storage 和 Agent Team contract 中不存在新增的 `worktreeId/worktreePath`。
7. backend 重启后能恢复子 Project Session 与 Agent Team run；missing 节点不丢 Terminal，也不允许目录操作。
8. 父 Project 删除级联所有子 Project Session；App Home 和顶部状态正确归组但不改 Session 的子 ID。
9. 旧存储、旧 Session 和只传父 ID 的旧请求继续工作，无离线迁移。
10. 必跑命令全部通过，并使用 `$toolkit:playwright-cli` 完成配套 P0 Web 用例；静态检查不能替代真实行为证据。
