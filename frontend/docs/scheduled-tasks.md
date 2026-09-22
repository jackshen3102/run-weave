# 定时任务 Web 接入

入口是终端工作区顶部与“随记”并列的“定时任务”，路由为
`/scheduled-tasks/:taskId?`，来源回跳使用 `?run=:runId`。

## 当前交付边界

Web、共享 DTO 与 Backend 已接通 `/api/scheduled-tasks`。Backend 使用独立 SQLite
保存任务、运行快照、幂等记录与输出；调度不依赖页面存活。Codex 支持真实后台执行、停止、
重启后不重放不确定运行，以及将持久 thread 按需恢复到一个普通终端。TraeX 和 Pi 在各自
通过同等持久执行与恢复门禁前保持不可用。
当前 Codex 后台适配器使用 `codex exec --json`，尚不支持结构化权限等待与人工接管，
也没有自动批准通道。执行失败时保留已知 thread，不通过匹配回复文本伪造 `waiting`。
该能力缺口独立于后台执行与普通终端恢复，不得把后者的成功计作权限接管验收通过。

真实验收使用隔离 Dev Session、真实 provider 与 Playwright CLI，入口见下方测试计划。
静态检查、格式校验和历史通过记录都不能替代受影响行为的浏览器回归。

[历史交互原型](../../docs/prototypes/agent-scheduled-tasks/README.md)仅用于视觉与交互参考。
生产代码不读取原型的假数据、LocalStorage 任务或模拟回复。

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
  不将 command_submitted 当作恢复成功。恢复失败/超时留在记录页供重试，不创建专用输入区。
  原执行目录或 thread 历史缺失时拒绝恢复；ready 要求本次恢复的 thread 与 cwd 证据。
  恢复失败后复用绑定重试；终端当前或最近对话已变化时，须显式另开，保留原对话和草稿。
  `source` 持久化并序列化，提供精确到运行记录的轻量回跳。
- 运行摘要渲染经过净化的 Markdown，禁用原始 HTML；仅 http/https 链接可在新窗口打开。
  不加载摘要中的图片或脚本。受控文件引用没有下载 URL 时只展示标签，不拼接本地路径。

## 执行权限与结果

- 任务的 `executionPolicy` 随配置版本保存，并冻结到每次运行快照。未配置的旧任务继续使用
  `sandbox`：工作区普通文件可写，Git 元数据与命令联网受限，不能申请提权。
- `auto-review` 保留 Codex workspace-write 沙箱，由 Codex 自动审查需要额外权限的操作；
  不是无限制执行。Backend 从本机 `codex exec --help` 检测可用性，旧 CLI 不支持时拒绝该模式。
  两种模式都不修改全局 Codex 配置。参考 [Codex 自动审批](https://learn.chatgpt.com/docs/agent-approvals-security)。
- Codex 使用 JSON Schema 返回 `outcome`、`summary`、`reason`。只有完整退出并返回有效的
  `succeeded` 才记录 completed；blocked / failed 记录 failed 并保留 Agent 的具体原因。
  缺失或非法结果不能降级为成功。结果是 Agent 对业务执行的报告，不是独立验收证明。
- 旧 completed 记录没有业务结果，界面显示“运行已结束”并提示检查摘要，不反向猜测历史状态。
  受阻记录仍可恢复对话，修正配置后需新建一次运行，旧快照不变。
- 后台运行有独立 run ID，移除继承的 Terminal、tmux、Codex 会话身份；不伪造终端身份完成通知。
  依赖交互式终端身份的通知脚本需要单独适配，通知失败须如实反映在结果中。
- 点击立即运行成功后进入本次记录，直接查看进度、错误和权限快照。

## 验证

静态检查：根计划中的 shared/frontend typecheck、frontend lint、architecture:check、
docs:check，以及 [Web YAML](../../docs/testing/scheduled-tasks/web.testplan.yaml) 格式校验。

真实验收先执行 `pnpm scheduled-tasks:verify-runtime` 和
[Backend 运行合同](../../docs/testing/scheduled-tasks/runtime.testplan.yaml)，再在隔离 Dev Session
用 Playwright CLI 执行 Web YAML。API 404 的降级检查只证明旧 Backend 兼容提示，不替代
任务管理、调度、恢复或跨连接验收。
