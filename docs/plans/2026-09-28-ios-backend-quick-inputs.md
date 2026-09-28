# iPhone 快捷回复统一 Backend 数据与后台运行实施计划

日期：2026-09-28。状态：功能代码已实现，required 用例尚未全部验收；最终模拟器重装受本机 iOS 运行时缺失阻塞。本计划承接[手机交互原型](../prototypes/ios-background-quick-input/README.md)和[既有快捷指令后台运行验收合同](../testing/background-commands/core.testplan.yaml)；原型不是运行证据。

## 目标和边界

在原生 iOS 的现有「快捷回复」列表和输入区快捷条中，统一显示**当前已登录 Backend 的全局已保存（`projectId:null`、pinned）快捷指令**。点行仍只把原文插入当前终端草稿；搜索、新增、编辑正文、删除、排序和前三条快捷入口保持原有操作方式。符合条件的已保存 `$toolkit:github-pr` 条目在同一行提供「后台运行」，点后用当前终端所属的实际项目/worktree 启动现有 ScheduledRun；「查看运行」进入已有运行详情。离开列表或 App 不取消运行。

不在手机另建后台任务、执行队列、日志或配置表单；不开放其他技能和 `$toolkit:update-runweave-desktop`；不显示项目绑定的快捷指令或 Backend 自动记录的 recent 输入；不做离线写入、待发送队列或跨 Backend 同步。Web 的现有列表和最近使用排序保持原状。手机只为全局已保存条目提供手动排序视图。

## 必须保留的语义

1. **一个可见数据源。** 当前连接的 Backend 是列表、搜索、快捷条及管理操作的唯一权威源。手机不把 `LocalQuickReplyStore` 当在线/离线回退列表。没有连接、未登录、旧 Backend 或离线时显示明确原因和重试/登录入口，不把旧本机数据伪装为已同步记录。管理页没有终端时仍可管理该连接的已保存条目，但不能启动后台运行。
2. **一台电脑一份全局列表。** 手机显式查询该 Backend `projectId:null` 的 pinned 项；省略 `projectId` 在现有接口中意味着“所有作用域”，不能用来表达“全局”。连接管理页与同一 Backend 的任一终端看到相同集合及手动顺序，项目绑定项一律不进入手机列表、搜索、快捷条或管理操作。新增手机回复固定 `projectId:null`、`mode:"line"`，对该 Backend 的全部项目可见。切换电脑立即丢弃旧请求结果和内存列表；不同 Backend 的条目与运行绝不混合。
3. **填入与执行分离。** 点整行、前三条快捷按钮只在光标/选区插入完整 `data`，保留草稿及附件，不发送到终端，也不启动任务；继续沿用当前 `suppressQuickInputHistory` 标记。成功插入后按现有 Backend 合同调用 `markUsed` 并采用返回的新 `updatedAt`；统计失败不撤销已插入的草稿，后续启动前重新读取条目版本。仅明确点「后台运行」才调用 run API，原终端和草稿不变。后台操作和填入操作有独立可访问标签。
4. **运行资格与配置由 Backend 决定。** 手机只对全局 pinned 项中 `mode` 为 `line`/`prompt_paste` 且正文以 `$toolkit:github-pr` 开始的条目显示入口；Backend 继续负责技能、模型、执行权限、cwd、版本和项目校验。全局模板不指定执行目录；请求仍传当前终端的**实际** `projectId`、条目 `updatedAt` 和稳定的 `Idempotency-Key`，以该项目/worktree 确定执行位置。模型未配置、技能不可用、权限不足、目录失效或模板已变化时显示具体错误；不自动提高权限、改用其他模型或静默重试另一把 key。后台默认模型仍通过现有电脑配置设置，手机给出该操作提示。
5. **状态来自持久运行。** 成功响应记住 `taskId/runId`；活动条目显示排队中/运行中和「查看运行」，重开 App/列表时按当前连接及实际项目从既有快捷来源运行查询恢复，不能只靠视图内存。结果页复用 `ScheduledRunView` 的摘要、输出、停止、恢复原对话；模板删除后历史仍按 runId 可读。未知响应先用原 key 查询/重试，不产生第二次执行。

## Backend 与跨端合同

现状：`GET /api/terminal/quick-inputs` 单次最多 100 条，pinned 默认按最近使用排序；`PATCH` 只改标题/固定状态，`POST` 遇相同正文会改写既有标题，均不能直接承接手机的最多 500 条本机库和手动排序。

- 在 `packages/shared/src/terminal/runtime/input.ts` 扩展可选合同，Swift 对照放在 `packages/app-ios/Sources/RunweaveIOS/Contracts/TerminalQuickInput.swift`。`TerminalQuickInputItem` 增加可选 `manualOrder` 和 `clientImportId`；`source` 增加 `ios_quick_reply`。旧记录缺字段时按 `createdAt,id` 确定初始手动顺序。原有消费者读可选字段保持兼容。
- `GET /api/terminal/quick-inputs?kind=pinned&scope=global&order=manual&limit=100&cursor=…&q=…` 返回 `{items,nextCursor,orderVersion}`；`scope=global` 严格筛选规范化后 `projectId:null` 的项，与 `projectId` 查询参数互斥，不能省略作用域后在手机过滤。全局列表、搜索均可翻页，游标绑定查询与列表快照，列表中途变化返回 409 `list_changed`，手机从第一页重新读取并按 ID 去重。`orderVersion` 仅由全局 pinned 集合和手动顺序计算，`markUsed` 不使排序冲突。未传 `scope/order` 的旧 Web 请求维持原响应和最近使用排序；手机要求 `orderVersion`，缺失视为旧 Backend，不写入。
- `POST /api/terminal/quick-inputs` 保留原请求语义；可选 `source:"ios_quick_reply"`。可选 `clientImportId` 只用于明确导入的本机 UUID：Backend 在现有串行写队列内先按该 ID 查找并返回原结果，首次导入另建 pinned 项而不按正文去重、不覆盖同文现有标题；已软删除的导入项也不因重试复活。普通 Web 创建及去重行为不变。Backend 继续验证非空、64 KiB 和敏感内容。
- `PATCH /api/terminal/quick-inputs/:id` 增加可选 `data`、`mode`、`expectedUpdatedAt`。手机编辑标题/正文均带 `expectedUpdatedAt`；不匹配返回 409 `input_changed` 并让用户保留编辑稿、刷新后决定是否再保存，不覆盖别端修改。正文校验与创建一致。旧 Web 仅改标题/固定状态的请求继续有效。
- `POST /api/terminal/quick-inputs/:id/move` 接受 `{beforeId:string|null,expectedOrderVersion:string}`，`null` 表示移到末尾；仅操作当前 Backend 的全局 pinned 项，源项或目标项若绑定项目则拒绝，校验版本后串行提交并返回新 `orderVersion`。服务端只更新全局项的手动顺序，不改项目绑定项或最近使用时间；409 时手机刷新并提示重新排序。搜索期间禁用拖动，与现有 iOS 一致。
- 上述路由沿用 `/api/terminal` 鉴权及 `TerminalQuickInputService` 的写队列/持久存储；401/403 不返回内容，404 表示条目不存在，409 表示列表/条目版本变化，400 表示输入不合法。新字段和状态码只对新调用生效。Backend 升级先于手机发布；旧手机忽略新增合同。

## 旧手机数据：明确导入，原文件保留

`LocalQuickReplyStore` 的归档在 `Application Support/native-quick-replies/replies.json`，最多 500 条，原本与电脑连接无关。自动上传会把原本只在设备上的文字发送到当前电脑，因此**首次升级不自动导入**。新界面始终显示 Backend 列表；若检测到旧归档，在列表顶部仅显示一次性「此手机有 N 条旧快捷回复，导入到当前电脑」提示，先展示当前连接名/地址、上传条数与“导入后该电脑可读取”的说明，用户确认后才上传。拒绝或暂缓时旧文件原样保留，但不作为第二套可见快捷回复。

按原数组顺序逐条导入为全局 `line` pinned 项，使用旧 UUID 作为 `clientImportId`。成功项记录在**当前连接 scope** 的本机迁移进度中：单独的原子写入、设备保护归档只保存连接 scope 和成功 UUID，不复制正文；即使进度写入失败，后端的 ID 幂等也能安全重试。响应丢失时用同一 ID 重试，后端返回原项，不重复创建或改写既有条目。敏感内容/超长/断网等单项失败保留在原文件，显示失败条数与具体原因；迁移详情提供只读全文复制/导出，用户可自行修订后按 Backend 规则新建，但不能绕过敏感内容校验或宣称失败项已导入。可重试的网络失败沿用原 ID；不能标记整批完成、不能自动删除原文件。归档损坏或版本未知时保留原字节并提示恢复，不用空库覆盖。导入成功后原文件仍只读保留供回滚/导出；新建和后续编辑全部写 Backend，绝不同步回本机。连接 A 导入成功不等于连接 B 已导入；用户要导入 B 必须再次确认。

## 文件范围与实施顺序

1. [ ] **补 Backend 合同与持久顺序。** 修改 `packages/shared/src/terminal/runtime/input.ts`、`backend/src/terminal/quick-input/{service,store,lowdb-store}.ts`、`backend/src/routes/terminal/input/quick.ts`：实现分页/搜索快照、手动排序、正文乐观编辑和幂等导入。同步检查 `frontend/src/services/terminal/quick-inputs.ts` 及真实消费者，旧 Web 默认合同不变。验证：`pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/backend lint`、`pnpm architecture:check`；用鉴权 HTTP 客户端核对 101 条分页、同 ID 导入重试、正文冲突、排序冲突和旧请求响应。
2. [ ] **把原生列表和快捷条切到连接级模型。** 新增 `Contracts/TerminalQuickInput.swift`、`State/BackendQuickInputModel.swift`，扩展 `Services/APIClient.swift`；修改 `App/RootView.swift`、`Features/Connections/ConnectionManager.swift`、`Features/Terminal/Input/{TerminalComposerPresentation,ComposerView,QuickReplyLibraryView,QuickReplyEditorView}.swift`。列表显式读取完整 `scope=global&kind=pinned` 分页，搜索同样限定全局；前三条按手动顺序；新增固定全局，编辑/删除/移动只作用于列表内全局 ID，均等服务器确认后更新；失败保留用户输入。连接 generation、终端 ID 和 controller 身份同时保护异步结果。验证：iOS 模拟器构建；用 `$toolkit:agent-device` 核对同一 Backend 跨项目列表不变、项目绑定项不可见、切换 A/B 与离线状态，不能用构建通过替代 UI 验收。
3. [ ] **接入本机归档的只读导入桥。** 保留 `State/LocalQuickReplyStore.swift` 的读取、校验和原文件，不再注入为列表数据源；新增 `State/QuickReplyMigrationStore.swift` 保存按连接的无正文迁移进度和确认 UI。`ConnectionManager` 无连接时显示登录/选择电脑指引，不提供离线编辑；含旧数据时可在连接就绪后进入导入提示。验证：同 Bundle ID 覆盖安装、500 条归档、部分失败、断线重试、损坏归档、A/B 分别导入，核对原文件哈希未变化。
4. [ ] **把后台运行接到原行。** iOS `APIClient` 增加带幂等键的 run 请求与快捷来源运行查询；`BackendQuickInputModel` 维护 `quickInputId + actualProjectId` 的运行映射，`QuickReplyLibraryView` 加「后台运行 / 查看运行」，用 `ScheduledTasksService`、`ScheduledTasksModel` 和 `RootView` 的现有 taskId/runId 导航进入 `ScheduledRunView`。刷新时从 Backend 恢复状态；切换连接清理旧映射。验证：隔离项目实际运行同一 runId 从 queued 到终态，原终端没有输入；关闭列表/重启 App 后仍能进入同一运行，历史输出与恢复路径正确。
5. [ ] **更新长期文档与旧用例归属。** 实现同一改动更新 `docs/architecture/terminal-code-preview.md`、`packages/app-ios/docs/` 的快捷回复说明；现有 `docs/testing/app/ios-native-local-quick-replies.testplan.yaml` 中“纯本地/离线编辑/跨电脑同库”不再作为新版门禁，实施时将其归档或删除，并以[新验收计划](../testing/app/ios-backend-quick-inputs.testplan.yaml)执行。原型保留为历史设计图，不把图中的模拟日志作为运行证据。

## 验收门槛与回滚

2026-09-29 实施取证：共享包、Backend、Frontend 类型检查、Backend lint、架构与文档检查、
新旧 YAML 计划校验、iOS 模拟器构建安装均通过；隔离 Backend 的鉴权 HTTP 核对了 101 条分页、
导入重试、编辑与排序冲突，以及旧列表合同。模拟器界面核对了全局筛选与搜索、第 101 条搜索、
新增/编辑/删除/排序、前三条草稿填入、模型缺失提示和显式旧记录导入；旧归档前后 SHA-256 一致。
真实模型运行、跨电脑迟到响应、旧 Backend 与设备断线、500 条及部分失败导入、后台运行重启恢复
仍需逐条取证，不以本次模拟器构建或模拟器局部操作宣称全部通过。

执行[手机 Backend 快捷回复验收计划](../testing/app/ios-backend-quick-inputs.testplan.yaml)的 required 用例，并引用[后台运行既有验收计划](../testing/background-commands/core.testplan.yaml)中项目归属、幂等、结果/恢复、通知及鉴权用例。iOS 行为用 `$toolkit:agent-device` 取证；构建命令在 `packages/app-ios/` 执行 `node scripts/ios.mjs doctor`、`node scripts/ios.mjs build --simulator <已申请的 UDID>`。Backend 更改完成后再执行 `pnpm backend:verify-lifecycle` 和 `pnpm scheduled-tasks:verify-runtime`。每项需区分静态检查、构建、实际 HTTP、原生 UI 和真实后台任务结果；任一 required 用例未取证不能宣称端到端通过。

发布按 Backend → iOS 顺序；新 App 遇旧 Backend 明确要求更新，不降级到本机库。回滚 App 时旧归档仍在，旧版只能看到升级前的本机快照，**无法看到新版本写入 Backend 的内容**；因此回滚前需从 Backend 导出新记录或继续使用新版本，不删除任何一端数据。服务端旧版本读取新增可选字段应忽略；若要回滚 Backend，先停止新客户端写入并备份快捷库，再核对旧版解码与列表表现。
