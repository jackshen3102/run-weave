# Worktree Terminal Context 测试用例

本文档验收 `docs/plans/2026-07-18-worktree-terminal-context.md`。本轮只编写用例，不执行用例。

涉及页面打开、点击、输入、DOM 读取和截图时，必须使用 `$toolkit:playwright-cli` 操作真实浏览器；`typecheck`、`lint` 和代码阅读只能作为前置门禁，不能代替行为证据。本仓库不新增 unit test，本功能的自动化浏览器用例只放在 `frontend/tests/worktree-terminal-context.spec.ts`。

## 范围

覆盖：

- 主节点永久第一与不可取消固定；
- `.worktree` 内 Git Worktree 自动发现和移除；
- 名称/分支两行信息与不显示 diff/变更数；
- 次级 Worktree 固定、排序和持久化；
- rail 折叠、展开和持久化；
- Project、Worktree、Terminal 与 Preview 上下文联动；
- 新建/继承 Terminal 的 Worktree 归属；
- Preview 读写、Changes 与缓存隔离；
- Worktree 外部移除、旧 Session、鉴权和路径边界；
- Agent Team 使用当前 Worktree root。

不覆盖：Runweave 内新增/删除/修复 Git Worktree、git commit/stage、Ionic App Worktree UI。原因是这些能力不属于本期产品范围。

## 前提事实

- Project 入口仍为顶部 Project tabs。
- Worktree API 为 `GET /api/terminal/project/:projectId/worktrees` 与 `PATCH /api/terminal/project/:projectId/worktrees/:worktreeId`。
- 新 UI 创建 Terminal 时向 `POST /api/terminal/session` 传 `worktreeId`。
- Preview 继续使用 `/api/terminal/project/:id/preview/*`，并通过 `worktreeId` query 指定根目录。
- 自动发现只认 `<project.path>/.worktree/` 下、同时存在于 `git worktree list --porcelain -z` 的真实 Worktree。
- 第一项由 Project 根目录合成，不依赖 Git 列表顺序，也不依赖它实际是否位于 main 分支。

## 测试数据

每条需要 Git 的用例都使用独立临时目录，至少构造：

```text
<temp>/project                         # Project 根，branch=main
<temp>/project/.worktree/activity     # name=activity，branch=feat/activity
<temp>/project/.worktree/preview-fix  # name=preview-fix，branch=fix/preview-sync
<temp>/outside                        # 同一 common git dir，但在 .worktree 外
```

在 `main`、`feat/activity` 中各放置 `context.txt`，内容分别为 `main-context`、`activity-context`，用于识别 Preview 是否串根。

## 必跑命令

按顺序执行，任一失败即停：

```bash
pnpm typecheck
pnpm lint
pnpm --dir frontend test:e2e -- worktree-terminal-context.spec.ts
git diff --check
```

随后使用 `$toolkit:playwright-cli` 执行本文所有 P0 Web 用例。自动化 E2E 通过但真实浏览器用例未执行时，验收状态只能记录为“未完成”。

## 用例

### WTC-001 [P0] 主节点始终第一且不可取消固定

- 前置条件：Project 已指向测试仓库；Project 根当前分支为 `main`，存在两个次级 Worktree。
- 步骤：使用 `$toolkit:playwright-cli` 打开 Terminal；读取 Worktree 列表顺序；检查主节点右侧操作；尝试通过 API 将主节点 `pinned=false`。
- 期望：第一项 `isPrimary=true`，第一行是 Project/主 Worktree 名称、第二行是实际分支；UI 只有非交互的永久固定标记，没有取消固定或删除入口；API 返回 409，刷新后主节点仍第一。
- 失败判定：主节点受 Git 返回顺序影响、可取消固定、出现删除/`...`，或 API 返回成功。
- 证据：列表 DOM、主节点操作区截图、PATCH 状态码与响应体。

### WTC-002 [P0] Worktree 名称与分支分别展示且不显示变更摘要

- 前置条件：存在 `name=activity`、`branch=feat/activity` 的次级 Worktree，并制造未提交文件。
- 步骤：使用 `$toolkit:playwright-cli` 检查该行两段文案及其无障碍名称。
- 期望：第一行显示 `activity`，第二行显示 `feat/activity`；列表中不存在 `changes`、`clean`、文件名、增删行数或 dirty count。
- 失败判定：名称被分支替代、两行相同但真实值不同，或左侧出现任何 diff/变更摘要。
- 证据：Worktree 行 DOM 文本与截图。

### WTC-003 [P0] 只自动发现 `.worktree` 内的 Git Worktree

- 前置条件：测试数据中的主节点、两个 `.worktree` 节点和一个 `outside` 节点均已通过 Git 登记。
- 步骤：请求 Worktree list API，并使用 `$toolkit:playwright-cli` 检查列表。
- 期望：返回主节点、`activity`、`preview-fix`；不返回 `outside`；每个 ID 唯一且路径属于对应 Project。
- 失败判定：泄漏同一 common git dir 的外部 Worktree、把普通目录当 Worktree，或遗漏合法 `.worktree` 节点。
- 证据：`git worktree list --porcelain`、API JSON、页面 DOM。

### WTC-004 [P0] 新增和移除 Worktree 在刷新窗口内自动收敛

- 前置条件：Terminal 页面已停留在 Project 主节点。
- 步骤：从页面外用 Git 在 `.worktree/new-area` 新增 Worktree；等待最多 3 秒加一次请求延迟；确认列表出现；再移除且该 Worktree 没有 Terminal。
- 期望：无需刷新页面或点击按钮，新增项自动出现，移除项自动消失；没有 Add、Delete 或手动 Refresh 入口。
- 失败判定：超过约定窗口仍不收敛、必须手动刷新，或产品执行了 Git 写操作。
- 证据：操作前后 DOM 快照、Git 命令输出和时间戳。

### WTC-005 [P0] 次级 Worktree 固定顺序可持久化

- 前置条件：至少三个次级 Worktree，均有不同最近活跃时间。
- 步骤：固定最不活跃项；刷新页面并重启 backend 后再次读取；随后取消固定。
- 期望：主节点始终第一；固定项位于其他次级项之前；固定顺序跨刷新/backend 重启保留；取消后按最近活跃时间重新排序。
- 失败判定：主节点被挤下第一、固定仅在内存生效、取消固定改变主节点，或固定动作影响 Git 仓库。
- 证据：三次列表顺序截图、API 响应与持久化文件中的 ID 数组。

### WTC-006 [P1] 未固定 Worktree 按 Terminal 最近活跃时间稳定排序

- 前置条件：两个未固定 Worktree 各有 Terminal，最后活跃时间可区分。
- 步骤：向较旧 Worktree 的 Terminal 输入命令使其成为最新活跃；等待 Session 数据更新。
- 期望：主节点位置不变；该 Worktree 移到其他未固定项之前；活跃时间相同的项目按 name 稳定排序，不闪烁。
- 失败判定：按 Git 输出随机排序、列表每轮轮询抖动，或次级项越过主节点。
- 证据：Session API 的 `lastActivityAt` 与前后 DOM 顺序。

### WTC-007 [P0] rail 折叠和展开保持完整右侧 Terminal 布局

- 前置条件：desktop 模式，当前 Worktree 有至少两个 Terminal，Preview 已打开。
- 步骤：使用 `$toolkit:playwright-cli` 点击折叠；检查窄栏与展开按钮；展开；刷新后再次检查偏好。
- 期望：展开态约 236px、折叠态约 36px；折叠后右侧仍包含完整 Terminal tabs、Terminal 与 Preview；展开按钮保留在原位置；刷新后恢复上次状态；页面无横向溢出。
- 失败判定：Session tabs 留在 rail 上方而不是右列、折叠后无法展开、Preview 被卸载/串根、或出现横向滚动。
- 证据：展开/折叠截图、关键元素 bounding box 与 scrollWidth/clientWidth。

### WTC-008 [P0] 切换 Worktree 原子切换 Terminal 与 Preview

- 前置条件：主节点和 `activity` 各有一个 Terminal，`context.txt` 内容不同；Preview 打开 Files。
- 步骤：在主节点读取 Terminal cwd 与文件内容；点击 `activity`；立即读取 active Worktree、active Terminal、cwd、Preview root 和文件内容。
- 期望：一次交互后 active 状态各只有一个；右侧只显示 `activity` 的 Terminal；cwd 位于 `.worktree/activity`；Preview 显示 `activity-context`；任何中间/迟到响应都不能恢复主节点文件。
- 失败判定：Terminal 与 Preview 属于不同 Worktree、同时出现两个 active 项、或旧请求覆盖新内容。
- 证据：点击后的 DOM、Terminal 输出、Preview 请求 query 与文件内容。

### WTC-009 [P0] 每个 Worktree 独立恢复 Terminal 与 Preview 选择

- 前置条件：两个 Worktree 各有两个 Terminal 和不同 Preview 文件。
- 步骤：分别在两个 Worktree 选择非首个 Terminal 和不同文件；来回切换；刷新页面。
- 期望：每次切回都恢复该 Worktree 上次 Terminal 与 Preview path；刷新后恢复上次 Project/Worktree，并保留各 Worktree 的 Session 映射。
- 失败判定：所有 Worktree 共用一个 activeSessionId/selectedPath，或刷新后只能恢复 Project 不能恢复 Worktree。
- 证据：切换序列截图、localStorage recent selection、请求 query。

### WTC-010 [P0] 新建和继承 Terminal 保持 Worktree 归属

- 前置条件：当前选中 `activity`。
- 步骤：点击 New Terminal；读取 Session API 和终端 `pwd`；再基于该 Session 走 inherit 创建路径；伪造同一请求传另一个 Worktree 外 cwd。
- 期望：前两个 Session 的 `worktreeId` 均为 `activity`，默认 cwd 为 `.worktree/activity`；冲突 cwd 请求返回 400 且不创建 Session。
- 失败判定：新 Terminal 落到 Project 根、继承丢失 Worktree，或后端接受路径逃逸。
- 证据：POST 请求/响应、Session list JSON、两次 `pwd` 输出和错误响应。

### WTC-011 [P0] Preview 所有读写与 Changes 都隔离在当前 Worktree

- 前置条件：两个 Worktree 都有同名文件；各自有不同 Git 变更。
- 步骤：依次执行 file search/read/save、directory list、changes、diff；在 `activity` 修改并保存 `context.txt`；切回主节点。
- 期望：每个请求带正确 `worktreeId`；搜索、目录、Changes、Diff 仅返回当前 Worktree；保存只改变 `activity/context.txt`，主节点仍为 `main-context`；主节点 Explorer 不显示 `.worktree` 容器。
- 失败判定：任一 Preview 路由仍以 Project path 执行、缓存串内容、或写操作修改了另一个 Worktree。
- 证据：网络请求、两个磁盘文件内容、Changes/Explorer DOM。

### WTC-012 [P0] 外部移除有存活 Terminal 的 Worktree 时保留安全入口

- 前置条件：`preview-fix` 有一个运行中的 Terminal，且当前选中该节点。
- 步骤：从页面外强制移除该 Git Worktree；等待自动刷新；尝试访问已有 Terminal、创建新 Terminal和打开 Preview；关闭最后一个 Terminal。
- 期望：节点转为 `missing`，已有 Terminal 仍可访问；New Terminal 与 Preview 被禁用并给出明确不可用状态；关闭最后一个 Terminal 后节点自动消失并回退主节点。
- 失败判定：运行中 Terminal 失去入口、请求悄悄回退到 Project 根、missing 节点仍能写文件，或空 missing 节点长期残留。
- 证据：移除前后 API/DOM、禁用态截图和 Terminal 访问结果。

### WTC-013 [P1] 旧存储与旧客户端默认落在主节点

- 前置条件：准备不含 `pinnedWorktreeIds/worktreeId/worktreePath` 的旧 LowDB fixture，并使用不带 `worktreeId` 的旧 Session create payload。
- 步骤：启动 backend，打开 Terminal，读取 Project/Worktree/Session；调用省略 `worktreeId` 的 Preview API。
- 期望：backend 正常启动；旧 Session 在主节点可见；Preview 读取 Project 根；存储读取无异常，不要求用户先迁移。
- 失败判定：启动失败、旧 Session 消失、出现 `undefined` Worktree UI，或旧 Preview API 变成 4xx。
- 证据：启动日志、Session/Worktree/Preview API JSON 与页面截图。

### WTC-014 [P0] 伪造 Worktree 身份不能跨 Project 或跨目录访问

- 前置条件：存在 Project A、Project B，各有 Worktree；已登录普通用户。
- 步骤：在 A 的 session/preview/pin 请求中传 B 的 `worktreeId`；传随机 ID；构造 `../` 与 symlink escape 文件路径。
- 期望：跨 Project/随机 ID 返回 404，missing 目录操作返回 409，路径逃逸返回现有 400/403；A/B 文件均未改变，错误不泄漏无关绝对路径内容。
- 失败判定：请求成功、退回 Project 根执行、跨 Project 改文件，或响应暴露目录内容。
- 证据：状态码/响应体与操作前后文件 hash。

### WTC-015 [P1] 未认证请求不能读取路径或修改固定状态

- 前置条件：清除登录 cookie/token。
- 步骤：调用 Worktree list、pin、带 Worktree 的 Preview API。
- 期望：全部返回 401；响应不包含 Project path、Worktree path、branch 或文件内容；固定状态不变。
- 失败判定：任一接口匿名可读/可写或响应泄漏路径。
- 证据：三类请求的状态码、响应体和重新登录后的固定状态。

### WTC-016 [P0] Agent Team 在当前 Worktree 解析计划与产物路径

- 前置条件：选中 `activity` 的 Terminal；主节点与次级 Worktree 都有同名计划文件，但内容不同。
- 步骤：从该 Terminal 发起 Agent Team，并让流程解析计划/测试用例路径和写入 run/outbox；随后查看落盘位置。
- 期望：解析和产物均位于 `.worktree/activity`；worker cwd 属于同一 Worktree；主节点同名文件和 `.runweave/agent-team` 不被本次 run 修改。
- 失败判定：`service-support` 或 storage 仍优先 Project path，导致读取/写入主节点。
- 证据：run 元数据、worker cwd、产物绝对路径与两侧目录 diff。

### WTC-017 [P1] Project 切换恢复各自 Worktree 且移动端不回归

- 前置条件：两个 Project，各自选中过非主 Worktree；另准备 mobile monitor 入口。
- 步骤：desktop 来回切换 Project 并刷新；再打开 mobile monitor。
- 期望：desktop 每个 Project 恢复自己的 Worktree/Terminal；mobile 不渲染 rail，仍能显示主节点 Session，不因新增字段崩溃。
- 失败判定：两个 Project 共用一个 Worktree ID、切换后串 Session，或 mobile 页面出现空白/rail 挤压。
- 证据：desktop 切换 DOM/localStorage 与 mobile 截图/console。

## 覆盖检查

| 维度          | 结论                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| 正常路径      | WTC-001 至 WTC-011、WTC-016                                                                 |
| 边界值        | 仅主节点、无 Project path、detached HEAD 在 WTC-001/002/013 的 fixture 变体中执行           |
| 错误态        | WTC-010、WTC-012、WTC-014、WTC-015                                                          |
| 异步/迟到响应 | WTC-004、WTC-008、WTC-009、WTC-012                                                          |
| 并发          | 不要求多用户编辑；固定请求并发以最后成功响应为准，并在 WTC-005 增加双请求变体               |
| 权限与安全    | WTC-014、WTC-015                                                                            |
| 幂等/去重     | 重复轮询不得产生重复节点，纳入 WTC-003/004；重复 pin 到同一值返回同一最终状态，纳入 WTC-005 |
| 回归          | WTC-013、WTC-017；Project CRUD、Terminal WS/Panel 继续跑现有 smoke/相关用例                 |

## 验收通过标准

- 必跑命令全部为 0 exit code。
- WTC-001、002、003、004、005、007、008、009、010、011、012、014、016 全部通过并有可复核证据。
- P1 用例无阻断性失败；若因环境未执行，必须逐条记录原因，不能记为通过。
- 页面 console 无新增 error/warning，Worktree 轮询无无限重试或重复节点。
- 任一 Preview/Agent Team 跨 Worktree 读写、主节点可取消固定、运行中 Terminal 丢入口，均直接判定整体验收失败。
