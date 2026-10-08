# 定时任务 Web 接入

入口是终端工作区顶部与“随记”并列的“定时任务”，路由为
`/scheduled-tasks/:taskId?`，来源回跳使用 `?run=:runId`。

快捷指令面板以当前连接电脑为全局范围：指令读取全局固定列表并按手动顺序展示；
后台任务读取所有项目，优先展示未归档的需处理任务和进行中任务，首页最多 3 条。
「全部」列表单独展示历史记录；已结束的快捷运行可移至历史，原结果与输出保留。
指令的发送与后台执行仍使用当前终端的项目和工作区，面板明确显示当前执行位置。

快捷入口通过独立弹窗展示运行详情；`/background-runs/:runId` 独立页面复用同一详情，
展示输出、结果、停止和继续对话入口，没有可恢复对话时可在原执行位置新建终端。
页面返回时恢复原工作区。通知和终端来源链接
按运行的 `snapshot.origin.kind` 选择详情页面。旧的定时任务运行链接若指向
`quick-input` 来源，也会跳转到后台运行详情；普通定时任务继续使用原任务页。

## 当前交付边界

Web、共享 DTO 与 Backend 已接通 `/api/scheduled-tasks`。Backend 使用独立 SQLite
保存任务、运行快照、幂等记录与输出；调度不依赖页面存活。Codex 支持真实后台执行、停止、
重启后不重放不确定运行，以及将持久 thread 按需恢复到一个普通终端。TraeX 和 Pi 在各自
通过同等持久执行与恢复门禁前保持不可用。
快捷指令可将任何已保存内容提交给后台 Codex，不按命令前缀或输入模式过滤；同一条指令在同一项目中
已有未结束运行时返回现有运行 ID。入队只表示已接受，具体命令仍须以运行结果判断是否完成。
快捷指令后台运行的执行权限默认是 `full-access`，无需额外配置权限；如已显式保存其他
`scheduledTasks.quickInputDefaults.executionPolicy`，则遵循该配置。后台模型仍须显式选择。
桌面自更新会重启承载后台任务的 Backend；当前更新器会阻止活跃任务期间重启，因此仅开放快捷入口
不能使自更新在后台完成，需要独立于 Backend 生命周期的执行者和结果回写。
当前 Codex 后台适配器使用 `codex exec --json`，尚不支持结构化权限等待与人工接管，
可按本机 CLI 能力提供自动审批或完全访问，但都不提供运行中的人工审批通道。执行失败时保留已知 thread，不通过匹配回复文本伪造 `waiting`。
该能力缺口独立于后台执行与普通终端恢复，不得把后者的成功计作权限接管验收通过。

真实验收使用隔离 Dev Session、真实 provider 与 Playwright CLI，入口见下方测试计划。
静态检查、格式校验和历史通过记录都不能替代受影响行为的浏览器回归。

[历史交互原型](../../docs/prototypes/agent-scheduled-tasks/README.md)仅用于视觉与交互参考。
生产代码不读取原型的假数据、LocalStorage 任务或模拟回复。

## 错过执行时间

新建任务默认「恢复后补最近一次」，允许延迟 24 小时，可配置 1 至 168 小时整数。
旧任务在数据库升级时写入「错过就跳过」（60 秒宽限），历史配置快照同步迁移。
创建请求必须明确提供 `misfirePolicy`；PATCH 省略字段表示不修改。策略进入每次运行的配置快照。
数据库先迁移至当前格式再启动调度，详见 [存储升级规则](../../backend/src/scheduled-tasks/storage/README.md)。

补跑仅选取最近且未超过有效期的安排，更早安排合并忽略；不批量回放积压。
有效期约束调度入队，入队后的正常排队不再次过期。同任务已有未结束运行时仍跳过为 busy。
全局默认同时执行 4 个后台任务，可通过 `scheduledTasks.maxConcurrentRuns` 配置；已开始后中断的运行
不自动重发提示词。暂停后重新启用不追溯暂停期间。

历史分别展示计划时间、实际开始时间、调度延迟与排队等待；旧 missed 记录显示中性的超期原因，
不根据迟到推断宕机。电脑休眠期间不会执行，准点执行需要持续在线的 Backend。
补跑验收见 [补跑测试计划](../../docs/testing/scheduled-tasks/catch-up.testplan.yaml)。

## 接入边界

- [服务层](../src/services/scheduled-tasks.ts)只使用既有鉴权 HTTP 客户端。
  DTO 的唯一类型来源是 [shared/scheduled-tasks](../../packages/shared/src/scheduled-tasks/index.ts)。
  Backend 接入时需共同校验字段、分页包装和错误 code，不能在 Web 再复制一份接口模型。
- Query key 带连接 scope，页面切换连接重新挂载并取消旧查询；异步打开、保存完成后
  只有仍挂载的页面可以导航。来源与任务 ID 只在当前连接解析。
- 列表、详情和进度仅在可见且在线时每 3 秒刷新；来源标签只按需读取。
  运行输出接口必须返回消费位置 `nextCursor`（EOF 也返回），输出非空时游标必须前进。
  Web 展示缓存最多保留 256 KiB 文本，完整历史由 Backend 持有。
- 表单使用服务器 preview，不计算下一次调度。一次性时间显式输入 UTC，并按所选 IANA
  时区预览。创建和立即运行重试复用幂等键；修改与删除带 `expectedRevision`。
  冲突保留原草稿，不擅自用新 revision 覆盖他人配置。
- 项目选择包含父项目与规范 Worktree 子项目。返回时通过连接隔离的一次性导航选择
  恢复父项目、实际项目、session 和 panel；不向 Backend 发送停止或删除。
- 运行中只查看只读输出。可打开性由 Backend 的 `recoverable` 和真实 thread 决定；
  打开接口返回普通终端标识；Web 等待 Backend attachment 明确 ready 后，经现有路由进入终端，
  不将 command_submitted 当作恢复成功。恢复失败/超时留在记录页供重试；后台受阻任务可直接在详情回复，无需先恢复终端。
  原执行目录或 thread 历史缺失时拒绝恢复；ready 要求本次恢复的 thread 与 cwd 证据。
  恢复命令显式传入该次运行快照的模型、推理强度和执行权限，不读取任务的新配置，也不继承
  本机全局权限覆盖。模型与推理强度通过本次 Codex 设置事件确认后才标记 ready。
  恢复失败后复用绑定重试；终端当前或最近对话已变化时，须显式另开，保留原对话和草稿。
  `source` 持久化并序列化，提供精确到运行记录的轻量回跳。
- 运行摘要渲染经过净化的 Markdown，禁用原始 HTML；仅 http/https 链接可在新窗口打开。
  不加载摘要中的图片或脚本。受控文件引用没有下载 URL 时只展示标签，不拼接本地路径。

## 执行权限与结果

- 任务的 `executionPolicy` 随配置版本保存，并冻结到每次运行快照。未配置的旧任务继续使用
  `sandbox`：工作区普通文件可写，Git 元数据与命令联网受限，不能申请提权。
- `auto-review` 保留 Codex workspace-write 沙箱，由 Codex 自动审查需要额外权限的操作；
  不是无限制执行。Backend 从本机 `codex exec --help` 检测可用性，旧 CLI 不支持时拒绝该模式。
  参考 [Codex 自动审批](https://learn.chatgpt.com/docs/agent-approvals-security)。
- `full-access` 使用 `danger-full-access` 且不等待交互审批，不设置 workspace-write 命令禁网；
  可联网并操作 Browser、共享模拟器和本机文件，只适用于可信任务与提示词。Backend 仅在本机
  `codex exec --help` 同时支持结构化结果与该沙箱模式时发布能力，不支持时明确拒绝而不降级。
  所有模式都不修改用户全局 Codex 配置。
- 权限只有上述单一档位。Browser、模拟器、Git 或其它工具是否执行由任务提示词、仓库规则和已安装
  Skill 决定，不存在独立能力开关，Backend 也不解析提示词来预先申请资源。
- Codex 使用 JSON Schema 返回 `outcome`、`summary`、`reason` 和可空的 `recovery`。只有完整退出并返回有效的
  `succeeded` 才记录 completed；blocked / failed 按下方自动继续策略进入 waiting 或 failed，保留具体原因。
  缺失或非法结果不能降级为成功。结果是 Agent 对业务执行的报告，不是独立验收证明。
- 旧 completed 记录没有业务结果，界面显示“运行已结束”并提示检查摘要，不反向猜测历史状态。
  受阻记录仍可恢复对话，修正配置后需新建一次运行，旧快照不变。
- 后台运行有独立 run ID 和冻结的 project ID；合法的本机 Browser endpoint 会改写为
  `browser-group-scheduled-<runId>` 的独立 scope。运行仍移除继承的 Terminal、tmux、Codex 会话身份，
  Browser group 不构成终端身份，也不用于伪造终端通知。
  依赖交互式终端身份的通知脚本需要单独适配，通知失败须如实反映在结果中。
- 提示词要求 Browser 或 iOS UI 时必须分别按 `toolkit:playwright-cli` 或 `toolkit:agent-device` 完成真实
  操作和证据核对；Browser、模拟器池、登录或系统权限不可用时报告 blocked，不用代码阅读、构建或
  HTTP 探测冒充 UI 成功。模拟器 lease 由任务按共享池 Skill 申请和释放，Backend 不代为持有。
- 点击立即运行成功后进入本次记录，直接查看进度、错误和权限快照。

## 后台自动继续

新建任务的 Web/iOS 表单在 provider 支持原对话恢复时默认开启「自动继续」；旧任务缺省关闭。
策略 `continuationPolicy.mode` 随运行快照冻结，改任务配置不改变已开始的运行。
新快捷运行默认 `bounded`，可通过 `scheduledTasks.quickInputDefaults.continuationMode` 改为 `off`。
Backend 额外探测 `codex exec resume` 能力；不可用时明确拒绝，不能改成新对话重跑。

自动继续只接受完整业务结果中的结构化建议：`continue/remaining-work` 立即推进剩余步骤，
`wait/transient` 或 `wait/external-wait` 等待后推进。需要真实用户输入、权限或未知原因时结束并保留人工入口；
进程超时、异常退出和结果缺失不自动重放。模型建议不能改变权限或替代用户授权。

每次运行最多自动续接 3 次，等待依次为 1、5、15 分钟，恢复窗口为首次可恢复结果后的 60 分钟；
相同剩余工作建议反复出现时也使用退避。执行时长和输出大小累计共用首次领取时的额度。
等待释放全局执行槽，但同任务仍视为未结束；重启只恢复已经持久化的待续接，无法确认的在途执行保留 interrupted/owner_unresolved。

每轮沿用同一 run ID、thread ID、原目录和模型/权限快照。SQLite 原子领取并记录独立 attempt、
开始/结束时间、输出游标、摘要和结果。详情提供「每轮进展」「立即继续」「停止自动继续」；
立即继续只提前已有等待，不增加次数，不复活历史失败，服务明确指定的最早恢复时间仍生效。
接口为 `POST /runs/:runId/continue`，要求 `expectedRevision` 与 `Idempotency-Key`。
带 `reply` 时表示真实用户回复：允许未归档、未被终端接管且有原会话的 failed/cancelled 运行重入队列，沿用 run/thread、执行权限及累计预算；用户回复不消耗自动续接次数，也不重置其上限或恢复窗口。回复和自动提示分开构造，回复保存在对应 attempt，重复请求不重复执行，旧 revision 或同 key 不同回复拒绝。
`needs-input` 明确显示等待回复原因，详情提供直接回复框。Agent 可在 recovery.confirmation 中返回具体待确认事项；Web/iOS 展示完整事项后提供“允许并继续”，发送该事项的明确确认，不能仅发送泛泛的“继续”，也不能自动把等待变成授权。已被用户明确回答的问题不重复询问，开放性问题仍需要具体回答。其他可恢复的失败提供主动“重试”；无法安全自动重试、额度耗尽和终端接管均显示原因。
停止与领取串行；等待时接管到终端先持久取消自动继续。已有终端绑定不自动拉回后台。

等待期间不发送终态通知；最终结果按 run ID、resultRevision 和订阅去重。
本阶段不支持在详情回答问题，也不把终端中的任意后续回答回写为任务结果。
验收合同见 [续接计划](../../docs/testing/scheduled-tasks/continuation.testplan.yaml)，其中人工回答与终端结果归因属于后续阶段。

## 验证

静态检查：根计划中的 shared/frontend typecheck、frontend lint、architecture:check、
docs:check，以及 [Web YAML](../../docs/testing/scheduled-tasks/web.testplan.yaml) 格式校验。

真实验收先执行 `pnpm scheduled-tasks:verify-runtime` 和
[Backend 运行合同](../../docs/testing/scheduled-tasks/runtime.testplan.yaml)，再在隔离 Dev Session
用 Playwright CLI 执行 Web YAML。API 404 的降级检查只证明旧 Backend 兼容提示，不替代
任务管理、调度、恢复或跨连接验收。
