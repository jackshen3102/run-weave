# Worktree Terminal Context 测试用例

本文档验收 `docs/plans/2026-07-18-worktree-terminal-context.md`。本轮只编写用例，不执行产品用例。

浏览器页面用例必须使用 `$toolkit:playwright-cli` 操作真实 Runweave 页面并保存 DOM、网络或截图证据。`typecheck`、`lint` 和代码阅读只是前置门禁，不能替代行为证据。本仓库不新增 unit test；自动化浏览器用例只放在 `frontend/tests/worktree-terminal-context.spec.ts`。

## 范围

覆盖：

- 父 Project、Worktree 子 Project 与唯一生效 `projectId`；
- 主节点永久第一、子节点自动发现、固定和排序；
- rail 折叠、父/子 Project 与 Terminal 选择恢复；
- Session cwd、Preview、Agent Team、Activity、Quick Input 和 Prototype 的子 Project 隔离；
- backend 重启、外部移除 Worktree、父 Project 删除级联；
- App Home 和顶部父 Project 状态聚合；
- 旧 Project、旧 Session 与旧 API 兼容。

不覆盖：Runweave 内新增/删除/修复 Git Worktree、git commit/stage、多用户并发编辑。原因是这些行为不属于本期产品范围。

## 前提事实

- `effectiveProjectId = childProjectId ?? parentProjectId`。
- 主节点的 `projectId === parentProjectId`；其他 Worktree 使用父 ID 与 Worktree 名称生成的子 Project ID。
- Context API 为 `GET /api/terminal/project/:parentProjectId/contexts` 与 `PATCH /api/terminal/project/:parentProjectId/contexts/:childProjectId`。
- 新 UI 创建 Terminal 时仍向 `POST /api/terminal/session` 传现有 `projectId` 字段。
- Preview 仍使用 `/api/terminal/project/:effectiveProjectId/preview/*`，不带 `worktreeId` query。
- Session、Preview 和 Agent Team 合约中不新增 `worktreeId/worktreePath`。
- 自动发现只认 `<parent.path>/.worktree/<name>` 下、同时存在于 `git worktree list --porcelain -z` 的直接子 Worktree。

## 测试数据

每条需要 Git 的用例使用独立临时目录：

```text
<temp>/project                         # parent Project，branch=main
<temp>/project/.worktree/activity     # name=activity，branch=feat/activity
<temp>/project/.worktree/preview-fix  # name=preview-fix，branch=fix/preview-sync
<temp>/outside                        # 同一 common git dir，但在 .worktree 外
```

在父根、`activity`、`preview-fix` 中各放置同名 `context.txt`，内容分别为 `parent-context`、`activity-context`、`preview-fix-context`。测试开始时从 contexts API 记录：

```text
parentProjectId
activityChildProjectId
previewFixChildProjectId
```

后续用例不依赖硬编码 ID。

## 必跑命令

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

随后使用 `$toolkit:playwright-cli` 执行本文所有 P0 Web 用例。自动化 E2E 通过但真实浏览器用例未执行时，验收状态只能记录为“未完成”。

## 用例

### WTC-001 [P0] 主节点复用父 Project ID 并永久置顶

- 前置条件：父 Project 指向测试仓库，存在两个子 Worktree。
- 步骤：请求 contexts API；用 `$toolkit:playwright-cli` 读取 Worktree 列表顺序与主节点操作；尝试对主节点调用 pin API。
- 期望：第一项 `isPrimary=true`，且 `projectId === parentProjectId`；第一行是主节点名称、第二行是实际分支；UI 只有不可交互的永久固定标记，没有取消固定、删除或 `...`；pin 请求被拒。
- 失败判定：主节点生成额外子 ID、可取消固定、受 Git 返回顺序影响或出现删除入口。
- 证据：contexts JSON、列表 DOM、主节点操作区截图和 pin 响应。

### WTC-002 [P0] Worktree 名称与分支分别展示且无变更摘要

- 前置条件：存在 `name=activity`、`branch=feat/activity` 的子 Worktree，并制造未提交文件。
- 步骤：用 `$toolkit:playwright-cli` 读取该行文案及无障碍名称。
- 期望：第一行显示 `activity`，第二行显示 `feat/activity`；列表不存在 `changes`、`clean`、文件名、增删行数、dirty count 或 ahead/behind。
- 失败判定：名称被分支替代、真实值不同却显示相同，或列表出现任何 diff 摘要。
- 证据：Worktree 行 DOM 与截图。

### WTC-003 [P0] 只发现 `.worktree` 直接子目录并生成稳定子 Project ID

- 前置条件：父根、两个 `.worktree` 子 Worktree、一个 `.worktree/nested/deep` 和一个 `outside` 均通过 Git 登记。
- 步骤：请求 contexts API 两次；切换 `activity` 分支后再次请求；解析返回的子 Project ID。
- 期望：只返回父根、`activity`、`preview-fix`；不返回 nested 与 outside；子 ID 可解析为正确父 ID 和名称；分支变化前后 ID 相同；所有 ID 唯一。
- 失败判定：泄漏外部/嵌套 Worktree、把普通目录当 Worktree、ID 无法 round-trip、分支变化导致 ID 变化或产生重复 ID。
- 证据：Git porcelain 输出、三次 API JSON 和 ID 解析结果。

### WTC-004 [P0] 外部新增和移除 Worktree 在刷新窗口内自动收敛

- 前置条件：页面停留在父 Project 主节点。
- 步骤：从页面外在 `.worktree/new-area` 新增 Worktree；等待最多 3 秒加一次请求延迟；确认列表出现；再移除且该子 Project 没有 Terminal。
- 期望：无需刷新页面或点击按钮，新节点自动出现、移除后自动消失；没有 Add、Delete 或手动 Refresh 入口。
- 失败判定：超过窗口仍不收敛、必须手动刷新、产生重复节点，或产品执行 Git 写操作。
- 证据：操作前后 DOM、contexts 请求时间戳与 Git 输出。

### WTC-005 [P0] 子 Project 固定顺序跨刷新和 backend 重启保留

- 前置条件：至少三个子 Project，最近活跃时间不同。
- 步骤：固定最不活跃项；刷新页面并重启 backend 后读取顺序；再取消固定。
- 期望：主节点始终第一；固定项位于未固定项之前；重启后顺序保留；取消后按最近活跃时间恢复；固定动作不修改 Git。
- 失败判定：主节点被挤下第一、固定仅在内存生效、固定数组保存错误 ID 或动作影响 Git。
- 证据：三次 DOM、API 响应和父 Project 持久化记录中的 `pinnedChildProjectIds`。

### WTC-006 [P1] 未固定子 Project 按 Terminal 最近活跃时间稳定排序

- 前置条件：两个未固定子 Project 各有 Terminal，`lastActivityAt` 可区分。
- 步骤：向较旧子 Project 的 Terminal 输入命令使其成为最新活跃；等待 Session 数据与一次 contexts 刷新。
- 期望：该子 Project 移到其他未固定项之前；活跃时间相同时按名称稳定排序；主节点位置不变。
- 失败判定：按 Git 输出随机排序、每轮轮询抖动，或子项越过主节点。
- 证据：Session API、contexts API 与前后 DOM 顺序。

### WTC-007 [P0] rail 折叠和展开保持完整右侧 Terminal 布局

- 前置条件：desktop 模式，当前子 Project 有至少两个 Terminal，Preview 已打开。
- 步骤：用 `$toolkit:playwright-cli` 折叠 rail，检查窄栏与展开按钮；重新展开；刷新后检查偏好。
- 期望：展开约 236px、折叠约 36px；右侧始终包含完整 Session tabs、Terminal 与 Preview；展开按钮保留原位置；刷新后恢复偏好；页面无横向溢出。
- 失败判定：Session tabs 留在 rail 上方、折叠后无法展开、Preview 被卸载，或出现横向滚动。
- 证据：展开/折叠截图、关键 bounding box 与 scrollWidth/clientWidth。

### WTC-008 [P0] 选择子 Project 时 Terminal 与 Preview 原子切换到同一 ID

- 前置条件：父根和 `activity` 各有 Terminal，同名文件内容不同，Preview 打开 Files。
- 步骤：在主节点读取 active ID、cwd 与文件；点击 `activity` 后立即读取父 tab、active 行、active Terminal、请求 URL、cwd 和文件内容。
- 期望：父 tab 仍选中同一个父 Project；active Worktree 行和右侧业务请求只使用 `activityChildProjectId`；右侧只显示该 ID 的 Sessions；cwd 位于 `.worktree/activity`；Preview 显示 `activity-context`；迟到响应不能恢复父根内容。
- 失败判定：请求同时传父、子两套 ID，Terminal 与 Preview ID 不同，出现两个 active 行，或旧响应覆盖新内容。
- 证据：点击后 DOM、Session/Preview 网络请求、Terminal 输出和文件内容。

### WTC-009 [P0] 每个父 Project 与生效 Project 独立恢复选择

- 前置条件：两个父 Projects，各有多个 contexts；两个子 Project 各有两个 Terminal 和不同 Preview 文件。
- 步骤：分别选择非首个 context、Terminal 与文件；来回切换父 Project 和 contexts；刷新页面。
- 期望：每个父 Project 恢复上次生效 Project；每个生效 Project 恢复上次 Terminal 与 Preview path；localStorage 使用 `contextProjectIdByParentProjectId` 和以生效 ID 为 key 的 `projectSessionIds`。
- 失败判定：父 Projects 共用子 ID、所有 contexts 共用 Session/Preview，或刷新后只能恢复父 Project。
- 证据：切换序列 DOM、请求 URL 与 localStorage。

### WTC-010 [P0] 新建和继承 Terminal 只保存生效 Project ID

- 前置条件：当前选中 `activity`，已记录 `activityChildProjectId`。
- 步骤：点击 New Terminal；读取 Session list 和 `pwd`；基于该 Session 走 inherit 创建；检查持久化 Session；再对 missing 子 ID 尝试创建。
- 期望：前两个请求和 Session 记录都只有 `projectId=activityChildProjectId`，不存在 `worktreeId/worktreePath`；默认 cwd 是 `.worktree/activity`；missing 请求返回 409 且不创建 Session。
- 失败判定：Session 落到父 ID、继承丢失子 ID、增加双身份字段、cwd 落到父根或 missing 请求成功。
- 证据：POST payload、Session API、LowDB 记录、两次 `pwd` 与错误响应。

### WTC-011 [P0] Preview 全部读写通过 URL 中的子 Project ID 隔离

- 前置条件：父根与 `activity` 有同名文件和不同 Git 变更。
- 步骤：在两个 contexts 依次执行 search/read/save/directory/changes/diff；在 `activity` 保存 `context.txt`；切回父根。
- 期望：子 Project 请求路径为 `/api/terminal/project/:activityChildProjectId/preview/*`，无 `worktreeId` query；搜索、目录、Changes、Diff 只返回当前根；保存只改变子文件；父根 Explorer 不显示 `.worktree` 容器。
- 失败判定：任一请求仍传第二套 Worktree 参数、使用父 path、缓存串内容或修改另一根文件。
- 证据：网络请求、两个磁盘文件 hash 与 Preview DOM。

### WTC-012 [P0] 外部移除有存活 Terminal 的子 Project 时保留安全入口

- 前置条件：`preview-fix` 有运行中 Terminal，当前选中该节点。
- 步骤：从页面外强制移除 Git Worktree；等待刷新；访问已有 Terminal；尝试新建 Terminal、Preview、Agent Team 和 Prototype；关闭最后一个 Terminal。
- 期望：节点转为 `missing`，已有 Terminal 可访问；所有需要目录的新操作返回 409 且不回退父 path/cwd；最后一个 Terminal 关闭后节点消失并回到主节点。
- 失败判定：Terminal 丢入口、任一目录操作成功、请求写到父根，或空 missing 节点长期残留。
- 证据：移除前后 contexts JSON/DOM、四类错误响应、Terminal 连接结果与父根 hash。

### WTC-013 [P1] 旧存储和旧客户端继续使用父 Project 主节点

- 前置条件：准备不含 `pinnedChildProjectIds` 的旧 LowDB fixture；所有旧 Session 只有父 `projectId`；使用现有旧 Session/Preview payload。
- 步骤：启动 backend，打开 Terminal，读取 Projects/contexts/Sessions；调用父 ID 的 Preview API。
- 期望：backend 正常启动；旧 Project 仍只出现在顶部父列表；旧 Session 出现在主节点；父 ID Preview 正常；不要求离线迁移或新增字段。
- 失败判定：启动失败、旧 Session 消失、父 ID 被重写、旧 Preview 变成 4xx，或 Project 列表混入子项。
- 证据：启动日志、LowDB 前后内容与三类 API JSON。

### WTC-014 [P0] 伪造子 Project ID 不能跨父 Project 或跨目录访问

- 前置条件：父 Project A/B 各有子 Project；已登录普通用户。
- 步骤：在 A 的 pin/Session/Preview 请求中传 B 的子 ID；传非法 base64url、空名称、非规范编码和解码为 `..` 的 ID；构造文件 `../` 与 symlink escape。
- 期望：跨父/非法/随机 ID 返回 404，known missing 返回 409，文件路径逃逸返回现有 400/403；A/B 文件均未改变，响应不泄漏无关目录内容。
- 失败判定：请求成功、解析后直接拼路径、退回父根执行、跨 Project 改文件或响应泄漏目录。
- 证据：各等价类状态码/响应体与操作前后文件 hash。

### WTC-015 [P1] 未认证请求不能读取 contexts 或修改固定状态

- 前置条件：清除登录 cookie/token。
- 步骤：调用 contexts list、pin、子 Project Preview 和 Session create。
- 期望：全部返回 401；响应不包含父/子 path、branch 或文件内容；固定状态与文件不变。
- 失败判定：任一接口匿名可读/可写或泄漏路径。
- 证据：请求状态码、响应体与重新登录后的状态。

### WTC-016 [P0] Agent Team 在子 Project 解析计划并写入同一 Worktree

- 前置条件：选中 `activity` Terminal；父根和子根有同名但不同内容的计划文件。
- 步骤：从该 Terminal 发起 Agent Team，解析计划/用例并写入 run/outbox；读取 run 元数据与 worker cwd。
- 期望：请求和 run 只有 `projectId=activityChildProjectId`；计划解析、`.runweave/agent-team`、pane outbox 和 worker cwd 都位于 `.worktree/activity`；父根同名文件不变。
- 失败判定：新增 Worktree 字段、读取父计划、产物落父根或 worker cwd 越界。
- 证据：run JSON、worker cwd、产物路径和父/子目录 diff。

### WTC-017 [P1] 父 Project 切换恢复各自 context 且 App 不渲染 rail

- 前置条件：两个父 Projects各选中过子 Project；准备 App Home 入口。
- 步骤：desktop 来回切换父 Project 并刷新；再打开 App Home/Terminal。
- 期望：desktop 恢复各自 context/Terminal；App 不渲染 Worktree rail，但子 Project Session 能在父 Project 组内显示并正常打开。
- 失败判定：两个父 Projects 共用 context、切换后串 Session，App 丢失子 Session、出现 rail 或空白页。
- 证据：desktop DOM/localStorage、App DOM 与打开后的 Session `projectId`。

### WTC-018 [P0] backend 重启后仍能枚举和恢复子 Project Agent Team run

- 前置条件：`activity` 中存在 running/need_human Agent Team run 与对应 Session。
- 步骤：记录 run ID，重启 backend；调用 Work History、Agent Team get/list，并等待 recheck watchdog 读取该 run。
- 期望：run 能按原子 Project ID 被找到，Work History 名称正确，watchdog 不因只遍历父 Projects 而遗漏；不在父根生成重复 run。
- 失败判定：getRun 返回 404、列表缺失、watchdog 永久不处理，或父根出现重复产物。
- 证据：重启日志、run/list/history JSON、watchdog 日志与两侧目录。

### WTC-019 [P0] 删除父 Project 级联停止并删除全部子 Project Sessions

- 前置条件：临时父 Project 的主节点与两个子 Projects 均有运行中 Terminal/Panel；不使用用户真实 Project。
- 步骤：从顶部 Project 管理入口确认删除父 Project；读取 runtime/tmux、Sessions、Panels、Project 事件和 Preview cache 状态。
- 期望：父、子全部 runtime 被停止，Sessions/Panels 被删除；`project_deleted.terminalSessionIds` 包含全部 ID；父 tab 和 contexts 消失；没有孤儿 tmux 或可访问 Preview cache。
- 失败判定：只删除父 ID Sessions、留下任一 runtime/Panel/tmux、删除事件漏 ID，或子 ID 仍可操作。
- 证据：删除前后 API、事件 payload、tmux/runtime 查询与文件存储。

### WTC-020 [P1] 顶部状态和 App Home 按父 Project 聚合但保留子 ID

- 前置条件：父主节点 idle，`activity` 子 Session 为 agent_running 或有 completion/bell。
- 步骤：读取 desktop 顶部父 tab 状态；打开 App Home 并选择该子 Session。
- 期望：父 tab 显示子 Session 状态；App Home 在父 Project 组内计数并显示该 Session；打开后请求仍使用 `activityChildProjectId`，不改写为父 ID。
- 失败判定：父 tab 无状态、App Home 丢 Session/重复分组，或打开后切回父根。
- 证据：desktop/App DOM、overview JSON 与打开请求。

### WTC-021 [P1] Activity 与 Quick Input 在父、子 Project 间保持精确隔离

- 前置条件：父根与 `activity` 各产生可区分 Activity fact 和 Project-scoped Quick Input，另有一个 global Quick Input。
- 步骤：分别以父 ID 与子 ID 查询 Activity、导出范围、打开 Quick Input；在测试 fixture 中删除子 scope Activity。
- 期望：父查询只返回父数据，子查询只返回子数据；global Quick Input 两侧可见，Project-scoped 项不串；删除子 scope 不影响父数据。
- 失败判定：父级隐式汇总子数据、Quick Input 串 scope，或删除扩散到父 ID。
- 证据：Activity API/导出、Quick Input JSON/DOM 与删除前后计数。

### WTC-022 [P1] Prototype Gallery 和 preview ticket 使用子 Project 根目录

- 前置条件：父根与 `activity` 的 `docs/prototypes` 有同 slug 不同内容原型。
- 步骤：从 `activity` 打开 Prototype Gallery，选择该原型并申请 preview ticket。
- 期望：Gallery 包含子 Project context；选择和 ticket 的 `projectId` 为 `activityChildProjectId`；preview 内容来自 `.worktree/activity`，父原型不被替代。
- 失败判定：Gallery 只枚举父 Projects、ticket 改用父 ID、预览父根内容或跨目录读取。
- 证据：Gallery JSON/DOM、ticket payload、preview URL 与页面内容。

## 覆盖检查

| 维度        | 覆盖                                                                          |
| ----------- | ----------------------------------------------------------------------------- |
| 主路径      | WTC-001 至 011、016、017、020、022                                            |
| 等价类/边界 | WTC-003、010、013、014                                                        |
| 状态迁移    | WTC-004、005、009、012、018、019                                              |
| 异步/迟到   | WTC-004、008、009、012                                                        |
| 并发        | 不覆盖多用户并发；pin 重复请求以最后成功响应为准，纳入 WTC-005 的重复请求变体 |
| 权限与越权  | WTC-014、015                                                                  |
| 幂等与去重  | WTC-003、004、005、018                                                        |
| 恢复与回归  | WTC-013、017、018、020                                                        |
| 数据与协议  | WTC-010、011、016、018、019、021、022                                         |

## 验收通过标准

- 必跑命令全部为 0 exit code。
- 所有 P0 用例通过并有可复核证据；P1 无阻断性失败，未执行项逐条记录原因。
- 页面 console 无新增 error/warning，contexts 轮询无无限重试或重复节点。
- 任一请求出现父、子双业务 ID，任一 Preview/Agent Team 跨根读写，主节点可取消固定，运行中 Terminal 丢入口，或父删除遗留子 runtime，均直接判定整体验收失败。
