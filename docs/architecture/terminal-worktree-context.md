# Terminal Worktree Project Context

## 身份模型

Worktree 是父 Project 下的子 Project，不是独立于 Project 的第二套上下文。Terminal 工作台始终只向业务链路传一个当前生效的 ID：

```text
effectiveProjectId = childProjectId ?? parentProjectId
```

- 顶部 Project tab、Project CRUD、默认 Project 和 Worktree 发现只使用父 Project ID。
- Worktree rail 第一项是父 Project 根目录，`projectId === parentProjectId`。
- `.worktree/<name>` 下被 Git 登记的直接子 Worktree 使用稳定子 ID：`wt:<base64url(parentProjectId)>:<base64url(NFC name)>`。
- Session、Preview、Activity、Quick Input 和 Prototype 继续只保存或传递一个 `projectId`，不新增 `worktreeId` 或 `worktreePath`。

shared 的 `buildTerminalChildProjectId`、`parseTerminalChildProjectId` 和 `resolveTerminalParentProjectId` 是跨 backend、Web 与 App 的唯一 ID helper。解析后必须重新构建得到完全相同的字符串，非规范编码、空名称和额外分隔段都不是合法子 ID。

## 工作台前进与后退

Web 工作台历史保存父 Project、当前生效 Project 和终端 Session 的完整目标，最多 50 条。
切换同一 Worktree 内的终端也形成历史；前进／后退同时恢复三个字段。
选择经项目与终端数据协调后才写入历史，相邻相同目标不重复记录；后退后新选择会截断前进分支。
终端关闭或移动后移除旧目标，原空 Context 已有终端时也移除其空目标。
实现入口见 [workspace store](../../frontend/src/features/terminal/state/workspace-store.ts)。

## 发现与授权

`TerminalSessionManager.listProjects()` 仍只返回父 Projects，保持旧客户端、Project tabs 和 CRUD 语义不变。子 Project 通过以下接口读取：

- `getProject(projectId)`：父 Project 或 `available` 子 Project；现有业务链路用它解析唯一 root。
- `getProjectContext(projectId)`：包含 `available`、`path_unavailable` 和 `missing`，用于 UI 与错误分类。
- `listProjectContexts(parentProjectId)`：一个父 Project 的主节点与子节点。
- `listAllProjectContexts()`：全部父节点与 `available` 子节点，供 Work History 和 Prototype Gallery 枚举。

发现使用 `git -C <parent.path> worktree list --porcelain -z`。只有同时满足以下条件的记录才能进入 registry：

1. lexical path 是 `<parent.path>/.worktree/` 的直接子目录；
2. `.worktree` 自身没有通过 symlink 逃出父 Project；
3. Worktree realpath 仍是该 root 的直接子目录；
4. 记录来自 Git，而不是普通同名目录。

子 ID 只表达身份，不授予目录访问权。跨父 ID、随机 ID、非规范 ID 返回 404；已知但不可用的 context 返回 409，任何业务都不能回退到父 path 或 Session cwd。

## 持久化与恢复

父 Project record 仅增加可选 `pinnedChildProjectIds`。旧 Projects、旧 Sessions 和旧 API 请求无需迁移：旧 Session 的父 `projectId` 自然归入主节点。

外部移除 Worktree 后，如果仍有 Session 引用其规范子 ID，contexts API 合成 `missing` 节点。已有 Terminal 仍可打开；新建 Terminal、Preview 与 Prototype 等需要目录的操作返回 409。最后一个 Session 删除后，下一次发现会移除该节点。

父 Project 删除按 `resolveTerminalParentProjectId(session.projectId)` 级联父、子全部 Session/runtime/panel，并清理各 context 的 Preview cache。父 path 修改会清空旧 registry/cache 后重新发现。

## Web 与 App

Web Zustand 同时保存：

```ts
activeParentProjectId: string | null; // 顶部导航与父 Project CRUD
activeProjectId: string | null; // 唯一 effectiveProjectId
activeSessionId: string | null;
```

desktop 在父 Project header 下渲染可折叠 Worktree rail；主节点永久第一且不可取消固定，其他节点显示名称、实际分支和相对项目主分支的落后提交数。子 Worktree 行的右键菜单提供删除入口；主节点不提供 Git 写操作。contexts 每 3 秒刷新并在窗口重新聚焦时刷新。

分支比较不要求该 Worktree 有运行中的 Terminal。Backend 按[项目主分支设置](./terminal-code-preview.md#主分支更新)读取指定分支或远端默认分支并 fetch 对应引用，
比较当前 HEAD；不会自动 rebase、合并或修改工作区。远端快照最多复用 10 分钟，Web 重新聚焦时查询；
失败或快照过期显示“待更新”，已有计数保留但标记过期。非 Git 目录不显示比较，浅克隆、
无可用远端或无共同历史时不推断为零。零落后仅表示所选远端主分支没有当前 HEAD 缺少的提交，
不表示分支完全相同、工作区干净或改动已经合并。

删除只移除当前父 Project 的 `.worktree/<name>` 直接子 Worktree，保留分支、Activity 和 Work History。已置顶（`pinned: true`）的子 Worktree 在手动删除、批量清理与强制删除路径下均受保护拒绝删除（需先取消置顶）；干净已合入的置顶槽位仍可通过 `recycle` 原地切新分支复用并保留置顶状态，且 `recycle` 严禁重置当前未合并 HEAD 或已有未合并本地分支。最终确认时 Backend 重新校验 Git 登记、路径边界、工作区干净状态、detached HEAD 引用和运行中 Agent；失败不使用 `--force`。通过检查后，对 source.root 匹配目标的全部未释放 Dev Session 使用其源码 CLI 尽力停止，全部清理共享 30 秒期限；普通停止发现身份漂移后仅重试一次 stale cleanup。清理失败、超时或身份信息缺失不阻止删除，也不把未释放的 Session 标为 stopped。当前处理删除请求的 Session 不会停止自身 Backend。普通 Terminal 会在删除前停止，当前 Context 删除成功后 Web 切回父 Project 主节点；存在清理警告时，rail 显示可关闭的“Worktree 已删除，部分服务未清理”提示。

`contextProjectIdByParentProjectId` 恢复每个父 Project 上次选中的 context，`projectSessionIds` 继续按生效 Project ID 恢复 Terminal。Preview store 原本已按 `projectId` 分桶，不增加复合 key。

原生 iOS 不渲染 Web rail。`Contracts/Home.swift` 的 `parentProjectID` 把子 Session 归入父 Project 组，打开 Session 时仍使用原始终端身份。
首页项目的“＋”先读取该父 Project 的 contexts，展示主项目和 Worktree 的分支、路径，
再将所选 context 的原始 `projectId` 交给现有 Session create 接口；不可用的子节点禁止创建。
未配置路径的主项目保留默认主目录行为，读取失败时展示错误并允许重试，不静默改为父项目。

## 移动终端

桌面/Web 的终端标签右键菜单与 iOS 首页终端长按菜单提供“移动到项目”。
`PATCH /api/terminal/session/:id` 单独发送 `{ "projectId": "目标主项目 ID" }`，
目标必须是当前 Backend 已有的主项目；不存在的目标返回 404，与其他更新混发返回 400。
移动将归属和目标项目末尾排序一起持久化，成功后发送 `terminal_session_moved` 供在线客户端刷新。
相同目标的请求不重复移动或发送事件。

移动只改变归属，保留终端 ID、进程、tmux、分屏、对话、草稿与当前目录，不发送 `cd` 或重启 Agent。
Files、Changes 和项目快捷指令随后使用目标项目；原进程仍在原目录运行。
这不是跨电脑迁移或文件移动，也不改写已有 Activity、定时任务来源与历史记录。

## Race 的 Worktree 生命周期

Race 为同一目标的每个 worker 创建独立 Worktree、分支与 Terminal，用户分别查看输出和 Diff，
不自动选赢家、合并或推送。当前连接一次只保留一个 Race；结束 Race 停止 worker Terminal 并清除
Race 记录，但保留 Worktree 与分支供人工比较。实现见 [RaceService](../../backend/src/race/race-service.ts)。

普通创建、普通删除、Race 创建与专用删除使用规范父项目路径的同一进程内互斥锁。创建锁覆盖 Git 检出、Context 刷新及首终端登记。Race 专用删除等候当前创建结束后重新读取 worker。
验收入口是 [Race](../testing/terminal/race.testplan.yaml)。

## API

```http
GET /api/terminal/project/:parentProjectId/worktree-create-preview
GET /api/terminal/project/:parentProjectId/worktree-governance[?includeDiskUsage=true]
POST /api/terminal/project/:parentProjectId/worktree-cleanup-batch
POST /api/terminal/project/:parentProjectId/contexts
POST /api/terminal/project/:parentProjectId/contexts/:childProjectId/recycle
GET /api/terminal/project/:parentProjectId/contexts
PATCH /api/terminal/project/:parentProjectId/contexts/:childProjectId
DELETE /api/terminal/project/:parentProjectId/contexts/:childProjectId
Content-Type: application/json

{ "pinned": true }
```

`DELETE` 无请求体，成功且无清理警告时返回 204；删除成功但 Dev Session 清理未完成时返回 200 与 `{ "cleanupWarnings": [{ "devSessionId": "dvs-...", "message": "具体原因" }] }`，无法读取 registry 的警告使用 null Session ID。旧客户端仍可按成功状态处理，新 Web 同时兼容旧 Backend 的 204。安全校验失败返回包含具体原因的 4xx。删除成功后清理该子 Context 的 Session、Preview cache 与固定元数据，但不删除 Git branch 或历史记录。

Preview 仍使用 `/api/terminal/project/:effectiveProjectId/preview/*`，Session create 仍使用现有 `projectId` 字段。Activity 与 Project-scoped Quick Input 继续精确匹配该 ID，父 Project 不隐式汇总子 Project 数据。

验收入口：`docs/testing/terminal/workspace/project-context.testplan.yaml`、`docs/testing/terminal/workspace/deletion.testplan.yaml` 与 `docs/testing/terminal/worktree-governance-and-recycle.testplan.yaml`。

桌面 Rail 和 iOS 新建终端页从预览读取基准引用、父目录的 setup 以及可复用槽位（`recyclableSlots` / `shareableContexts`）。创建与原地复用请求均在本进程内按父项目和 operationId 保留一小时成功回执。新目录必须是受控 .worktree 下的直接子项，检出现有分支需要显式选择。已置顶（`pinned`）的 Worktree 永不在 Rail 中折叠，也拒绝批量删除和强制删除，但处于干净、已合入且无运行中 Agent 状态时允许原地复用切新分支（复用后保持 `pinned` 状态），处于忙碌或有改动状态时允许不切分支同目录新开并行终端。批量清理在父项目互斥锁内二次校验工作区干净与运行态；含未提交/未跟踪文件的未置顶目录仅在显式列入 `forceConfirmedProjectIds` 后允许 `git worktree remove --force`，本地分支删除始终使用小写 `git branch -d` 绝不强删未合并分支。

初始化批准与执行见[工作区服务配置](./terminal-workspace-services.md)。[创建及初始化验收](../testing/terminal/workspace/provision-and-setup.testplan.yaml)。
