# Terminal Worktree Project Context

## 身份模型

Worktree 是父 Project 下的子 Project，不是独立于 Project 的第二套上下文。Terminal 工作台始终只向业务链路传一个当前生效的 ID：

```text
effectiveProjectId = childProjectId ?? parentProjectId
```

- 顶部 Project tab、Project CRUD、默认 Project 和 Worktree 发现只使用父 Project ID。
- Worktree rail 第一项是父 Project 根目录，`projectId === parentProjectId`。
- `.worktree/<name>` 下被 Git 登记的直接子 Worktree 使用稳定子 ID：`wt:<base64url(parentProjectId)>:<base64url(NFC name)>`。
- Session、Preview、Agent Team、Activity、Quick Input 和 Prototype 继续只保存或传递一个 `projectId`，不新增 `worktreeId` 或 `worktreePath`。

shared 的 `buildTerminalChildProjectId`、`parseTerminalChildProjectId` 和 `resolveTerminalParentProjectId` 是跨 backend、Web 与 App 的唯一 ID helper。解析后必须重新构建得到完全相同的字符串，非规范编码、空名称和额外分隔段都不是合法子 ID。

## 发现与授权

`TerminalSessionManager.listProjects()` 仍只返回父 Projects，保持旧客户端、Project tabs 和 CRUD 语义不变。子 Project 通过以下接口读取：

- `getProject(projectId)`：父 Project 或 `available` 子 Project；现有业务链路用它解析唯一 root。
- `getProjectContext(projectId)`：包含 `available`、`path_unavailable` 和 `missing`，用于 UI 与错误分类。
- `listProjectContexts(parentProjectId)`：一个父 Project 的主节点与子节点。
- `listAllProjectContexts()`：全部父节点与 `available` 子节点，供 Agent Team 恢复、Work History 和 Prototype Gallery 枚举。

发现使用 `git -C <parent.path> worktree list --porcelain -z`。只有同时满足以下条件的记录才能进入 registry：

1. lexical path 是 `<parent.path>/.worktree/` 的直接子目录；
2. `.worktree` 自身没有通过 symlink 逃出父 Project；
3. Worktree realpath 仍是该 root 的直接子目录；
4. 记录来自 Git，而不是普通同名目录。

子 ID 只表达身份，不授予目录访问权。跨父 ID、随机 ID、非规范 ID 返回 404；已知但不可用的 context 返回 409，任何业务都不能回退到父 path 或 Session cwd。

## 持久化与恢复

父 Project record 仅增加可选 `pinnedChildProjectIds`。旧 Projects、旧 Sessions 和旧 API 请求无需迁移：旧 Session 的父 `projectId` 自然归入主节点。

外部移除 Worktree 后，如果仍有 Session 引用其规范子 ID，contexts API 合成 `missing` 节点。已有 Terminal 仍可打开；新建 Terminal、Preview、Agent Team 与 Prototype 等需要目录的操作返回 409。最后一个 Session 删除后，下一次发现会移除该节点。

父 Project 删除按 `resolveTerminalParentProjectId(session.projectId)` 级联父、子全部 Session/runtime/panel，并清理各 context 的 Preview cache。父 path 修改会清空旧 registry/cache 后重新发现。

## Web 与 App

Web Zustand 同时保存：

```ts
activeParentProjectId: string | null; // 顶部导航与父 Project CRUD
activeProjectId: string | null; // 唯一 effectiveProjectId
activeSessionId: string | null;
```

desktop 在父 Project header 下渲染可折叠 Worktree rail；主节点永久第一且不可取消固定，其他节点只显示名称和实际分支。rail 不提供新增、删除、重命名、diff 或 Git 写操作。contexts 每 3 秒刷新并在窗口重新聚焦时刷新。

`contextProjectIdByParentProjectId` 恢复每个父 Project 上次选中的 context，`projectSessionIds` 继续按生效 Project ID 恢复 Terminal。Preview store 原本已按 `projectId` 分桶，不增加复合 key。

Ionic App 不渲染 rail。App Home 用 `resolveTerminalParentProjectId` 把子 Session 归入父 Project 组，但打开 Session 时保留原始子 `projectId`。

## API

```http
GET /api/terminal/project/:parentProjectId/contexts
PATCH /api/terminal/project/:parentProjectId/contexts/:childProjectId
Content-Type: application/json

{ "pinned": true }
```

Preview 仍使用 `/api/terminal/project/:effectiveProjectId/preview/*`，Session create 仍使用现有 `projectId` 字段。Activity 与 Project-scoped Quick Input 继续精确匹配该 ID，父 Project 不隐式汇总子 Project 数据。

验收入口：`docs/testing/terminal/worktree-project-context.testplan.yaml`。
