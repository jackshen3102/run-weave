# Worktree Terminal Context 计划评审

> 评审对象：`docs/plans/2026-07-18-worktree-terminal-context.md`
> 评审结论：**需要先改计划，再进入实现。** 推荐把 Worktree 建模为父 Project 下的“子 Project 上下文”，业务链路始终只传一个生效的 `projectId`。

## 结论

用户补充的父子 Project 模型比原计划的独立 `worktreeId` 模型更贴近现有架构，影响面也更小。

统一规则应为：

```text
effectiveProjectId = childProjectId ?? parentProjectId
```

- 顶部 Project tab、Project CRUD、默认 Project 和子项发现使用父 Project ID。
- 主节点没有额外子 ID，直接使用父 Project ID。
- 非主 Worktree 使用由父 Project ID 和 Worktree 名称确定性生成的子 Project ID。
- Terminal、Preview、Agent Team、Activity、Quick Input、Prototype 等业务操作只接收 `effectiveProjectId`。
- `parentProjectId` 只用于归属、分组、父项目删除级联和 UI 导航，不作为一次业务操作的第二套上下文参数。

原计划在 `Session + Preview + Agent Team` 中平行引入 `worktreeId/worktreePath`，会形成两套可能不一致的身份。现有代码已经以 `projectId` 隔离 Terminal、Preview 状态、缓存和 Agent Team 路径，因此不需要再复制一套上下文。

## 代码核对范围

本次按 `projectId` 的产生、存储、枚举、解析和消费链路扫描了 `frontend/src`、`backend/src`、`packages/shared/src` 和 `app/src`，重点核对：

- Shared：Project、Session、Preview、Activity、Agent Team、Work History 合约。
- Backend：Terminal Manager/LowDB、Project/Session/Preview 路由、Activity 查询与删除、Agent Team 路径与 run 枚举、App Server ownership、Work History、App Home、Quick Input、Prototype Gallery。
- Frontend：Workspace store、Project tabs、Session 过滤与恢复、Preview store/query、Agent Team、Quick Input、Prototype Gallery。
- App：Home Project 分组、Terminal 连接和 Preview 请求。

关键事实：

1. Session 已经只持久化一个 `projectId`，创建时会用 `getProject(projectId).path` 解析默认 cwd（`backend/src/routes/terminal-session-route-helpers.ts:101-121`）。
2. Preview 所有路由先通过 `getProject(projectId)` 取得根目录，响应、缓存、前端 query 和 Zustand state 也都按 `projectId` 隔离（`backend/src/routes/terminal-preview-routes.ts:65-123`、`backend/src/terminal/preview-search-candidates.ts:392-469`、`frontend/src/features/terminal/queries/terminal-query-keys.ts:3-40`、`frontend/src/features/terminal/preview-store.ts:98-113`）。
3. Agent Team 的验收文件和落盘路径同样通过 `getProject(projectId).path` 解析（`backend/src/agent-team/service-support.ts:31-43`、`backend/src/agent-team/storage/agent-team-paths.ts:123-131`）。
4. Activity 和 Quick Input 已按 `projectId` 精确隔离，不需要新增 Worktree 维度（`backend/src/activity/database-query.ts:145-164`、`backend/src/terminal/quick-input-service.ts:66-83`）。
5. 真正需要补齐的是父子 Project 的“枚举和归属”：当前 `listProjects()` 被 App Home、Work History、Agent Team 恢复等逻辑视为完整 Project 集合，而 Project 删除只处理与父 ID 完全相等的 Session。

## Findings

### P1：独立 `worktreeId` 会复制现有 Project 上下文并扩大改动面

**位置**：原计划第 45-51、98-117、181-206、230-232 行。

原计划要求：

- Session 额外保存 `worktreeId/worktreePath`；
- Preview API、响应、缓存、query 和 store 同时增加 Worktree 参数；
- Agent Team 再从 Session 的 Worktree 字段解析根目录；
- Workspace 同时维护 `activeProjectId + activeWorktreeId`。

这会产生两个权威身份：`projectId` 和 `worktreeId`。任何漏传、继承失败或状态更新不同步都可能让 Terminal 属于一个 Worktree、Preview 却访问另一个根目录。

**修正方向**：

- 删除 Session、Preview、Agent Team 中新增 `worktreeId/worktreePath` 的任务。
- `CreateTerminalSessionRequest.projectId` 直接接收生效 Project ID。
- `TerminalSessionRecord.projectId` 继续保存唯一上下文 ID。
- Preview 路径与响应保持现状，URL 中的 `:id` 直接传子 Project ID；不增加 query 参数。
- Preview query/store 继续按现有 `projectId` key 工作，天然得到父、子上下文隔离。
- Agent Team 保持现有合约，通过能解析子 Project 的 `getProject(projectId)` 自动落到对应 Worktree。

### P1：必须明确 `listProjects` 与 `getProject` 的不同语义

**位置**：原计划第 53-94、120-129、133-177 行。

如果把子 Project 直接混入现有 `projects` 集合，以下现有行为会一起改变：顶部 Project tabs、默认 Project、Project 排序/编辑/删除、App Home、Prototype Gallery 和旧客户端 Project 列表。反过来，如果子 Project 完全不进入 Manager，Preview、Agent Team、App Server ownership 又无法通过 ID 找到它。

**修正方向**：

- `listProjects()` 保持只返回父 Project，现有 Project CRUD 与旧客户端不变。
- `getProject(projectId)` 能同时解析父 Project 和已登记的子 Project，继续作为所有业务根目录的统一入口。
- 新增 `listProjectContexts(parentProjectId)`：返回父 Project 本身作为第一项，以及该父 Project 下的 Worktree 子 Project。
- 新增 `listAllProjectContexts()`：只给后台恢复、历史枚举和状态聚合使用，不暴露为普通 Project 列表。
- 子 Project 维护在独立的内存 registry 中，不写入父 Project 列表；启动时根据父 Project、Git 和现有 Session 重建。
- 父 Project 记录只增量保存固定的子 Project ID 顺序；无需为每个子 Project 复制一条普通 Project 数据。

建议上下文合约：

```ts
interface TerminalProjectContextListItem extends TerminalProjectListItem {
  parentProjectId: string;
  isPrimary: boolean;
  branch: string | null;
  head: string | null;
  pinned: boolean;
  pinOrder: number | null;
  availability: "available" | "path_unavailable" | "missing";
}
```

主节点的 `projectId === parentProjectId`；子节点的 `projectId` 是生效的子 Project ID。合约中不再出现 `worktreeId`。

### P1：原计划遗漏了所有“枚举 Project”与父项目级联的兼容点

**位置**：原计划第 181-208、255-276 行；尤其是“现有 Project 删除协议不改变”的结论不成立。

已确认的遗漏包括：

- `AgentTeamRunStore.getRun()`、recheck watchdog 和 checkpoint 冲突检测只遍历 `listProjects()`；子 Project 的 run 会写入 Worktree，但重启后无法被找到（`backend/src/agent-team/storage/run-store.ts:41-55`、`backend/src/agent-team/service-recheck.ts:63-89`、`backend/src/agent-team/service-lifecycle.ts:68-84`）。
- Work History 的 Terminal 标题和 Agent Team run 列表只构建父 Project map，子 Project 的名称与 run 会缺失（`backend/src/work-history/work-history-service.ts:74-116`、`:241-249`）。
- App Home 只返回父 Project，并按 `session.projectId` 直接分组；子 Project Session 不会进入任何父 Project 组（`backend/src/routes/app-home-overview.ts:322-327`、`app/src/lib/terminal-home-view-model.ts:41-56`）。
- Project 删除只匹配 `session.projectId === parentProjectId`，不会停止或删除子 Project Session（`backend/src/routes/terminal-project-routes.ts:186-219`、`backend/src/terminal/manager.ts:71-85`、`backend/src/terminal/lowdb-store.ts:106-133`）。
- 顶部 Project 状态徽标按精确 Session Project ID 聚合，子 Project 活动不会显示到父 tab（`frontend/src/features/terminal/workspace-store.ts:79-107`）。

**修正方向**：

- Agent Team 生命周期和 Work History 改用 `listAllProjectContexts()`。
- App Home 的 Session 响应增加只用于分组的 `parentProjectId`；打开 Terminal、Preview 时仍使用原 `projectId`，即子 Project ID。
- 父 Project 删除前先解析全部子 Project ID，停止并删除这些上下文下的 Session，再删除父 Project。
- 前端父 Project 状态聚合使用共享的 `resolveParentProjectId(session.projectId)`，业务操作仍使用 Session 的原始 `projectId`。
- Prototype Gallery 是否按当前 Worktree 展示，遵循“所有操作使用生效 ID”：从子 Project 打开时扫描子 Project 路径；普通 Project 列表仍只显示父 Project。

### P1：子 Project ID 不能使用未经编码的字符串拼接，也不应继续按绝对路径 hash

**位置**：原计划第 65-72 行。

原计划使用 `SHA-256(projectId + canonicalPath)`，与“父 Project ID + Worktree 名称”的新约束不一致；同时，直接拼接原始名称会遇到 `/`、`%`、Unicode 规范化和分隔符冲突。

**修正方向**：

```text
childProjectId = "wt:" + base64url(parentProjectId) + ":" + base64url(normalizedRelativeName)
```

- `normalizedRelativeName` 使用 `.worktree` 下规范化的相对名称；建议首期只允许直接子目录，避免名称和层级语义混在一起。
- ID 能确定性恢复父 Project 和名称，分支切换不改变 ID。
- Worktree 目录重命名产生新 ID，旧 ID 只在仍有存活 Session 时作为 `missing` 上下文保留。
- 解码出的名称不能直接信任；仍必须用 `git worktree list --porcelain -z`、`realpath` 和 `path.relative` 验证归属与目录边界。

### P2：Frontend 应让 `activeProjectId` 表示生效 ID，父 ID 只服务导航

**位置**：原计划第 210-235 行。

当前大量 Terminal、Preview、Agent Team 代码直接消费 `activeProjectId`。如果保留它表示父 Project，再增加 `activeWorktreeId`，所有调用点都必须记得计算二选一，最容易再次形成双上下文。

**修正方向**：

- `activeProjectId` 继续作为所有业务组件消费的唯一 ID，但其含义升级为 `effectiveProjectId`。
- 增加 `activeParentProjectId`，只供顶部 tab、父 Project CRUD 和 Context list query 使用。
- 切换父 Project 或子 Project 时通过一个原子 action 同时更新 `activeParentProjectId`、`activeProjectId` 和 `activeSessionId`。
- `activeProject` 的查找集合从父 `projects` 扩展为“当前父 Project 的 contexts”；父 Project 编辑/删除仍显式查父 `projects`。
- recent selection 继续按生效 `projectId` 保存 Terminal；新增 `contextProjectIdByParentProjectId` 记录每个父 Project 上次选中的生效 ID，不新增 `worktreeIdByProjectId`。
- Preview store 已按 `projectId` 保存文件和 mode，无需结构变更。

### P2：`missing` 节点需要能在重启后重建，但不需要持久化 `worktreePath`

**位置**：原计划第 98-103、259-267、275-276 行。

子 Project ID 已包含父 ID 与规范化名称，现有 Session 又持久化了子 Project ID，因此 backend 重启后可以从 Session 重建 `missing` context；没有必要再在 Session 保存一份可能过期的绝对路径。

**修正方向**：

- registry 刷新时先加入 Git 发现的可用子 Project，再补入仍被 Session 引用但未发现的子 Project 并标记 `missing`。
- `missing` context 的期望路径由父 Project 当前 path 与名称推导，只用于展示和错误判断；不得静默回退父 Project path。
- Terminal 连接仍按 Session ID 访问；新建 Terminal、Preview、Agent Team 和 Prototype 等需要目录的操作统一返回明确的 409。
- 最后一个引用该子 Project ID 的 Session 关闭后，从 registry 移除 `missing` context。

### P2：Activity 与 Quick Input 应保持子 Project 精确隔离，不做父级隐式合并

**位置**：原计划第 255-262 行没有定义这两个领域的父子语义。

根据“所有操作优先使用子 Project ID”的约束：

- 子 Worktree 中产生的 Activity 写入子 Project ID；查询、导出、删除也只作用于该子 Project。
- 子 Worktree 中的 Project-scoped Quick Input 只属于该子 Project；全局项仍按现有规则可见。
- 选择主节点时使用父 Project ID，因此主节点现有数据和旧数据保持原行为。

这两个领域不需要 schema migration，也不应为了父级聚合增加 `projectId IN (...)` 的隐式语义。若未来需要父级汇总，应新增显式的“包含子项目”查询能力，而不是改变现有 `projectId` 精确匹配。

## 推荐的最小实现方案

### 1. ID 与上下文解析

- 新增共享的子 Project ID build/parse helper 和 `TerminalProjectContextListItem`。
- 新增 Worktree discovery/registry；父 Project Manager 初始化完成后刷新所有父 Project。
- `listProjects()` 只返回父 Project；`getProject()` 查父集合后再查子 registry。
- 主节点复用父 Project，不创建虚假的 Primary child record。

### 2. 保留现有业务合约

- Session create/list/status/history 继续只使用 `projectId`。
- LowDB Session 不新增字段，旧 Session 天然等于主节点 Session。
- Preview API、响应、query key 和 store 不改形状。
- Agent Team create/run 合约不改形状。
- Activity、App Server event、Quick Input 和 Prototype 继续使用同一个生效 `projectId`。

### 3. 补齐父子控制面

- 新增 `GET /api/terminal/project/:parentProjectId/contexts`。
- 新增只接受子 Project ID 的 pin API；主节点固定为第一项且无取消/删除入口。
- 父 Project record 增加可选的 `pinnedChildProjectIds`。
- 父 Project path 修改后刷新其子 registry；父 Project 删除级联全部子 Project Session。

### 4. 改 Workspace 导航，不改业务面

- 左侧 rail 返回的每一项都直接携带可操作的 `projectId`。
- 选中项的 `projectId` 直接传给 Terminal、Preview、Agent Team、Quick Input 和 Prototype。
- 顶部 tabs 只使用 `activeParentProjectId`；右侧 Session 列表只按 `activeProjectId` 精确过滤。
- 父、子、Terminal 三者切换通过一个原子 action 完成。

### 5. 修正枚举、恢复与聚合

- Agent Team run 恢复、recheck、checkpoint 扫描和 Work History 使用全部 Project contexts。
- App Home 把子 Session 归组到父 Project，但保留 Session 的子 `projectId` 供后续操作。
- 顶部 Project 状态把子 context 的 Session 状态聚合到父 tab。
- recent selection 按父 Project 记住最后的生效 Project ID。

## 影响面对比

| 领域                      | 原计划                         | 推荐方案                            |
| ------------------------- | ------------------------------ | ----------------------------------- |
| Session shared/storage    | 新增 `worktreeId/worktreePath` | 不改，`projectId` 即生效 ID         |
| Session create API        | 新增 `worktreeId`              | 继续传现有 `projectId`              |
| Preview API/response      | 全链路新增 `worktreeId`        | 不改，路由 `:id` 传子 Project ID    |
| Preview cache/query/store | 改为复合 key                   | 不改，现有 `projectId` 已隔离       |
| Agent Team root           | 增加 Worktree fallback         | `getProject(childId).path` 自动解析 |
| Activity/Quick Input      | 语义未定义                     | 继续按生效 ID 精确隔离              |
| Workspace                 | 父、Worktree 两套业务 ID       | 一个生效 ID + 一个仅导航用父 ID     |
| App Home/Work History     | 未覆盖                         | 增加父归属/全部 contexts 枚举       |
| Project 删除              | 声称不变                       | 必须级联子 Project Session          |

## 计划与用例需要同步重写的内容

计划中应删除所有以下表述：

- `worktreeId`、`worktreePath` 写入 Session；
- Preview query 参数 `worktreeId`；
- Preview response 增加 Worktree 字段；
- Preview store/query 使用 `projectId + worktreeId`；
- Agent Team 从 Session Worktree 字段回退；
- `activeWorktreeId` 作为业务链路的第二 ID。

测试文档中 WTC-008 至 WTC-016 的请求断言也要改为：

- 主节点请求的 `projectId === parentProjectId`；
- 子节点请求的 `projectId === childProjectId`；
- Preview 直接请求 `/api/terminal/project/:childProjectId/preview/*`，不带 `worktreeId` query；
- Session 的唯一归属字段为子 `projectId`；
- Agent Team run 的 `projectId` 为子 ID，重启后仍可枚举和恢复；
- 父 Project 删除会停止并删除所有子 Project Session；
- App Home 能在父 Project 组中展示子 Project Session，并用子 ID 打开其 Terminal/Preview；
- Activity 和 Quick Input 在父、子 Project 之间保持精确隔离。

## 验收门槛

进入实现前，修订后的计划至少应明确并覆盖：

1. 父 Project、子 Project、生效 Project 三个术语和唯一计算规则。
2. 子 Project ID 的编码、解析、碰撞和路径边界规则。
3. `listProjects`、`getProject`、`listProjectContexts`、`listAllProjectContexts` 的不同语义。
4. Project 删除、path 修改、backend 重启和外部移除 Worktree 时的收敛行为。
5. Agent Team、Work History、App Home 和顶部状态的枚举/聚合行为。
6. 旧 Project、旧 Session、旧 Preview API 完全不迁移即可继续使用。
7. 浏览器验收时，网络请求中始终只出现一个生效 `projectId`，不存在父子 ID 组合不一致。

## 最终判断

采用父子 Project 模型后，核心改动从“修改所有依赖 Project 的业务链路”缩小为“增加子 Project resolver/registry，并修正少数枚举和父级导航逻辑”。这是当前代码结构下更短、风险更低、也更符合长期演进的方案。

原计划不建议按现状直接实施；应先按本报告重写计划和配套测试用例。
