# 定时任务 Web 接入

入口是终端工作区顶部与“随记”并列的“定时任务”，路由为
`/scheduled-tasks/:taskId?`，来源回跳使用 `?run=:runId`。

## 当前交付边界

Web 页面、共享 DTO 和 HTTP 消费层已落盘；当前 Backend 尚未实现
`/api/scheduled-tasks`。因此当前连接会显示能力不可用提示，不能创建或运行任务。
真实调度、持久 thread、普通终端精确恢复和跨连接验收尚未通过，不能据此宣称功能已交付。

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
  `source` 仅提供轻量回跳，Backend 仍需持久化和序列化该可选字段。
- Agent 文本作为 React 文本显示。产物仅 http/https URL 可点击；受控文件引用没有
  下载 URL 时只展示标签，不拼接本地路径。

## 验证

静态检查：根计划中的 shared/frontend typecheck、frontend lint、architecture:check、
docs:check，以及 [Web YAML](../../docs/testing/scheduled-tasks/web.testplan.yaml) 格式校验。

真实验收必须先满足 [Backend 运行合同](../../docs/testing/scheduled-tasks/runtime.testplan.yaml)，
再在隔离 Dev Session 用 Playwright CLI 执行 Web YAML。API 404 的降级检查只证明兼容提示，
不替代任务管理、调度、恢复或跨连接验收。
